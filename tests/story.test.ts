import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("profile prompts", () => {
  it("saves chosen prompts in order and shows them on the public profile", async () => {
    const a = await createUser({ name: "Asha" });
    const sa = await loginAs(a);
    const res = await sa.put("/api/profiles/me/prompts", {
      prompts: [
        { key: "ideal_sunday", answer: "  Long drive, coffee and absolutely no plans.  " },
        { key: "green_flag", answer: "Saying sorry without a 'but'." },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.prompts.map((p: { key: string }) => p.key)).toEqual(["ideal_sunday", "green_flag"]);
    expect(res.body.data.prompts[0].answer).toBe("Long drive, coffee and absolutely no plans.");

    const viewer = await loginAs(await createUser());
    const pub = (await viewer.get(`/api/profiles/${a.id}`)).body.data;
    expect(pub.prompts[0]).toEqual({ key: "ideal_sunday", text: "My ideal Sunday looks like…", answer: "Long drive, coffee and absolutely no plans." });
    expect(pub).not.toHaveProperty("dateOfBirth");
  });

  it("rejects unknown, duplicate, empty, too-long and too-many prompts", async () => {
    const sa = await loginAs(await createUser());
    const put = (prompts: object[]) => sa.put("/api/profiles/me/prompts", { prompts });
    expect((await put([{ key: "not_a_prompt", answer: "hi" }])).status).toBe(400);
    expect((await put([{ key: "green_flag", answer: "a" }, { key: "green_flag", answer: "b" }])).status).toBe(400);
    expect((await put([{ key: "green_flag", answer: "   " }])).status).toBe(422);
    expect((await put([{ key: "green_flag", answer: "x".repeat(251) }])).status).toBe(422);
    const seven = ["makes_my_day", "ideal_sunday", "get_me_talking", "talk_for_hours", "green_flag", "memory_smile", "first_date"].map((key) => ({ key, answer: "Yes" }));
    expect((await put(seven)).status).toBe(422);
  });

  it("lists the curated prompt catalogue", async () => {
    const sa = await loginAs(await createUser());
    const prompts = (await sa.get("/api/meta/prompts")).body.data;
    expect(prompts.length).toBeGreaterThanOrEqual(8);
    expect(prompts[0]).toHaveProperty("ideas");
  });
});

describe("photo framing", () => {
  it("stores a focal point for your own photos only", async () => {
    const a = await createUser();
    const sa = await loginAs(a);
    const photo = await prisma.profilePhoto.findFirstOrThrow({ where: { userId: a.id } });
    expect((await sa.patch(`/api/profiles/me/photos/${photo.id}`, { focusX: 30, focusY: 20 })).status).toBe(200);
    expect(await prisma.profilePhoto.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ focusX: 30, focusY: 20 });
    expect((await sa.patch(`/api/profiles/me/photos/${photo.id}`, { focusX: 130, focusY: 20 })).status).toBe(422);

    const other = await loginAs(await createUser());
    expect((await other.patch(`/api/profiles/me/photos/${photo.id}`, { focusX: 10, focusY: 10 })).status).toBe(404);
    const pub = (await other.get(`/api/profiles/${a.id}`)).body.data;
    expect(pub.photos[0]).toEqual({ id: photo.id, focusX: 30, focusY: 20, caption: null });
  });
});

describe("Start with a detail", () => {
  async function pair() {
    const a = await createUser({ name: "Asha", interests: ["coffee"] });
    const b = await createUser({ name: "Bilal", interests: ["hiking"] });
    const sb = await loginAs(b);
    await sb.put("/api/profiles/me/prompts", { prompts: [{ key: "ideal_sunday", answer: "A long drive, coffee and absolutely no plans." }] });
    return { a, b, sa: await loginAs(a), sb };
  }

  it("records a like that responds to a real prompt, shown to the recipient with the note", async () => {
    const { a, b, sa, sb } = await pair();
    const res = await sa.post("/api/likes", { userId: b.id, detail: { kind: "PROMPT", ref: "ideal_sunday", comment: "Where would the drive go?" } });
    expect(res.status).toBe(201);
    expect(res.body.data.matched).toBe(false);
    // No conversation exists before a match: the note is only visible as part of the like.
    expect(await prisma.message.count()).toBe(0);
    const received = (await sb.get("/api/likes/received")).body.data;
    expect(received[0]).toMatchObject({ comment: "Where would the drive go?", detail: { kind: "PROMPT", label: "My ideal Sunday looks like…", quote: "A long drive, coffee and absolutely no plans." } });
    expect(received[0].profile.id).toBe(a.id);
  });

  it("rejects details that aren't on the other person's profile", async () => {
    const { b, sa } = await pair();
    expect((await sa.post("/api/likes", { userId: b.id, detail: { kind: "PROMPT", ref: "green_flag", comment: "Hi" } })).status).toBe(400);
    expect((await sa.post("/api/likes", { userId: b.id, detail: { kind: "INTEREST", ref: "coffee" } })).status).toBe(400);
    expect((await sa.post("/api/likes", { userId: b.id, detail: { kind: "INTEREST", ref: "hiking" } })).status).toBe(201);
  });

  it("turns the note into the first message, quoting the detail, once you match", async () => {
    const { a, b, sa, sb } = await pair();
    await sa.post("/api/likes", { userId: b.id, detail: { kind: "PROMPT", ref: "ideal_sunday", comment: "Where would the drive go?" } });
    const res = await sb.post("/api/likes", { userId: a.id });
    expect(res.body.data.matched).toBe(true);
    const convo = await prisma.conversation.findFirstOrThrow({ where: { matchId: res.body.data.matchId } });
    const msgs = (await sb.get(`/api/conversations/${convo.id}/messages`)).body.data.items;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ senderId: a.id, body: "Where would the drive go?", metadata: { detail: { kind: "PROMPT", quote: "A long drive, coffee and absolutely no plans." } } });
  });
});
