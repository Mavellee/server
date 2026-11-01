import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { setProvider, type AIProvider } from "../src/modules/ai/provider.js";
import { createUser, loginAs, match, resetDb } from "./helpers.js";

const noAi: AIProvider = { name: "none", enabled: false, generate: async () => ({ text: "", model: "" }) };

beforeEach(resetDb);
afterEach(() => setProvider(noAi));

async function approvedExpert() {
  const u = await createUser({ role: "EXPERT", published: false });
  await prisma.expertProfile.create({
    data: { userId: u.id, headline: "Coach", bio: "x".repeat(50), experienceYears: 5, specialties: ["Communication"], status: "APPROVED" },
  });
  return u;
}

describe("Compatibility Expert workflow", () => {
  it("an application only grants the expert role after admin approval, which is audited", async () => {
    const applicant = await createUser();
    const s = await loginAs(applicant);
    const apply = await s.post("/api/experts/apply", { headline: "Communication coach", bio: "I have run communication workshops for couples for years.", experienceYears: 6, specialties: ["Communication"] });
    expect(apply.status).toBe(201);
    expect((await s.get("/api/experts/workspace/queue")).status).toBe(403);

    const admin = await loginAs(await createUser({ role: "ADMIN" }));
    expect((await admin.get("/api/admin/experts")).body.data).toHaveLength(1);
    const decide = await admin.post(`/api/admin/experts/${applicant.id}/decision`, { decision: "APPROVED", note: "Interview completed." });
    expect(decide.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: applicant.id } })).role).toBe("EXPERT");
    expect(await prisma.adminAuditLog.count({ where: { action: "expert.approved" } })).toBe(1);
    // Approved without a credential check: never shown as verified.
    const list = (await s.get("/api/experts")).body.data;
    expect(list[0].credentialsVerified).toBe(false);
    expect((await s.get("/api/experts/workspace/queue")).status).toBe(200);
  });

  it("experts see only consented data, and only after claiming", async () => {
    const member = await createUser({ name: "Asha", interests: ["coffee"] });
    const expert = await approvedExpert();
    const sm = await loginAs(member);
    const req = await sm.post("/api/experts/requests", {
      topic: "Readiness",
      question: "Am I explaining what I want clearly on my profile?",
      share: { profile: true, intentions: false, compatibilityAnswers: false },
      consent: true,
    });
    expect(req.status).toBe(201);
    expect(req.body.data.sharedFields).toEqual(["profile"]);
    expect(req.body.data.sharedData).not.toHaveProperty("intentions");
    expect(JSON.stringify(req.body.data.sharedData)).not.toContain(member.email);

    const se = await loginAs(expert);
    const queue = (await se.get("/api/experts/workspace/queue")).body.data;
    expect(queue.pending[0]).not.toHaveProperty("sharedData");
    expect((await se.get(`/api/experts/workspace/queue/${req.body.data.id}`)).status).toBe(404);

    const claimed = await se.post(`/api/experts/workspace/queue/${req.body.data.id}/claim`);
    expect(claimed.status).toBe(200);
    expect(claimed.body.data.sharedData.profile.displayName).toBe("Asha");
    // A second claim fails.
    const other = await loginAs(await approvedExpert());
    expect((await other.post(`/api/experts/workspace/queue/${req.body.data.id}/claim`)).status).toBe(409);
  });

  it("supports request-info, member reply, completion and decline with history and notifications", async () => {
    const member = await createUser();
    const expert = await approvedExpert();
    const sm = await loginAs(member);
    const se = await loginAs(expert);
    const id = (await sm.post("/api/experts/requests", { topic: "Values", question: "How should I think about my long-term values answers?", share: { intentions: true }, consent: true })).body.data.id;
    await se.post(`/api/experts/workspace/queue/${id}/claim`);
    expect((await se.post(`/api/experts/workspace/queue/${id}/request-info`, { message: "Could you share what matters most to you?" })).status).toBe(200);
    expect((await sm.post(`/api/experts/requests/${id}/respond`, { message: "Family closeness and honesty." })).status).toBe(200);
    expect((await se.post(`/api/experts/workspace/queue/${id}/complete`, { message: "Here are some reflections for you to consider." })).status).toBe(200);

    const mine = (await sm.get("/api/experts/requests")).body.data[0];
    expect(mine.status).toBe("COMPLETED");
    expect(mine.reviews.map((r: { action: string }) => r.action)).toEqual(["CLAIMED", "INFO_REQUESTED", "INFO_PROVIDED", "COMPLETED"]);
    expect(await prisma.notification.count({ where: { userId: member.id, type: "EXPERT_UPDATE" } })).toBe(3);

    const id2 = (await sm.post("/api/experts/requests", { topic: "Other", question: "Can you tell me if my match is right for me?", share: {}, consent: true })).body.data.id;
    await se.post(`/api/experts/workspace/queue/${id2}/claim`);
    expect((await se.post(`/api/experts/workspace/queue/${id2}/decline`, { message: "x" })).status).toBe(422); // explanation required
    expect((await se.post(`/api/experts/workspace/queue/${id2}/decline`, { message: "This is outside what an expert review can answer." })).status).toBe(200);
  });

  it("completing a review never creates or changes a match, and experts cannot read chats", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, matchId, conversationId } = await match(a, b);
    await sa.post(`/api/conversations/${conversationId}/messages`, { body: "private" });
    const expert = await approvedExpert();
    const se = await loginAs(expert);
    const id = (await sa.post("/api/experts/requests", { topic: "Match", question: "What could we talk about to understand each other?", share: { matchId }, consent: true })).body.data.id;
    const claimed = (await se.post(`/api/experts/workspace/queue/${id}/claim`)).body.data;
    expect(JSON.stringify(claimed.sharedData)).not.toContain("private");
    await se.post(`/api/experts/workspace/queue/${id}/complete`, { message: "Some thoughts for your next conversation." });
    expect(await prisma.match.count()).toBe(1);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe("ACTIVE");
    expect((await se.get(`/api/conversations/${conversationId}/messages`)).status).toBe(404);
  });
});

describe("AI reviews", () => {
  const body = { topic: "Communication", question: "How can I say what I need more clearly?", consent: true };
  const useAi = (impl: (prompt: string, system: string) => string) =>
    setProvider({ name: "fake", enabled: true, generate: async (r) => ({ text: impl(r.prompt, r.system), model: "fake-1" }) });

  it("completes the request with a review labelled as AI, from only what was ticked", async () => {
    let sent = "";
    useAi((prompt) => {
      sent = prompt;
      return "It sounds like clarity matters to you. Try naming one need this week.";
    });
    const a = await createUser({ name: "Asha", interests: ["coffee"] });
    const b = await createUser();
    const { sa, matchId, conversationId } = await match(a, b);
    await sa.post(`/api/conversations/${conversationId}/messages`, { body: "very private message" });
    const res = await sa.post("/api/experts/requests", { ...body, share: { profile: true, intentions: false, compatibilityAnswers: false, matchId } });
    expect(res.body.data.status).toBe("COMPLETED");
    expect(sent).toContain("say what I need");
    expect(sent).toContain("Coffee");
    expect(sent).not.toContain("Asha");
    expect(sent).not.toContain("very private message");
    expect(sent).not.toContain("compatibilityAnswers");
    const [mine] = (await sa.get("/api/experts/requests")).body.data;
    expect(mine.reviews[0]).toMatchObject({ action: "COMPLETED", aiWritten: true, authorId: null });
    expect(await prisma.notification.count({ where: { userId: a.id, type: "EXPERT_UPDATE" } })).toBe(1);
    const expert = await loginAs(await approvedExpert());
    expect((await expert.get("/api/experts/workspace/queue")).body.data.pending).toHaveLength(0);
  });

  it("stays with the experts, with no made-up review, when AI is off, fails or the member opted out", async () => {
    const share = { profile: false, intentions: false, compatibilityAnswers: false };
    const u = await createUser();
    const s = await loginAs(u);
    setProvider(noAi);
    expect((await s.post("/api/experts/requests", { ...body, share })).body.data.status).toBe("PENDING");
    setProvider({ name: "fake", enabled: true, generate: async () => { throw new Error("down"); } });
    expect((await s.post("/api/experts/requests", { ...body, share })).body.data.status).toBe("PENDING");
    expect(await prisma.expertReview.count()).toBe(0);

    let called = false;
    useAi(() => {
      called = true;
      return "A reflection that should never be requested.";
    });
    const other = await createUser();
    await prisma.userSettings.upsert({ where: { userId: other.id }, create: { userId: other.id, aiEnabled: false }, update: { aiEnabled: false } });
    const so = await loginAs(other);
    expect((await so.post("/api/experts/requests", { ...body, share })).body.data.status).toBe("PENDING");
    expect(called).toBe(false);
  });
});
