import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { approxDistanceLabel } from "../src/lib/geo.js";
import { anon, createUser, loginAs, match, ORIGIN, resetDb } from "./helpers.js";

beforeEach(resetDb);

const names = (res: { body: { data: { items: { displayName: string }[] } } }) => res.body.data.items.map((p) => p.displayName).sort();
const hasCoordinates = (body: unknown) => /latitude|longitude|"lat"|"lon"/.test(JSON.stringify(body));

describe("Location: setting and privacy", () => {
  it("needs a session and a profile", async () => {
    expect((await anon().get("/api/location/me")).status).toBe(401);
    const u = await createUser();
    await prisma.profile.delete({ where: { userId: u.id } });
    const s = await loginAs(u);
    expect((await s.put("/api/location/me", { source: "MANUAL", placeId: "in-pune" })).status).toBe(400);
  });

  it("searches the built-in place list without returning coordinates", async () => {
    const s = await loginAs(await createUser());
    const res = await s.get("/api/location/places?q=kora");
    expect(res.body.data[0]).toMatchObject({ id: "in-koramangala", name: "Koramangala", country: "India" });
    expect(hasCoordinates(res.body)).toBe(false);
    expect((await s.get("/api/location/places?q=k")).body.data).toEqual([]);
  });

  it("saves a manual place, replacing any device position and consent", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    await s.put("/api/location/me", { source: "DEVICE", lat: 28.6139, lon: 77.209, consent: true });
    const res = await s.put("/api/location/me", { source: "MANUAL", placeId: "in-pune" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ city: "Pune", region: "Maharashtra", source: "MANUAL", hasLocation: true, deviceConsent: false });
    expect(hasCoordinates(res.body)).toBe(false);
    expect((await s.put("/api/location/me", { source: "MANUAL", placeId: "nowhere-at-all" })).status).toBe(404);
  });

  it("stores device positions only with consent, rounded to about 1 km, labelled with the nearest place", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    expect((await s.put("/api/location/me", { source: "DEVICE", lat: 12.9352, lon: 77.6245 })).status).toBe(422);
    expect((await s.put("/api/location/me", { source: "DEVICE", lat: 91, lon: 0, consent: true })).status).toBe(422);
    expect((await s.put("/api/location/me", { source: "DEVICE", lat: "12.9", lon: 77.6, consent: true })).status).toBe(422);
    const res = await s.put("/api/location/me", { source: "DEVICE", lat: 12.93526, lon: 77.62449, consent: true });
    expect(res.body.data).toMatchObject({ city: "Koramangala", source: "DEVICE", deviceConsent: true });
    const p = await prisma.profile.findUniqueOrThrow({ where: { userId: u.id } });
    expect([Number(p.latitude), Number(p.longitude)]).toEqual([12.94, 77.62]);
    // Far from any listed place: no city is invented.
    const remote = await s.put("/api/location/me", { source: "DEVICE", lat: -54.8, lon: -68.3, consent: true });
    expect(remote.body.data.city).toBeNull();
  });

  it("withdrawing deletes the stored place, coordinates and consent", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    await s.put("/api/location/me", { source: "DEVICE", lat: 19.07, lon: 72.87, consent: true });
    const res = await s.delete("/api/location/me");
    expect(res.body.data).toMatchObject({ city: null, hasLocation: false, source: null, deviceConsent: false });
    const p = await prisma.profile.findUniqueOrThrow({ where: { userId: u.id } });
    expect([p.latitude, p.longitude, p.placeId, p.locationSource, p.locationConsentAt]).toEqual([null, null, null, null, null]);
  });

  it("never exposes coordinates in public profiles, Discover, matches or chat lists", async () => {
    const a = await createUser({ name: "Asha" });
    const b = await createUser({ name: "Bilal", gender: "MAN" });
    const { sa, sb } = await match(a, b);
    await sb.put("/api/location/me", { source: "DEVICE", lat: 28.55, lon: 77.25, consent: true });
    for (const url of [`/api/profiles/${b.id}`, "/api/matches", "/api/conversations", "/api/likes/received"]) {
      expect(hasCoordinates((await sa.get(url)).body)).toBe(false);
    }
    const other = await loginAs(await createUser({ name: "Chetan", gender: "MAN" }));
    expect(hasCoordinates((await other.get("/api/discovery")).body)).toBe(false);
    expect(hasCoordinates((await sb.get("/api/location/me")).body)).toBe(false); // not even to the owner
  });

  it("limits location changes to stop someone probing another member's position", async () => {
    const s = await loginAs(await createUser());
    let status = 0;
    for (let i = 0; i < 21; i++) {
      status = (await s.agent.put("/api/location/me").set("Origin", ORIGIN).set("x-test-rate-limit", "on").send({ source: "MANUAL", placeId: "in-pune" })).status;
    }
    expect(status).toBe(429);
  });
});

describe("Location: Discover", () => {
  it("shows only coarse distance bands", () => {
    expect([1, 4.9, 7, 18, 40, 99, 300].map(approxDistanceLabel)).toEqual([
      "Within 5 km",
      "Within 5 km",
      "Around 10 km away",
      "Around 25 km away",
      "Around 50 km away",
      "Around 100 km away",
      "More than 100 km away",
    ]);
  });

  it("accepts only the offered radius choices, and the radius narrows Discover", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    await createUser({ name: "Saket", gender: "MAN", interestedIn: ["WOMAN"], lat: 28.52, lon: 77.21 }); // ~10 km
    await createUser({ name: "Gurugram", gender: "MAN", interestedIn: ["WOMAN"], lat: 28.46, lon: 77.03 }); // ~23 km
    await createUser({ name: "Mumbai", gender: "MAN", interestedIn: ["WOMAN"], lat: 19.08, lon: 72.88 });
    const s = await loginAs(me);
    expect((await s.patch("/api/location/preferences", { maxDistanceKm: 7 })).status).toBe(422);
    expect((await s.patch("/api/location/preferences", { maxDistanceKm: 25 })).body.data.maxDistanceKm).toBe(25);
    expect(names(await s.get("/api/discovery"))).toEqual(["Gurugram", "Saket"]);
    await s.patch("/api/location/preferences", { maxDistanceKm: 5 });
    expect(names(await s.get("/api/discovery"))).toEqual([]);
    await s.patch("/api/location/preferences", { maxDistanceKm: null });
    expect(names(await s.get("/api/discovery"))).toEqual(["Gurugram", "Mumbai", "Saket"]);
  });

  it("keeps working for members without a location, and skips people without one inside a radius", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"] });
    await createUser({ name: "Nearby", gender: "MAN", interestedIn: ["WOMAN"] });
    const unknown = await createUser({ name: "NoLocation", gender: "MAN", interestedIn: ["WOMAN"] });
    await prisma.profile.update({ where: { userId: unknown.id }, data: { latitude: null, longitude: null } });
    const s = await loginAs(me);
    await s.patch("/api/location/preferences", { maxDistanceKm: 10 });
    expect(names(await s.get("/api/discovery"))).toEqual(["Nearby"]);
    await s.delete("/api/location/me");
    const res = await s.get("/api/discovery");
    expect(names(res)).toEqual(["Nearby", "NoLocation"]);
    expect(res.body.data.items.every((p: { distance: string | null }) => p.distance === null)).toBe(true);
  });

  it("still respects blocks, intentions and hidden distance", async () => {
    const me = await createUser({ name: "Me", gender: "WOMAN", interestedIn: ["MAN"], intentions: ["MARRIAGE"], sought: ["MARRIAGE"] });
    const blocked = await createUser({ name: "Blocked", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE"] });
    await createUser({ name: "Casual", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SITUATIONSHIP"] });
    const shy = await createUser({ name: "Shy", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["MARRIAGE"] });
    const s = await loginAs(me);
    await s.post("/api/safety/blocks", { userId: blocked.id });
    await (await loginAs(shy)).patch("/api/location/preferences", { showDistance: false });
    await s.patch("/api/location/preferences", { maxDistanceKm: 5 });
    const res = await s.get("/api/discovery");
    expect(names(res)).toEqual(["Shy"]);
    expect(res.body.data.items[0].distance).toBeNull();
  });
});
