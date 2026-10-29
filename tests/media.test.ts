import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";
import { createUser, loginAs, ORIGIN, resetDb } from "./helpers.js";

beforeEach(resetDb);

type Session = Awaited<ReturnType<typeof loginAs>>;
const fixture = (f: string) => path.join(import.meta.dirname, "fixtures", f);

const uploadPhoto = (s: Session, file = "poster.jpg") => s.agent.post("/api/profiles/me/photos").set("Origin", ORIGIN).attach("photo", fixture(file));
const uploadVideo = (s: Session, file = "clip.mp4", poster: string | null = "poster.jpg") => {
  const r = s.agent.post("/api/profiles/me/videos").set("Origin", ORIGIN).attach("video", fixture(file));
  return poster ? r.attach("poster", fixture(poster)) : r;
};
const caption = (s: Session, id: string, text: string | null) => s.patch(`/api/profiles/me/photos/${id}`, { caption: text });
const publicMedia = async (viewer: Session, ownerId: string) => (await viewer.get(`/api/profiles/${ownerId}`)).body.data;

/** A member with no seeded photos, so every item comes from a real upload. */
async function freshMember() {
  const u = await createUser({ name: "Asha" });
  await prisma.profilePhoto.deleteMany({ where: { userId: u.id } });
  return { u, s: await loginAs(u) };
}

describe("photo captions", () => {
  it("stores a different caption on each photo and keeps it with that photo when reordered", async () => {
    const { u, s } = await freshMember();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await uploadPhoto(s)).body.data.id);
    await caption(s, ids[0], "My favourite sunset.");
    await caption(s, ids[1], "  A little memory\nfrom my Goa trip.  ");
    // The third photo has no caption: captions are optional.

    expect((await s.put("/api/profiles/me/photos/order", { ids: [ids[2], ids[0], ids[1]] })).status).toBe(200);
    const viewer = await loginAs(await createUser());
    const media = (await publicMedia(viewer, u.id)).media;
    expect(media.map((m: { id: string }) => m.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(media.map((m: { caption: string | null }) => m.caption)).toEqual([null, "My favourite sunset.", "A little memory from my Goa trip."]);
  });

  it("validates, edits and clears captions; only the owner can change them", async () => {
    const { s } = await freshMember();
    const id = (await uploadPhoto(s)).body.data.id;
    expect((await caption(s, id, "x".repeat(201))).status).toBe(400);
    expect((await caption(s, id, "x".repeat(200))).body.data.caption).toHaveLength(200);
    expect((await caption(s, id, "Proof that I will always stop to pet a dog.")).body.data.caption).toBe("Proof that I will always stop to pet a dog.");
    expect((await caption(s, id, "   ")).body.data.caption).toBeNull();
    expect((await caption(s, id, null)).body.data.caption).toBeNull();
    expect((await s.patch(`/api/profiles/me/photos/${id}`, { caption: "ok", isPrimary: true })).status).toBe(422); // unknown fields rejected

    const other = await loginAs(await createUser());
    expect((await caption(other, id, "Not yours")).status).toBe(404);
    expect((await other.delete(`/api/profiles/me/photos/${id}`)).status).toBe(404);
    expect(await prisma.profilePhoto.count({ where: { id } })).toBe(1);
  });
});

describe("primary photo", () => {
  it("is chosen separately from order, is always a photo, and moves on when deleted", async () => {
    const { u, s } = await freshMember();
    const a = (await uploadPhoto(s)).body.data;
    const b = (await uploadPhoto(s)).body.data;
    const v = (await uploadVideo(s)).body.data;
    expect(a.isPrimary).toBe(true); // the first photo becomes primary automatically
    expect(b.isPrimary).toBe(false);

    // Put the video first in the gallery and make the second photo primary.
    await s.put("/api/profiles/me/photos/order", { ids: [v.id, a.id, b.id] });
    expect((await s.put(`/api/profiles/me/photos/${b.id}/primary`)).status).toBe(200);
    expect((await s.put(`/api/profiles/me/photos/${v.id}/primary`)).status).toBe(400);

    const viewer = await loginAs(await createUser());
    const pub = await publicMedia(viewer, u.id);
    expect(pub.photoIds).toEqual([b.id, a.id]); // avatars and cards use the primary photo, never the video
    expect(pub.media.map((m: { id: string }) => m.id)).toEqual([v.id, a.id, b.id]); // the gallery keeps the chosen order
    expect((await s.get("/api/auth/me")).body.data.avatarPhotoId).toBe(b.id);

    await s.delete(`/api/profiles/me/photos/${b.id}`);
    expect((await prisma.profilePhoto.findUniqueOrThrow({ where: { id: a.id } })).isPrimary).toBe(true);
    expect((await prisma.profilePhoto.findMany({ where: { userId: u.id }, orderBy: { position: "asc" } })).map((m) => m.position)).toEqual([0, 1]);
  });

  it("keeps existing (pre-migration) photos working: the first photo stands in as primary", async () => {
    const u = await createUser({ name: "Legacy" }); // seeded photo has isPrimary = false, like rows before the migration
    const legacy = await prisma.profilePhoto.findFirstOrThrow({ where: { userId: u.id } });
    const pub = await publicMedia(await loginAs(await createUser()), u.id);
    expect(pub.photoIds).toEqual([legacy.id]);
    expect(pub.media).toEqual([expect.objectContaining({ id: legacy.id, kind: "IMAGE", caption: null })]);
  });
});

describe("videos", () => {
  it("accepts an MP4 with a poster, reads its length, removes location metadata and streams it with Range", async () => {
    const { u, s } = await freshMember();
    const res = await uploadVideo(s);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: "VIDEO", durationMs: 2000, hasPoster: true, isPrimary: false });
    const row = await prisma.profilePhoto.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.mimeType).toBe("video/mp4");
    const stored = fs.readFileSync(path.join(config.uploadDir, row.storageKey));
    expect(stored.includes(Buffer.from("37.7749"))).toBe(false);
    expect(stored.includes(Buffer.from("Audit test clip"))).toBe(false);

    const viewer = await loginAs(await createUser());
    const ranged = await viewer.agent.get(`/api/photos/${row.id}`).set("Range", "bytes=0-99");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-type"]).toBe("video/mp4");
    expect(Number(ranged.headers["content-length"])).toBe(100);
    const poster = await viewer.agent.get(`/api/photos/${row.id}/poster`);
    expect(poster.status).toBe(200);
    expect(poster.headers["content-type"]).toBe("image/jpeg");
    expect((await publicMedia(viewer, u.id)).media[0]).toMatchObject({ id: row.id, kind: "VIDEO", hasPoster: true, durationMs: 2000 });
  });

  it("accepts WebM, and videos without a poster", async () => {
    const { s } = await freshMember();
    const res = await uploadVideo(s, "clip.webm", null);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: "VIDEO", durationMs: 2000, hasPoster: false });
  });

  it("rejects videos that are too long, too large, not really videos, or over the count limit", async () => {
    const { s } = await freshMember();
    const long = await uploadVideo(s, "long.mp4");
    expect(long.status).toBe(400);
    expect(long.body.error.message).toMatch(/up to 30 seconds/);
    const fake = await uploadVideo(s, "poster.jpg"); // a JPEG named as a video
    expect(fake.status).toBe(400);
    expect(fake.body.error.message).toMatch(/MP4 or WebM/);
    const big = await s.agent
      .post("/api/profiles/me/videos")
      .set("Origin", ORIGIN)
      .attach("video", Buffer.concat([fs.readFileSync(fixture("clip.mp4")), Buffer.alloc(1.2 * 1024 * 1024)]), "big.mp4");
    expect(big.status).toBe(400);
    expect(big.body.error.message).toMatch(/up to 1 MB/);
    const badPoster = await uploadVideo(s, "clip.mp4", "clip.webm");
    expect(badPoster.status).toBe(400);
    expect(await prisma.profilePhoto.count({ where: { kind: "VIDEO" } })).toBe(0);
    // Nothing is left behind in the incoming folder after rejected uploads.
    expect(fs.readdirSync(path.join(config.uploadDir, ".incoming"))).toEqual([]);

    expect((await uploadVideo(s)).status).toBe(201);
    expect((await uploadVideo(s)).status).toBe(201);
    expect((await uploadVideo(s)).status).toBe(400); // two videos maximum
  });

  it("replaces a video in place (keeping caption and position) and deletes old and removed files", async () => {
    const { s } = await freshMember();
    await uploadPhoto(s);
    const v = (await uploadVideo(s)).body.data;
    await caption(s, v.id, "My happy place, every single time.");
    const before = await prisma.profilePhoto.findUniqueOrThrow({ where: { id: v.id } });

    const replaced = await s.agent.post(`/api/profiles/me/photos/${v.id}/replace`).set("Origin", ORIGIN).attach("video", fixture("clip.webm"));
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toMatchObject({ id: v.id, caption: "My happy place, every single time.", position: 1, hasPoster: false });
    const after = await prisma.profilePhoto.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.mimeType).toBe("video/webm");
    expect(fs.existsSync(path.join(config.uploadDir, before.storageKey))).toBe(false);
    expect(fs.existsSync(path.join(config.uploadDir, before.posterKey!))).toBe(false);

    await s.delete(`/api/profiles/me/photos/${v.id}`);
    expect(fs.existsSync(path.join(config.uploadDir, after.storageKey))).toBe(false);
    expect(await prisma.profilePhoto.count({ where: { id: v.id } })).toBe(0);
  });
});

describe("who can see media", () => {
  it("hides rejected items, unpublished profiles and blocked members; owners and staff still see them", async () => {
    const { u, s } = await freshMember();
    const p = (await uploadPhoto(s)).body.data;
    const v = (await uploadVideo(s)).body.data;
    const viewerUser = await createUser();
    const viewer = await loginAs(viewerUser);
    expect((await viewer.agent.get(`/api/photos/${v.id}/poster`)).status).toBe(200);

    await prisma.profilePhoto.update({ where: { id: v.id }, data: { status: "REJECTED" } });
    expect((await viewer.agent.get(`/api/photos/${v.id}`)).status).toBe(404);
    expect((await publicMedia(viewer, u.id)).media.map((m: { id: string }) => m.id)).toEqual([p.id]);
    expect((await s.agent.get(`/api/photos/${v.id}`)).status).toBe(200); // the owner still sees it
    const mod = await loginAs(await createUser({ role: "MODERATOR" }));
    expect((await mod.agent.get(`/api/photos/${v.id}`)).status).toBe(200);

    await prisma.profile.update({ where: { userId: u.id }, data: { isPublished: false } });
    expect((await viewer.agent.get(`/api/photos/${p.id}`)).status).toBe(404);
    await prisma.profile.update({ where: { userId: u.id }, data: { isPublished: true } });
    await s.post("/api/safety/blocks", { userId: viewerUser.id });
    expect((await viewer.agent.get(`/api/photos/${p.id}`)).status).toBe(404);
  });
});

describe("liking a specific photo or video", () => {
  it("sends a like about one gallery item, quoting its caption, which becomes the first message on a match", async () => {
    const { u, s } = await freshMember();
    const p = (await uploadPhoto(s)).body.data;
    await caption(s, p.id, "A little memory from my Goa trip.");
    const fan = await createUser({ name: "Bilal" });
    const sf = await loginAs(fan);

    const someoneElses = (await prisma.profilePhoto.findFirstOrThrow({ where: { userId: fan.id } })).id;
    expect((await sf.post("/api/likes", { userId: u.id, detail: { kind: "MEDIA", ref: someoneElses } })).status).toBe(400);
    expect((await sf.post("/api/likes", { userId: u.id, detail: { kind: "MEDIA", ref: p.id, comment: "Which beach?" } })).status).toBe(201);

    const received = (await s.get("/api/likes/received")).body.data[0];
    expect(received).toMatchObject({ comment: "Which beach?", detail: { kind: "MEDIA", label: "Photo", quote: "A little memory from my Goa trip.", mediaId: p.id } });

    const res = await s.post("/api/likes", { userId: fan.id });
    expect(res.body.data.matched).toBe(true);
    const convo = await prisma.conversation.findFirstOrThrow({ where: { matchId: res.body.data.matchId } });
    const first = (await s.get(`/api/conversations/${convo.id}/messages`)).body.data.items[0];
    expect(first).toMatchObject({ body: "Which beach?", metadata: { detail: { kind: "MEDIA", mediaId: p.id } } });
  });

  it("refuses a like about media that has since been rejected", async () => {
    const a = await createUser();
    const b = await createUser();
    const item = await prisma.profilePhoto.findFirstOrThrow({ where: { userId: b.id } });
    await prisma.profilePhoto.update({ where: { id: item.id }, data: { status: "REJECTED" } });
    expect((await (await loginAs(a)).post("/api/likes", { userId: b.id, detail: { kind: "MEDIA", ref: item.id } })).status).toBe(400);
  });
});
