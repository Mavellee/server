import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

beforeEach(resetDb);

const names = (res: { body: { data: { items: { displayName: string }[] } } }) => res.body.data.items.map((p) => p.displayName).sort();

describe("discovery filters", () => {
  it("excludes self, blocked users, and people outside preferences in both directions", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], age: 30, ageMin: 25, ageMax: 35 });
    await createUser({ name: "Fits", gender: "MAN", interestedIn: ["WOMAN"], age: 31 });
    await createUser({ name: "WrongGender", gender: "WOMAN", interestedIn: ["WOMAN"], age: 30 });
    await createUser({ name: "TooOld", gender: "MAN", interestedIn: ["WOMAN"], age: 45 });
    await createUser({ name: "NotIntoMe", gender: "MAN", interestedIn: ["MAN"], age: 30 });
    await createUser({ name: "WantsOlder", gender: "MAN", interestedIn: ["WOMAN"], age: 30, ageMin: 35, ageMax: 50 });
    const blocked = await createUser({ name: "Blocked", gender: "MAN", interestedIn: ["WOMAN"], age: 30 });
    const blocker = await createUser({ name: "BlockedMe", gender: "MAN", interestedIn: ["WOMAN"], age: 30 });
    await createUser({ name: "Unpublished", gender: "MAN", interestedIn: ["WOMAN"], age: 30, published: false });
    const paused = await createUser({ name: "Paused", gender: "MAN", interestedIn: ["WOMAN"], age: 30 });
    await prisma.profile.update({ where: { userId: paused.id }, data: { discoveryPausedAt: new Date() } });
    const hidden = await createUser({ name: "Hidden", gender: "MAN", interestedIn: ["WOMAN"], age: 30 });
    await prisma.profile.update({ where: { userId: hidden.id }, data: { isDiscoverable: false } });
    await prisma.block.createMany({ data: [{ blockerId: me.id, blockedId: blocked.id }, { blockerId: blocker.id, blockedId: me.id }] });

    const res = await (await loginAs(me)).get("/api/discovery");
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Fits"]);
  });

  it("applies sought relationship intentions", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], sought: ["MARRIAGE"] });
    await createUser({ name: "Commit", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE"] });
    await createUser({ name: "Casual", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SITUATIONSHIP"] });
    expect(names(await (await loginAs(me)).get("/api/discovery"))).toEqual(["Commit"]);
  });

  it("applies the distance limit", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], maxDistanceKm: 50 });
    await createUser({ name: "Gurugram", gender: "MAN", interestedIn: ["WOMAN"], lat: 28.46, lon: 77.03 });
    await createUser({ name: "Mumbai", gender: "MAN", interestedIn: ["WOMAN"], lat: 19.08, lon: 72.88 });
    const res = await (await loginAs(me)).get("/api/discovery");
    expect(names(res)).toEqual(["Gurugram"]);
    expect(res.body.data.items[0].distance).toMatch(/km away/);
  });

  it("hides people already liked or passed, and pages with a cursor", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    const others = [];
    for (let i = 0; i < 7; i++) others.push(await createUser({ name: `M${i}`, gender: "MAN", interestedIn: ["WOMAN"] }));
    const s = await loginAs(me);
    await s.post("/api/likes", { userId: others[0].id });
    await s.post("/api/likes/pass", { userId: others[1].id });

    const page1 = await s.get("/api/discovery?limit=3");
    expect(page1.body.data.items).toHaveLength(3);
    const page2 = await s.get(`/api/discovery?limit=3&cursor=${page1.body.data.nextCursor}`);
    expect(page2.body.data.items).toHaveLength(2);
    expect(page2.body.data.nextCursor).toBeNull();
    const seen = [...page1.body.data.items, ...page2.body.data.items].map((p: { id: string }) => p.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain(others[0].id);
    expect(seen).not.toContain(others[1].id);
  });

  it("requires a published profile", async () => {
    const me = await createUser({ published: false });
    expect((await (await loginAs(me)).get("/api/discovery")).status).toBe(400);
  });
});

describe("intention defaults", () => {
  beforeEach(resetDb);
  it("uses your own intentions when you haven't chosen which ones to see", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], intentions: ["MARRIAGE"] });
    await createUser({ name: "Commit", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE", "SINGLE"] });
    await createUser({ name: "Explore", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SINGLE"] });
    expect(names(await (await loginAs(me)).get("/api/discovery"))).toEqual(["Commit"]);
  });
});

describe("discovery filters (query)", () => {
  beforeEach(resetDb);
  it("narrows by intention, age, interests and distance but never widens saved preferences", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], intentions: ["SINGLE", "MARRIAGE"], ageMin: 25, ageMax: 40 });
    await createUser({ name: "Explorer", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SINGLE"], age: 30, interests: ["hiking"] });
    await createUser({ name: "Committed", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE"], age: 35, interests: ["coffee"] });
    await createUser({ name: "Far", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE"], age: 33, lat: 19.08, lon: 72.88 });
    await createUser({ name: "TooYoungForMe", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SINGLE"], age: 21 });
    const s = await loginAs(me);
    expect(names(await s.get("/api/discovery?intentions=MARRIAGE"))).toEqual(["Committed", "Far"]);
    expect(names(await s.get("/api/discovery?ageMin=32"))).toEqual(["Committed", "Far"]);
    expect(names(await s.get("/api/discovery?interests=hiking,coffee"))).toEqual(["Committed", "Explorer"]);
    expect(names(await s.get("/api/discovery?maxDistanceKm=50"))).toEqual(["Committed", "Explorer"]);
    // A filter cannot reach outside saved preferences.
    expect(names(await s.get("/api/discovery?ageMin=18&ageMax=22"))).toEqual([]);
    expect(names(await s.get("/api/discovery?intentions=SITUATIONSHIP"))).toEqual([]);
    expect((await s.get("/api/discovery?intentions=NOPE")).status).toBe(422);
  });
});
