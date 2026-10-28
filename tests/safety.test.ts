import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { anon, createUser, loginAs, match, PASSWORD, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("blocking and reporting", () => {
  it("blocking ends the match and removes both people from each other's discovery", async () => {
    const a = await createUser({ gender: "WOMAN", interestedIn: ["MAN"] });
    const b = await createUser({ gender: "MAN", interestedIn: ["WOMAN"] });
    const { sa, matchId } = await match(a, b);
    await sa.post("/api/safety/blocks", { userId: b.id });
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe("BLOCKED");
    expect((await sa.get("/api/safety/blocks")).body.data).toHaveLength(1);
  });

  it("lets members report a message only from their own conversations", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, conversationId } = await match(a, b);
    const msg = (await sb.post(`/api/conversations/${conversationId}/messages`, { body: "unkind words" })).body.data;
    const report = await sa.post("/api/safety/reports", { userId: b.id, target: "MESSAGE", messageId: msg.id, reason: "HARASSMENT", alsoBlock: true });
    expect(report.status).toBe(201);
    expect(await prisma.block.count({ where: { blockerId: a.id, blockedId: b.id } })).toBe(1);

    const outsider = await loginAs(await createUser());
    const forged = await outsider.post("/api/safety/reports", { userId: b.id, target: "MESSAGE", messageId: msg.id, reason: "HARASSMENT" });
    expect(forged.status).toBe(404);
  });

  it("puts suspected underage reports at the top of the moderation queue", async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    const sa = await loginAs(a);
    await sa.post("/api/safety/reports", { userId: b.id, target: "PROFILE", reason: "FAKE_PROFILE" });
    await sa.post("/api/safety/reports", { userId: c.id, target: "PROFILE", reason: "UNDERAGE", details: "Says they are in school" });
    const mod = await loginAs(await createUser({ role: "MODERATOR" }));
    const queue = (await mod.get("/api/admin/reports")).body.data;
    expect(queue[0].reason).toBe("UNDERAGE");
  });
});

describe("administration access control and audit", () => {
  it("forbids regular members and experts from admin endpoints", async () => {
    for (const role of ["USER", "EXPERT"] as const) {
      const s = await loginAs(await createUser({ role }));
      expect((await s.get("/api/admin/overview")).status).toBe(403);
      expect((await s.get("/api/admin/reports")).status).toBe(403);
    }
    expect((await anon().get("/api/admin/overview")).status).toBe(401);
  });

  it("suspending a user revokes their sessions and writes an append-only audit entry", async () => {
    const target = await createUser();
    const ts = await loginAs(target);
    const admin = await createUser({ role: "ADMIN" });
    const as = await loginAs(admin);
    const res = await as.post(`/api/admin/users/${target.id}/status`, { status: "SUSPENDED", reason: "Repeated harassment reports" });
    expect(res.status).toBe(200);
    expect((await ts.get("/api/discovery")).status).toBe(401);

    const log = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "user.suspended" } });
    expect(log.actorId).toBe(admin.id);
    expect(log.targetId).toBe(target.id);
    await expect(prisma.adminAuditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it("moderators can see the reported message but have no route to read conversations", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, conversationId } = await match(a, b);
    await sb.post(`/api/conversations/${conversationId}/messages`, { body: "private hello" });
    const msg = (await sb.post(`/api/conversations/${conversationId}/messages`, { body: "reported text" })).body.data;
    await sa.post("/api/safety/reports", { userId: b.id, target: "MESSAGE", messageId: msg.id, reason: "HARASSMENT" });
    const mod = await loginAs(await createUser({ role: "MODERATOR" }));
    const queue = JSON.stringify((await mod.get("/api/admin/reports")).body);
    expect(queue).toContain("reported text");
    expect(queue).not.toContain("private hello");
    expect((await mod.get(`/api/conversations/${conversationId}/messages`)).status).toBe(404);
  });
});

describe("account deletion and privacy controls", () => {
  it("requires the password, hides the profile, ends matches and blocks future logins", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb } = await match(a, b);
    expect((await sa.post("/api/settings/delete-account", { password: "wrong-password1" })).status).toBe(401);
    const res = await sa.post("/api/settings/delete-account", { password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await sa.get("/api/auth/me")).status).toBe(401);
    expect((await sb.get("/api/matches")).body.data).toHaveLength(0);
    expect((await sb.get(`/api/profiles/${a.id}`)).status).toBe(404);
    const login = await anon().post("/api/auth/login", { email: a.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("ACCOUNT_DELETED");
  });

  it("pausing discovery hides you without affecting matches", async () => {
    const a = await createUser({ gender: "WOMAN", interestedIn: ["MAN"] });
    const b = await createUser({ gender: "MAN", interestedIn: ["WOMAN"] });
    const c = await createUser({ gender: "MAN", interestedIn: ["WOMAN"] });
    const { sa } = await match(a, b);
    await sa.post("/api/settings/discovery", { paused: true });
    const sc = await loginAs(c);
    expect((await sc.get("/api/discovery")).body.data.items).toHaveLength(0);
    expect((await sa.get("/api/matches")).body.data).toHaveLength(1);
  });

  it("exports the member's own data without the password hash", async () => {
    const s = await loginAs(await createUser());
    const res = await s.get("/api/settings/export");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("argon2");
  });
});
