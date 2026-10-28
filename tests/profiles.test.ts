import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import { stripMetadata, detectImageType } from "../src/lib/images.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

beforeEach(resetDb);

// Smallest valid PNG (1x1) plus a tEXt chunk that must be stripped.
function pngWithText() {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("GPS\x0028.6139,77.2090")),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("profile editing and validation", () => {
  it("validates fields and age ranges", async () => {
    const s = await loginAs(await createUser());
    const res = await s.patch("/api/profiles/me", { bio: "x".repeat(501), ageMin: 30, ageMax: 25 });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty("bio");
    const res2 = await s.patch("/api/profiles/me", { ageMin: 17 });
    expect(res2.status).toBe(422);
  });

  it("updates intentions and interests and rounds browser location", async () => {
    const s = await loginAs(await createUser());
    const res = await s.patch("/api/profiles/me", {
      intentions: ["MARRIAGE", "SINGLE"],
      interests: ["coffee", "hiking"],
      approxLocation: { lat: 28.613912, lon: 77.209023 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.intentions.sort()).toEqual(["MARRIAGE", "SINGLE"]);
    expect(res.body.data.interests.sort()).toEqual(["coffee", "hiking"]);
    const p = await prisma.profile.findFirstOrThrow({ where: { displayName: { startsWith: "Member" } } });
    expect(Number(p.latitude)).toBe(28.61);
    expect(Number(p.longitude)).toBe(77.21);
  });

  it("rejects unknown interests", async () => {
    const s = await loginAs(await createUser());
    expect((await s.patch("/api/profiles/me", { interests: ["not-a-thing"] })).status).toBe(400);
  });

  it("will not publish a profile without a photo", async () => {
    const u = await createUser({ published: false });
    await prisma.profilePhoto.deleteMany({ where: { userId: u.id } });
    const s = await loginAs(u);
    const res = await s.post("/api/profiles/me/publish");
    expect(res.status).toBe(400);
    expect(res.body.error.details.missing).toContain("at least one photo");
  });
});

describe("photo uploads", () => {
  it("accepts real images, strips metadata, and stores only a reference", async () => {
    const s = await loginAs(await createUser());
    const res = await s.agent.post("/api/profiles/me/photos").set("Origin", "http://localhost:5180").attach("photo", pngWithText(), "me.png");
    expect(res.status).toBe(201);
    const photo = await prisma.profilePhoto.findUniqueOrThrow({ where: { id: res.body.data.id } });
    const stored = fs.readFileSync(path.join(process.env.UPLOAD_DIR!, photo.storageKey));
    expect(stored.includes(Buffer.from("tEXt"))).toBe(false);
    expect(detectImageType(stored)).toBe("image/png");
  });

  it("rejects files that are not images regardless of filename", async () => {
    const s = await loginAs(await createUser());
    const res = await s.agent.post("/api/profiles/me/photos").set("Origin", "http://localhost:5180").attach("photo", Buffer.from("<script>alert(1)</script>"), "cat.jpg");
    expect(res.status).toBe(400);
  });

  it("strips EXIF (APP1) from JPEGs", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1, 0x00, 0x08]),
      Buffer.from("Exif\0\0"),
      Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
    ]);
    const clean = stripMetadata(jpeg, "image/jpeg");
    expect(clean.includes(Buffer.from("Exif"))).toBe(false);
    expect(clean.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});

describe("public profile view", () => {
  it("never exposes email, date of birth or coordinates", async () => {
    const a = await createUser();
    const b = await createUser({ name: "Visible" });
    const s = await loginAs(a);
    const res = await s.get(`/api/profiles/${b.id}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(b.email);
    expect(text).not.toMatch(/dateOfBirth|latitude|longitude|passwordHash/);
    expect(res.body.data.age).toBe(28);
  });

  it("hides profiles between blocked users", async () => {
    const a = await createUser();
    const b = await createUser();
    await prisma.block.create({ data: { blockerId: b.id, blockedId: a.id } });
    const s = await loginAs(a);
    expect((await s.get(`/api/profiles/${b.id}`)).status).toBe(404);
  });
});
