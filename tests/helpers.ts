import request from "supertest";
import type { Gender, Intention } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { seedReference } from "../prisma/seed-data/loadReference.js";

export const ORIGIN = "http://localhost:5180";
export const PASSWORD = "CorrectHorse42";
export const app = createApp();

let passwordHash: string | null = null;

/** Empties every table and reloads reference data. */
export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await seedReference(prisma, () => {});
}

let counter = 0;
export interface UserOpts {
  name?: string;
  gender?: Gender;
  interestedIn?: Gender[];
  age?: number;
  intentions?: Intention[];
  sought?: Intention[];
  city?: string;
  lat?: number;
  lon?: number;
  maxDistanceKm?: number | null;
  ageMin?: number;
  ageMax?: number;
  role?: "USER" | "EXPERT" | "MODERATOR" | "ADMIN";
  interests?: string[];
  published?: boolean;
  status?: "ACTIVE" | "PENDING_VERIFICATION";
}

/** Creates a fully onboarded member directly in the database. */
export async function createUser(o: UserOpts = {}) {
  passwordHash ??= await hashPassword(PASSWORD);
  counter++;
  const age = o.age ?? 28;
  const now = new Date();
  // A birthday ~30 days ago, so the computed age is exactly `age`.
  const dob = new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()) - 30 * 86400000);
  const interestRows = o.interests ? await prisma.interest.findMany({ where: { slug: { in: o.interests } } }) : [];
  const user = await prisma.user.create({
    data: {
      email: `user${counter}-${Date.now()}@knot.test`,
      passwordHash,
      role: o.role ?? "USER",
      status: o.status ?? "ACTIVE",
      emailVerifiedAt: o.status === "PENDING_VERIFICATION" ? null : now,
      dateOfBirth: dob,
      ageConfirmedAt: now,
      onboardedAt: now,
      settings: { create: {} },
      profile: {
        create: {
          displayName: o.name ?? `Member ${counter}`,
          gender: o.gender ?? "WOMAN",
          interestedIn: o.interestedIn ?? ["MAN", "WOMAN"],
          city: o.city ?? "New Delhi",
          latitude: o.lat ?? 28.61,
          longitude: o.lon ?? 77.21,
          ageMin: o.ageMin ?? 18,
          ageMax: o.ageMax ?? 60,
          maxDistanceKm: o.maxDistanceKm === undefined ? null : o.maxDistanceKm,
          isPublished: o.published ?? true,
        },
      },
      preferences: {
        create: [
          ...(o.intentions ?? ["SINGLE"]).map((intention) => ({ kind: "OWN" as const, intention })),
          ...(o.sought ?? []).map((intention) => ({ kind: "SOUGHT" as const, intention })),
        ],
      },
      interests: { create: interestRows.map((i) => ({ interestId: i.id })) },
      photos: { create: { storageKey: `test-${counter}-${Date.now()}.jpg`, mimeType: "image/jpeg", sizeBytes: 10, position: 0 } },
    },
  });
  return user;
}

/** A supertest agent that is logged in as the user and sends a valid Origin header. */
export async function loginAs(user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("Origin", ORIGIN).send({ email: user.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent);
}

export function anon() {
  return wrap(request.agent(app));
}

function wrap(agent: ReturnType<typeof request.agent>) {
  return {
    agent,
    get: (url: string) => agent.get(url).set("Origin", ORIGIN),
    post: (url: string, body?: object) => agent.post(url).set("Origin", ORIGIN).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set("Origin", ORIGIN).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set("Origin", ORIGIN).send(body ?? {}),
    delete: (url: string) => agent.delete(url).set("Origin", ORIGIN),
  };
}

export async function match(a: { id: string }, b: { id: string }) {
  const sa = await loginAs(await prisma.user.findUniqueOrThrow({ where: { id: a.id } }));
  const sb = await loginAs(await prisma.user.findUniqueOrThrow({ where: { id: b.id } }));
  await sa.post("/api/likes", { userId: b.id });
  const res = await sb.post("/api/likes", { userId: a.id });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { matchId: res.body.data.matchId } });
  return { sa, sb, matchId: res.body.data.matchId as string, conversationId: convo.id };
}
