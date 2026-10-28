import { describe, expect, it, beforeEach } from "vitest";
import { computeCompatibility, ENGINE_VERSION, type PersonInput, type QuestionInput, type Weights } from "../src/modules/compatibility/engine.js";
import { prisma } from "../src/db.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

const W: Weights = { RELATIONSHIP_GOALS: 5, COMMUNICATION: 3, LIFESTYLE: 3, INTERESTS: 2, VALUES: 4 };
const Q: QuestionInput[] = [
  { id: "q1", key: "conflict", prompt: "Conflict style", dimension: "COMMUNICATION" },
  { id: "q2", key: "smoking", prompt: "Smoking", dimension: "LIFESTYLE" },
  { id: "q3", key: "family", prompt: "Family", dimension: "VALUES" },
];
const person = (p: Partial<PersonInput> = {}): PersonInput => ({ intentions: ["MARRIAGE"], soughtIntentions: [], interestIds: ["i1", "i2"], answers: [], ...p });
const ans = (questionId: string, answer: string, acceptable: string[] = [], importance = 2, isDealbreaker = false) => ({ questionId, answer, acceptable, importance, isDealbreaker });

describe("compatibility engine (unit)", () => {
  it("is deterministic and symmetric in score", () => {
    const a = person({ answers: [ans("q1", "talk", ["talk"]), ans("q2", "never", ["never"])] });
    const b = person({ intentions: ["MARRIAGE", "SINGLE"], interestIds: ["i2", "i3"], answers: [ans("q1", "space", []), ans("q2", "never", [])] });
    const r1 = computeCompatibility(a, b, Q, W);
    expect(computeCompatibility(a, b, Q, W)).toEqual(r1);
    expect(computeCompatibility(b, a, Q, W).score).toBe(r1.score);
    expect(r1.version).toBe(ENGINE_VERSION);
  });

  it("distinguishes missing answers from incompatible ones", () => {
    const a = person({ answers: [ans("q1", "talk", ["talk"], 3), ans("q2", "never", ["never"], 3)] });
    const b = person({ answers: [ans("q1", "space", ["space"], 3)] });
    const r = computeCompatibility(a, b, Q, W);
    const byKey = Object.fromEntries(r.items.map((i) => [i.key, i.status]));
    expect(byKey.conflict).toBe("different");
    expect(byKey.smoking).toBe("missing_them");
    expect(r.items.find((i) => i.key === "family")).toBeUndefined(); // nobody answered: not listed
    const lifestyle = r.dimensions.find((d) => d.dimension === "LIFESTYLE")!;
    expect(lifestyle.score).toBeNull(); // missing is not scored as 0
    expect(lifestyle.missing).toBe(1);
  });

  it("flags dealbreakers without hiding them in the average", () => {
    const a = person({ answers: [ans("q2", "never", ["never"], 3, true)] });
    const b = person({ answers: [ans("q2", "regularly", [], 1)] });
    const r = computeCompatibility(a, b, Q, W);
    expect(r.dealbreakerConflicts).toBe(1);
    expect(r.items.find((i) => i.key === "smoking")!.dealbreaker).toBe("yours");
  });

  it("ignores answers the person marked as unimportant", () => {
    const a = person({ answers: [ans("q3", "very", ["very"], 0)] });
    const b = person({ answers: [ans("q3", "private", ["private"], 0)] });
    const values = computeCompatibility(a, b, Q, W).dimensions.find((d) => d.dimension === "VALUES")!;
    expect(values.score).toBeNull();
  });

  it("respects configurable weights", () => {
    const a = person({ interestIds: ["x"], answers: [ans("q1", "talk", ["talk"])] });
    const b = person({ interestIds: ["y"], answers: [ans("q1", "talk", ["talk"])] });
    const heavyInterests = computeCompatibility(a, b, Q, { ...W, INTERESTS: 10, COMMUNICATION: 0 }).score!;
    const heavyComms = computeCompatibility(a, b, Q, { ...W, INTERESTS: 0, COMMUNICATION: 10 }).score!;
    expect(heavyComms).toBeGreaterThan(heavyInterests);
  });

  it("returns no score when there is not enough information", () => {
    const r = computeCompatibility(person({ interestIds: [], intentions: [] }), person({ interestIds: [] }), Q, W);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe("not_enough_information");
  });

  it("scores intentions through what each person is looking for", () => {
    const a = person({ intentions: ["SITUATIONSHIP"], soughtIntentions: ["SITUATIONSHIP"] });
    const b = person({ intentions: ["MARRIAGE"], soughtIntentions: ["MARRIAGE"] });
    expect(computeCompatibility(a, b, Q, W).items.find((i) => i.key === "intentions")!.status).toBe("different");
  });
});

describe("compatibility API", () => {
  beforeEach(resetDb);

  it("records an auditable result with version and input hash, without leaking answers", async () => {
    const a = await createUser({ interests: ["coffee", "hiking"] });
    const b = await createUser({ interests: ["coffee"] });
    const sa = await loginAs(a);
    const qs = (await sa.get("/api/compatibility/questions")).body.data;
    await sa.put(`/api/compatibility/answers/${qs[0].id}`, { answer: qs[0].options[0].value, importance: 3 });
    const sb = await loginAs(b);
    await sb.put(`/api/compatibility/answers/${qs[0].id}`, { answer: qs[0].options[1].value, acceptable: [qs[0].options[1].value], importance: 2 });

    const res = await sa.get(`/api/compatibility/with/${b.id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(qs[0].options[1].value + '"');
    const rows = await prisma.compatibilityResult.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(ENGINE_VERSION);
    expect(rows[0].inputsHash).toHaveLength(32);

    // Same inputs: no new audit row. Changed inputs: a new one.
    await sa.get(`/api/compatibility/with/${b.id}`);
    expect(await prisma.compatibilityResult.count()).toBe(1);
    await sa.delete(`/api/compatibility/answers/${qs[0].id}`);
    await sa.get(`/api/compatibility/with/${b.id}`);
    expect(await prisma.compatibilityResult.count()).toBe(2);
  });

  it("validates answers against the question's options and dealbreaker rules", async () => {
    const sa = await loginAs(await createUser());
    const q = (await sa.get("/api/compatibility/questions")).body.data[0];
    expect((await sa.put(`/api/compatibility/answers/${q.id}`, { answer: "made-up" })).status).toBe(400);
    expect((await sa.put(`/api/compatibility/answers/${q.id}`, { answer: q.options[0].value, isDealbreaker: true })).status).toBe(400);
  });
});
