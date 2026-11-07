import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { heightLabel, readDealbreakers } from "../src/lib/vitals.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

beforeEach(resetDb);

const names = (res: { body: { data: { items: { displayName: string }[] } } }) => res.body.data.items.map((p) => p.displayName).sort();
const man = (name: string) => createUser({ name, gender: "MAN", interestedIn: ["WOMAN"] });
const setVitals = (id: string, data: object) => prisma.profile.update({ where: { userId: id }, data });

describe("profile vitals", () => {
  it("saves, returns and clears vitals on the owner's profile", async () => {
    const me = await createUser({ name: "Me" });
    const s = await loginAs(me);
    const res = await s.patch("/api/profiles/me", { heightCm: 170, jobTitle: "  Architect ", religion: "sikh", motherTongue: "punjabi", diet: "vegetarian", drinking: "socially", familyPlans: "open", hiddenVitals: ["religion"] });
    expect(res.status).toBe(200);
    expect(res.body.data.vitals).toMatchObject({ heightCm: 170, jobTitle: "Architect", religion: "sikh", motherTongue: "punjabi", diet: "vegetarian", drinking: "socially", familyPlans: "open", smoking: null });
    expect(res.body.data.hiddenVitals).toEqual(["religion"]);

    // Fields not sent are kept; null clears one.
    const cleared = await s.patch("/api/profiles/me", { drinking: null });
    expect(cleared.body.data.vitals).toMatchObject({ heightCm: 170, drinking: null, religion: "sikh" });
  });

  it("rejects unknown options and out-of-range heights", async () => {
    const s = await loginAs(await createUser({ name: "Me" }));
    expect((await s.patch("/api/profiles/me", { religion: "pastafarian" })).status).toBe(422);
    expect((await s.patch("/api/profiles/me", { heightCm: 300 })).status).toBe(422);
    expect((await s.patch("/api/profiles/me", { hiddenVitals: ["email"] })).status).toBe(422);
    expect((await s.patch("/api/profiles/me", { jobTitle: "x".repeat(61) })).status).toBe(422);
    expect((await s.patch("/api/profiles/me", { dealbreakers: { includeUnstated: true, caste: ["x"] } })).status).toBe(422);
    expect((await s.patch("/api/profiles/me", { dealbreakers: { heightMinCm: 180, heightMaxCm: 160 } })).status).toBe(422);
  });

  it("shows only stated, visible vitals to others, labelled, and never their dealbreakers", async () => {
    const viewer = await createUser({ name: "Viewer", gender: "WOMAN", interestedIn: ["MAN"] });
    const him = await man("Him");
    await setVitals(him.id, { heightCm: 180, religion: "hindu", smoking: "never", hiddenVitals: ["religion"], dealbreakers: { religion: ["hindu"], includeUnstated: false } });
    const res = await (await loginAs(viewer)).get(`/api/profiles/${him.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.vitals).toEqual([
      { key: "height", label: "Height", value: heightLabel(180) },
      { key: "smoking", label: "Smoking", value: "Doesn't smoke" },
    ]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("hindu");
    expect(body).not.toContain("dealbreakers");
    expect(body).not.toContain("hiddenVitals");
    expect(heightLabel(180)).toBe("5′11″ · 180 cm");
  });
});

describe("dealbreakers in Discover", () => {
  it("keeps only matching answers, and includes people who haven't said unless asked not to", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    const veg = await man("Veg");
    const nonVeg = await man("NonVeg");
    await man("Unsaid");
    const hidden = await man("Hidden");
    await setVitals(veg.id, { diet: "vegetarian" });
    await setVitals(nonVeg.id, { diet: "non_vegetarian" });
    // A hidden answer behaves as unanswered, so filtering can't reveal it, even when it would match.
    await setVitals(hidden.id, { diet: "vegetarian", hiddenVitals: ["diet"] });

    const s = await loginAs(me);
    expect((await s.patch("/api/profiles/me", { dealbreakers: { diet: ["vegetarian", "vegan"], includeUnstated: true } })).status).toBe(200);
    expect(names(await s.get("/api/discovery"))).toEqual(["Hidden", "Unsaid", "Veg"]);

    await s.patch("/api/profiles/me", { dealbreakers: { diet: ["vegetarian"], includeUnstated: false } });
    expect(names(await s.get("/api/discovery"))).toEqual(["Veg"]);
  });

  it("combines several dealbreakers, including a height range", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    const a = await man("TallTamil");
    const b = await man("ShortTamil");
    const c = await man("TallHindi");
    await setVitals(a.id, { heightCm: 182, motherTongue: "tamil", smoking: "never" });
    await setVitals(b.id, { heightCm: 160, motherTongue: "tamil", smoking: "never" });
    await setVitals(c.id, { heightCm: 185, motherTongue: "hindi", smoking: "never" });
    const s = await loginAs(me);
    await s.patch("/api/profiles/me", { dealbreakers: { heightMinCm: 170, motherTongue: ["tamil", "telugu"], smoking: ["never"], includeUnstated: false } });
    expect(names(await s.get("/api/discovery"))).toEqual(["TallTamil"]);

    // Clearing them brings everyone back.
    await s.patch("/api/profiles/me", { dealbreakers: { includeUnstated: true } });
    expect(names(await s.get("/api/discovery"))).toEqual(["ShortTamil", "TallHindi", "TallTamil"]);
  });

  it("is one-way: my dealbreakers don't hide me from others", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    const him = await man("Him");
    await setVitals(him.id, { smoking: "regularly" });
    const s = await loginAs(me);
    await s.patch("/api/profiles/me", { dealbreakers: { smoking: ["never"], includeUnstated: false } });
    expect(names(await s.get("/api/discovery"))).toEqual([]);
    expect(names(await (await loginAs(him)).get("/api/discovery"))).toEqual(["Me"]);
  });

  it("ignores unknown or broken stored data instead of failing", () => {
    expect(readDealbreakers(null)).toEqual({ includeUnstated: true });
    expect(readDealbreakers({ religion: ["hindu", "nope", 3], heightMinCm: 999, includeUnstated: false, extra: 1 })).toEqual({ religion: ["hindu"], includeUnstated: false });
  });
});
