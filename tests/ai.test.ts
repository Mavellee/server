import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { setProvider, type AIProvider, type GenerateRequest } from "../src/modules/ai/provider.js";
import { parseSuggestions } from "../src/modules/ai/service.js";
import { createUser, loginAs, match, resetDb } from "./helpers.js";

const fake = (impl: (r: GenerateRequest) => Promise<string>): AIProvider => ({
  name: "fake",
  enabled: true,
  generate: async (r) => ({ text: await impl(r), model: "fake-1" }),
});
const disabled: AIProvider = { name: "none", enabled: false, generate: async () => { throw new Error("off"); } };

beforeEach(resetDb);
afterEach(() => setProvider(disabled));

describe("Knot AI", () => {
  it("works with no AI configured by returning labelled curated suggestions", async () => {
    setProvider(disabled);
    const s = await loginAs(await createUser());
    const res = await s.post("/api/ai/suggest", { feature: "reflection" });
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe("curated");
    expect(res.body.data.suggestions.length).toBeGreaterThan(0);
  });

  it("labels AI output, caps its length and logs metadata only", async () => {
    let seenPrompt = "";
    setProvider(fake(async (r) => {
      seenPrompt = r.prompt;
      return "1. What's your favourite hike?\n- Coffee or tea on a slow morning?\n" + "x".repeat(5000);
    }));
    const a = await createUser({ interests: ["hiking", "coffee"] });
    const b = await createUser({ interests: ["hiking"] });
    const { sa, matchId, conversationId } = await match(a, b);
    await sa.post(`/api/conversations/${conversationId}/messages`, { body: "very private message" });

    const res = await sa.post("/api/ai/suggest", { feature: "conversation_starter", matchId });
    expect(res.body.data.source).toBe("ai");
    expect(res.body.data.label).toMatch(/Knot AI/);
    expect(res.body.data.suggestions[0]).toBe("What's your favourite hike?");
    expect(res.body.data.suggestions.join("").length).toBeLessThanOrEqual(600);
    // Private chats are never sent to the AI.
    expect(seenPrompt).not.toContain("very private message");

    const usage = await prisma.aIUsage.findFirstOrThrow();
    expect(usage).toMatchObject({ status: "OK", feature: "conversation_starter", provider: "fake" });
    expect(Object.keys(usage)).not.toEqual(expect.arrayContaining(["prompt", "output", "text"]));
  });

  it("falls back to curated content when the provider times out or errors", async () => {
    setProvider(fake(() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 50))));
    const s = await loginAs(await createUser());
    const res = await s.post("/api/ai/suggest", { feature: "reflection" });
    expect(res.body.data.source).toBe("curated");
    expect((await prisma.aIUsage.findFirstOrThrow()).status).toBe("ERROR");

    setProvider(fake((r) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve("too late, this should not be used"), 2000);
      r.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("AbortError")); });
    })));
    const slow = await s.post("/api/ai/suggest", { feature: "reflection" });
    expect(slow.body.data.source).toBe("curated");
  });

  it("enforces the per-user daily limit and then serves curated content", async () => {
    setProvider(fake(async () => "A thoughtful question here?\nAnother gentle prompt here?"));
    const s = await loginAs(await createUser());
    for (let i = 0; i < 3; i++) expect((await s.post("/api/ai/suggest", { feature: "reflection" })).body.data.source).toBe("ai");
    const limited = await s.post("/api/ai/suggest", { feature: "reflection" });
    expect(limited.body.data.source).toBe("curated");
    expect(limited.body.data.note).toMatch(/limit/);
    expect(await prisma.aIUsage.count({ where: { status: "RATE_LIMITED" } })).toBe(1);
    expect((await s.get("/api/ai/status")).body.data.remainingToday).toBe(0);
  });

  it("respects a member who turned AI off", async () => {
    let called = false;
    setProvider(fake(async () => { called = true; return "Should not be called at all"; }));
    const s = await loginAs(await createUser());
    await s.patch("/api/settings", { aiEnabled: false });
    expect((await s.post("/api/ai/suggest", { feature: "reflection" })).body.data.source).toBe("curated");
    expect(called).toBe(false);
  });

  it("only explains the deterministic result and never for blocked or unknown people", async () => {
    setProvider(disabled);
    const a = await createUser();
    const b = await createUser();
    const s = await loginAs(a);
    const res = await s.post("/api/ai/suggest", { feature: "explain_compatibility", userId: b.id });
    expect(res.body.data.note).toMatch(/does not predict/);
    await prisma.block.create({ data: { blockerId: b.id, blockedId: a.id } });
    expect((await s.post("/api/ai/suggest", { feature: "explain_compatibility", userId: b.id })).status).toBe(404);
  });

  it("parses model output defensively", () => {
    expect(parseSuggestions("1) First idea here\n\n* Second idea here\nok", 600)).toEqual(["First idea here", "Second idea here"]);
  });
});
