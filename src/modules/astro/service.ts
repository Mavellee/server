import type { AstroConsentState, AstroStatus, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { ApiError, badRequest, notFound } from "../../lib/http.js";
import { logger } from "../../logger.js";
import { notify } from "../../lib/notify.js";
import { emitToUser } from "../../realtime/bus.js";
import { open, seal, cipherReady } from "./cipher.js";
import { CALCULATION_VERSION, computeChart, NAKSHATRAS, RASHIS, type BirthInput, type ChartData, type TimeAccuracy } from "./engine.js";
import { GUNA_METHOD, gunaMilan } from "./gunaMilan.js";
import { getProvider } from "../ai/provider.js";
import { buildPrompt, interpret, type Interpretation } from "./interpret.js";
import { placeById } from "./places.js";

const MAX_AI_ATTEMPTS = 3;
const STALE_MS = 3 * 60 * 1000;

/** Eligibility: both people's saved intentions include Long-term / Marriage (the MARRIAGE intention), read fresh every time. */
export async function astroEligible(userAId: string, userBId: string) {
  const rows = await prisma.relationshipPreference.findMany({ where: { userId: { in: [userAId, userBId] }, kind: "OWN", intention: "MARRIAGE" }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId)).size === 2 && userAId !== userBId;
}

/** Match-level authorisation: an unknown match and someone else's match look identical. */
async function loadMatch(userId: string, matchId: string) {
  const match = await prisma.match.findFirst({
    where: { id: matchId, status: "ACTIVE", OR: [{ userAId: userId }, { userBId: userId }] },
    include: { conversation: { select: { id: true } }, astroSession: { include: { consents: true, report: true } } },
  });
  if (!match) throw notFound("Match not found.");
  return { match, otherId: match.userAId === userId ? match.userBId : match.userAId };
}

const assertEligible = async (a: string, b: string) => {
  if (!(await astroEligible(a, b))) throw new ApiError(403, "ASTRO_NOT_ELIGIBLE", "Mavelle Astro is only for matches where both people are looking for a long-term relationship or marriage.");
  if (!cipherReady()) throw new ApiError(503, "ASTRO_NOT_CONFIGURED", "Mavelle Astro isn't available right now. Your match and chat aren't affected.");
};

function tell(session: { matchId: string; status: string }, ids: string[]) {
  // Realtime only says "something changed": never birth details, and the database stays the source of truth.
  for (const id of ids) emitToUser(id, "astro:update", { matchId: session.matchId, status: session.status });
}

const derive = (states: AstroConsentState[]): AstroStatus => {
  if (states.includes("DECLINED")) return "DECLINED";
  if (states.includes("WITHDRAWN")) return "WITHDRAWN";
  if (states.length < 2) return "AWAITING_CONSENT";
  return "COLLECTING";
};

async function setConsent(userId: string, matchId: string, otherId: string, state: AstroConsentState, extra: Partial<Prisma.AstroConsentUncheckedCreateInput> = {}) {
  const session = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`astro:${matchId}`}))`;
    const s = await tx.astroSession.upsert({ where: { matchId }, update: {}, create: { matchId } });
    await tx.astroConsent.upsert({ where: { sessionId_userId: { sessionId: s.id, userId } }, update: { state, ...extra }, create: { sessionId: s.id, userId, state, ...extra } });
    const consents = await tx.astroConsent.findMany({ where: { sessionId: s.id } });
    // A repeat of an accepted consent never restarts work that is running or finished.
    const settled = consents.length === 2 && consents.every((c) => c.state === "CONSENTED") && ["CALCULATING", "INTERPRETING", "READY", "PARTIAL"].includes(s.status);
    const status = settled ? s.status : derive(consents.map((c) => c.state));
    return tx.astroSession.update({ where: { id: s.id }, data: { status } });
  });
  tell(session, [userId, otherId]);
  return session;
}

/** Interested in exploring. Asks nothing yet, and tells the other person only that the invitation is open. */
export async function optIn(userId: string, matchId: string) {
  const { match, otherId } = await loadMatch(userId, matchId);
  await assertEligible(userId, otherId);
  const mine = match.astroSession?.consents.find((c) => c.userId === userId);
  if (mine?.state === "CONSENTED") return stateFor(userId, matchId);
  await setConsent(userId, matchId, otherId, "INTERESTED");
  await notify(otherId, "MATCH", "An invitation from Mavelle Astro", "Your match would like to explore your charts together. It's entirely optional, and your chat is open either way.", { matchId, conversationId: match.conversation?.id });
  return stateFor(userId, matchId);
}

export async function decline(userId: string, matchId: string) {
  const { otherId } = await loadMatch(userId, matchId);
  await setConsent(userId, matchId, otherId, "DECLINED");
  return stateFor(userId, matchId);
}

export interface ConsentBody {
  birth?: { date: string; time: string | null; accuracy: TimeAccuracy; placeId: string };
  shareSummary: true;
  externalAi: boolean;
  useInterests: boolean;
}

/** Stores this person's own encrypted birth details and consent. When both have consented, calculation starts. */
export async function giveConsent(userId: string, matchId: string, body: ConsentBody) {
  const { match, otherId } = await loadMatch(userId, matchId);
  await assertEligible(userId, otherId);
  if (body.birth) {
    const { date, time, accuracy, placeId } = body.birth;
    if (!placeById(placeId)) throw badRequest("Choose your birthplace from the list.");
    if (accuracy !== "UNKNOWN" && !time) throw badRequest("Add your birth time, or mark it as unknown.");
    if (new Date(`${date}T00:00:00Z`).getTime() > Date.now()) throw badRequest("Your date of birth can't be in the future.");
    const details = { date, time: accuracy === "UNKNOWN" ? null : time, placeId };
    const existing = await prisma.astroProfile.findUnique({ where: { userId } });
    // Reports were built from the saved details, so changing them means starting over deliberately.
    if (existing && JSON.stringify(open(existing.birthCipher)) !== JSON.stringify(details)) throw new ApiError(409, "ASTRO_DETAILS_SAVED", "You already have birth details saved. Delete your astrology data first to enter different ones.");
    if (!existing) await prisma.astroProfile.create({ data: { userId, birthCipher: seal(details), accuracy } });
  } else if (!(await prisma.astroProfile.findUnique({ where: { userId } }))) throw badRequest("Add your birth details first.");

  // Consent is idempotent: a double submit never restarts work or overwrites what's running.
  if (match.astroSession?.consents.find((c) => c.userId === userId)?.state === "CONSENTED") return stateFor(userId, matchId);

  await setConsent(userId, matchId, otherId, "CONSENTED", { shareSummary: true, externalAi: body.externalAi, useInterests: body.useInterests, consentedAt: new Date(), withdrawnAt: null });
  const consents = await prisma.astroConsent.findMany({ where: { session: { matchId } } });
  if (consents.length === 2 && consents.every((c) => c.state === "CONSENTED")) void startPipeline(matchId);
  return stateFor(userId, matchId);
}

async function chartFor(userId: string): Promise<ChartData> {
  const cached = await prisma.astroChart.findUnique({ where: { userId_version: { userId, version: CALCULATION_VERSION } } });
  if (cached) return cached.data as unknown as ChartData;
  const profile = await prisma.astroProfile.findUniqueOrThrow({ where: { userId } });
  const birth = open<{ date: string; time: string | null; placeId: string }>(profile.birthCipher);
  const place = placeById(birth.placeId);
  if (!place) throw new Error("Unknown birthplace");
  const input: BirthInput = { date: birth.date, time: birth.time, accuracy: profile.accuracy, lat: place.lat, lon: place.lon, tz: place.tz };
  const data = computeChart(input);
  const json = data as unknown as Prisma.InputJsonValue;
  await prisma.astroChart.upsert({ where: { userId_version: { userId, version: CALCULATION_VERSION } }, update: { data: json }, create: { userId, version: CALCULATION_VERSION, data: json } });
  await prisma.astroProfile.update({ where: { userId }, data: { lastUsedAt: new Date() } });
  return data;
}

/** The tradition's tables are written for a bride and a groom, so a score is only given where those roles exist. */
function gunaFor(aGender: string | null, bGender: string | null, a: ChartData, b: ChartData) {
  if (!a.moon?.pada || !b.moon?.pada) return { guna: null, reason: "Guna Milan needs both Moon positions, which depend on the birth details available." };
  const pair = [aGender, bGender];
  if (!(pair.includes("MAN") && pair.includes("WOMAN"))) return { guna: null, reason: "Guna Milan's traditional tables are written for a bride and groom, so we don't calculate a score for this pairing rather than force one." };
  return { guna: aGender === "MAN" ? gunaMilan(a.moon, b.moon) : gunaMilan(b.moon, a.moon), reason: null };
}

/** Claims made purely from the calculated charts; these exist with or without AI. */
const ELEMENTS = ["fire", "earth", "air", "water"];
function sharedThemes(a: ChartData, b: ChartData) {
  const out: string[] = [];
  const el = (r: number) => ELEMENTS[r % 4];
  if (a.moon && b.moon) {
    if (a.moon.rashi === b.moon.rashi) out.push(`Both Moons are in ${RASHIS[a.moon.rashi]}.`);
    else if (el(a.moon.rashi) === el(b.moon.rashi)) out.push(`Both Moons are in ${el(a.moon.rashi)} signs.`);
    if (a.moon.nakshatra === b.moon.nakshatra) out.push(`You share the ${NAKSHATRAS[a.moon.nakshatra]} nakshatra.`);
  }
  if (a.sunRashi !== null && b.sunRashi !== null && el(a.sunRashi) === el(b.sunRashi)) out.push(`Both Suns are in ${el(a.sunRashi)} signs.`);
  if (a.lagnaRashi !== null && b.lagnaRashi !== null && el(a.lagnaRashi) === el(b.lagnaRashi)) out.push(`Both rising signs are ${el(a.lagnaRashi)} signs.`);
  return out;
}

/** Claims the work atomically, so duplicate requests can never produce two reports or two AI calls. */
export async function startPipeline(matchId: string) {
  const claimed = await prisma.astroSession.updateMany({ where: { matchId, status: { in: ["COLLECTING", "FAILED"] } }, data: { status: "CALCULATING", failure: null } });
  if (!claimed.count) return;
  await runPipeline(matchId).catch(async (err) => {
    logger.error({ matchId, reason: (err as Error).message }, "Astro calculation failed");
    await transition(matchId, "FAILED", "CALCULATION");
  });
}

async function participants(matchId: string) {
  const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { conversation: { select: { id: true } } } });
  return { ids: [m.userAId, m.userBId], conversationId: m.conversation?.id };
}

/** Moves running work along. If someone withdrew meanwhile the status has changed, so this quietly does nothing. */
async function transition(matchId: string, status: AstroStatus, failure: string | null = null) {
  const { count } = await prisma.astroSession.updateMany({ where: { matchId, status: { in: ["CALCULATING", "INTERPRETING"] } }, data: { status, failure } });
  if (count) tell({ matchId, status }, (await participants(matchId)).ids);
}

async function runPipeline(matchId: string) {
  const session = await prisma.astroSession.findUniqueOrThrow({ where: { matchId }, include: { consents: true, match: { include: { userA: { include: { profile: true } }, userB: { include: { profile: true } } } } } });
  const { userA, userB } = session.match;
  tell({ matchId, status: "CALCULATING" }, [userA.id, userB.id]);
  const [chartA, chartB] = await Promise.all([chartFor(userA.id), chartFor(userB.id)]);
  if (!(await stillRunning(session.id))) return;
  const { guna, reason } = gunaFor(userA.profile?.gender ?? null, userB.profile?.gender ?? null, chartA, chartB);
  const calc = { version: CALCULATION_VERSION, guna, gunaUnavailableReason: reason, themes: sharedThemes(chartA, chartB) };
  await prisma.astroReport.upsert({
    where: { sessionId: session.id },
    update: { version: CALCULATION_VERSION, calculation: calc as unknown as Prisma.InputJsonValue },
    create: { sessionId: session.id, version: CALCULATION_VERSION, calculation: calc as unknown as Prisma.InputJsonValue },
  });
  await interpretAndFinish(session.id, matchId);
}

const stillRunning = async (sessionId: string) => (await prisma.astroSession.count({ where: { id: sessionId, status: { in: ["CALCULATING", "INTERPRETING"] } } })) > 0;

/** Calculations are saved first, so an AI problem can only ever cost the written interpretation. */
async function interpretAndFinish(sessionId: string, matchId: string) {
  const session = await prisma.astroSession.findUniqueOrThrow({ where: { id: sessionId }, include: { consents: true, report: true, match: true } });
  const { userAId, userBId } = session.match;
  let outcome = "NO_CONSENT";
  let done = false;
  const aiAllowed = session.consents.length === 2 && session.consents.every((c) => c.externalAi);
  const settings = await prisma.userSettings.findMany({ where: { userId: { in: [userAId, userBId] } } });
  if (aiAllowed && settings.every((s) => s.aiEnabled !== false)) {
    await transition(matchId, "INTERPRETING");
    const [a, b] = await Promise.all([chartFor(userAId), chartFor(userBId)]);
    const calc = session.report!.calculation as unknown as { guna: ReturnType<typeof gunaMilan> | null };
    const shared = session.consents.every((c) => c.useInterests) ? await sharedInterestNames(userAId, userBId) : [];
    await prisma.astroSession.update({ where: { id: sessionId }, data: { aiAttempts: { increment: 1 } } });
    const result = await interpret(userAId, buildPrompt(a, b, calc.guna, shared));
    outcome = result.state;
    if (result.state === "DONE") {
      done = true;
      await prisma.astroReport.updateMany({ where: { sessionId }, data: { interpretation: result.data as unknown as Prisma.InputJsonValue, model: result.model, generatedAt: new Date() } });
    }
  }
  // Someone may have withdrawn while this ran: their choice wins, and nothing is kept.
  const finished = await prisma.astroSession.updateMany({ where: { id: sessionId, status: { in: ["CALCULATING", "INTERPRETING"] } }, data: { status: done ? "READY" : "PARTIAL", failure: done ? null : outcome } });
  if (!finished.count) {
    await prisma.astroReport.deleteMany({ where: { sessionId } });
    return;
  }
  const { ids, conversationId } = await participants(matchId);
  tell({ matchId, status: done ? "READY" : "PARTIAL" }, ids);
  for (const id of ids) await notify(id, "MATCH", "Your Cosmic Connection is ready", "Open it whenever you like. Your chat doesn't depend on it.", { matchId, conversationId });
}

async function sharedInterestNames(a: string, b: string) {
  const rows = await prisma.userInterest.findMany({ where: { userId: { in: [a, b] } }, include: { interest: { select: { name: true, slug: true } } } });
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.interest.name, (count.get(r.interest.name) ?? 0) + 1);
  return [...count].filter(([, n]) => n === 2).map(([name]) => name);
}

/** Retry only what is missing, with a per-match limit. A finished report is never regenerated by a retry. */
export async function retry(userId: string, matchId: string) {
  const { match, otherId } = await loadMatch(userId, matchId);
  await assertEligible(userId, otherId);
  const s = match.astroSession;
  if (!s) throw notFound("Nothing to retry.");
  if (s.status === "FAILED") void startPipeline(matchId);
  else if (s.status === "PARTIAL") {
    if (s.aiAttempts >= MAX_AI_ATTEMPTS) throw new ApiError(429, "ASTRO_RETRY_LIMIT", "We've tried a few times, so we'll leave this for now. Your calculated report is still here.");
    const claimed = await prisma.astroSession.updateMany({ where: { id: s.id, status: "PARTIAL" }, data: { status: "INTERPRETING" } });
    if (claimed.count) void interpretAndFinish(s.id, matchId).catch(() => transition(matchId, "PARTIAL", "FAILED"));
  } else throw badRequest("There's nothing to retry.");
  return stateFor(userId, matchId);
}

const summary = (c: ChartData) => ({
  sun: c.sunRashi === null ? null : RASHIS[c.sunRashi],
  moon: c.moon ? RASHIS[c.moon.rashi] : null,
  nakshatra: c.moon ? NAKSHATRAS[c.moon.nakshatra] : null,
  pada: c.moon?.pada || null,
  lagna: c.lagnaRashi === null ? null : RASHIS[c.lagnaRashi],
  accuracy: c.accuracy,
  unavailable: c.unavailable,
});

/** What the screen needs to resume after a refresh or reconnect. Only ever reveals the other person's state, not their details. */
export async function stateFor(userId: string, matchId: string) {
  const { match, otherId } = await loadMatch(userId, matchId);
  let session = match.astroSession;
  if (session && (session.status === "CALCULATING" || session.status === "INTERPRETING") && Date.now() - session.updatedAt.getTime() > STALE_MS) {
    // A restart mid-run must not leave people waiting forever.
    const next: AstroStatus = session.report ? "PARTIAL" : "FAILED";
    await prisma.astroSession.update({ where: { id: session.id }, data: { status: next, failure: "INTERRUPTED" } });
    session = { ...session, status: next, failure: "INTERRUPTED" };
  }
  const eligible = await astroEligible(userId, otherId);
  const hasReport = !!session?.report;
  // Someone no longer looking for long-term keeps a report they already have until either person withdraws, but sees no invitations.
  if (!eligible && !hasReport) return { available: false as const };
  const mine = session?.consents.find((c) => c.userId === userId);
  const theirs = session?.consents.find((c) => c.userId === otherId);
  const profile = await prisma.astroProfile.findUnique({ where: { userId }, select: { accuracy: true } });
  return {
    available: true as const,
    configured: cipherReady(),
    eligible,
    conversationId: match.conversation?.id ?? null,
    status: session?.status ?? "NOT_STARTED",
    failure: session?.failure ?? null,
    myState: mine?.state ?? null,
    theirState: theirs?.state === "CONSENTED" ? "CONSENTED" : theirs?.state === "INTERESTED" ? "INTERESTED" : theirs?.state ? "NOT_PARTICIPATING" : null,
    hasSavedBirth: !!profile,
    hasReport,
    canRetry: session?.status === "FAILED" || (session?.status === "PARTIAL" && session.aiAttempts < MAX_AI_ATTEMPTS && session.failure !== "NO_CONSENT" && (session.failure !== "NOT_CONFIGURED" || getProvider().enabled)),
  };
}

/** The joint report. Sign-level results only: degrees, dates, times and places are never included. */
export async function reportFor(userId: string, matchId: string) {
  const { match, otherId } = await loadMatch(userId, matchId);
  const s = match.astroSession;
  if (!s?.report || !s.consents.every((c) => c.state === "CONSENTED")) throw notFound("There's no report for this match.");
  const [mine, theirs, names] = await Promise.all([
    prisma.astroChart.findUnique({ where: { userId_version: { userId, version: s.report.version } } }),
    prisma.astroChart.findUnique({ where: { userId_version: { userId: otherId, version: s.report.version } } }),
    prisma.profile.findMany({ where: { userId: { in: [userId, otherId] } }, select: { userId: true, displayName: true } }),
  ]);
  if (!mine || !theirs) throw notFound("There's no report for this match.");
  const nameOf = (id: string) => names.find((n) => n.userId === id)?.displayName ?? "Your match";
  const calc = s.report.calculation as unknown as { version: string; guna: ReturnType<typeof gunaMilan> | null; gunaUnavailableReason: string | null; themes: string[] };
  const named = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll("Person A", nameOf(match.userAId)).replaceAll("Person B", nameOf(match.userBId))) as Interpretation;
  return {
    status: s.status,
    failure: s.failure,
    conversationId: match.conversation?.id ?? null,
    version: s.report.version,
    method: { calculation: "Sidereal positions (Lahiri ayanamsa, whole-sign houses) from an astronomical engine", guna: calc.guna ? GUNA_METHOD : null },
    me: { name: nameOf(userId), ...summary(mine.data as unknown as ChartData) },
    them: { name: nameOf(otherId), ...summary(theirs.data as unknown as ChartData) },
    guna: calc.guna,
    gunaUnavailableReason: calc.gunaUnavailableReason,
    themes: calc.themes,
    interpretation: s.report.interpretation ? named(s.report.interpretation) : null,
    interpretationMine: match.userAId === userId ? "personA" : "personB",
    model: s.report.model,
  };
}

/** Withdrawing removes the joint report for both people. Birth details stay until deleted, unless `deleteData` asks now. */
export async function withdraw(userId: string, matchId: string) {
  const { match, otherId } = await loadMatch(userId, matchId);
  if (match.astroSession) await prisma.astroReport.deleteMany({ where: { sessionId: match.astroSession.id } });
  await setConsent(userId, matchId, otherId, "WITHDRAWN", { withdrawnAt: new Date(), externalAi: false, useInterests: false });
  return stateFor(userId, matchId);
}

/** Deletes birth details and charts, and every joint report they fed. */
export async function deleteMyData(userId: string) {
  const consents = await prisma.astroConsent.findMany({ where: { userId }, include: { session: { include: { match: true } } } });
  await prisma.$transaction([
    prisma.astroReport.deleteMany({ where: { sessionId: { in: consents.map((c) => c.sessionId) } } }),
    prisma.astroConsent.updateMany({ where: { userId }, data: { state: "WITHDRAWN", withdrawnAt: new Date(), externalAi: false, useInterests: false } }),
    prisma.astroSession.updateMany({ where: { id: { in: consents.map((c) => c.sessionId) } }, data: { status: "WITHDRAWN" } }),
    prisma.astroChart.deleteMany({ where: { userId } }),
    prisma.astroProfile.deleteMany({ where: { userId } }),
  ]);
  for (const c of consents) tell({ matchId: c.session.matchId, status: "WITHDRAWN" }, [c.session.match.userAId, c.session.match.userBId]);
}

/** An ended match takes its joint report with it. */
export const closeForMatch = (matchId: string) => prisma.astroSession.deleteMany({ where: { matchId } });

/** Retention: birth details unused for the configured period are removed. */
export async function purgeExpired() {
  const cutoff = new Date(Date.now() - config.astro.retentionDays * 86400000);
  const stale = await prisma.astroProfile.findMany({ where: { lastUsedAt: { lt: cutoff } }, select: { userId: true } });
  for (const { userId } of stale) await deleteMyData(userId);
  return stale.length;
}

export const myDataSummary = async (userId: string) => {
  const p = await prisma.astroProfile.findUnique({ where: { userId } });
  return { hasBirthDetails: !!p, accuracy: p?.accuracy ?? null, lastUsedAt: p?.lastUsedAt ?? null, retentionDays: config.astro.retentionDays };
};
