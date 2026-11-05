import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, SignJWT } from "jose";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";
import { sha256, randomToken } from "../src/lib/crypto.js";
import { signingKeyForTests } from "../src/lib/jwt.js";
import { createSocketServer } from "../src/realtime/socket.js";
import { setIo } from "../src/realtime/bus.js";
import { app, createUser, loginAs, match, ORIGIN, PASSWORD, resetDb } from "./helpers.js";

beforeEach(resetDb);

const cookieValue = (res: request.Response, name: string) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const webLogin = async (email: string) => {
  const res = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email, password: PASSWORD });
  return { res, access: cookieValue(res, "mv_access")!, refresh: cookieValue(res, "mv_refresh")! };
};
const mobileLogin = async (email: string) => (await request(app).post("/api/auth/mobile/login").send({ email, password: PASSWORD, deviceName: "Test phone" })).body.data;
const me = (access: string, via: "cookie" | "bearer" = "cookie") =>
  via === "cookie" ? request(app).get("/api/auth/me").set("Cookie", `mv_access=${access}`) : request(app).get("/api/auth/me").set("Authorization", `Bearer ${access}`);
const webRefresh = (refresh: string) => request(app).post("/api/auth/refresh").set("Origin", ORIGIN).set("Cookie", `mv_refresh=${refresh}`);
const mobileRefresh = (refreshToken: string) => request(app).post("/api/auth/mobile/refresh").send({ refreshToken });

/** Signs a token with chosen claims and key, to probe verification. */
async function forge(claims: { sub: string; sid: string }, opts: { key?: ReturnType<typeof generateKeyPairSync>["privateKey"]; iss?: string; aud?: string; expSeconds?: number; iatOffset?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(opts.iss ?? config.auth.issuer)
    .setAudience(opts.aud ?? "mavelle-web")
    .setIssuedAt(now + (opts.iatOffset ?? 0))
    .setExpirationTime(now + (opts.expSeconds ?? 600))
    .setJti("test-jti")
    .sign(opts.key ?? signingKeyForTests()!);
}

describe("access tokens", () => {
  it("carry only ids and expire after 15 minutes", async () => {
    const u = await createUser();
    const { access } = await webLogin(u.email);
    const claims = decodeJwt(access);
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sid", "sub"]);
    expect(claims.sub).toBe(u.id);
    expect(claims.aud).toBe("mavelle-web");
    expect(claims.exp! - claims.iat!).toBe(15 * 60);
    expect(JSON.stringify(claims)).not.toContain(u.email);
  });

  it("are refused when missing, forged, expired, for another issuer or audience, tampered or unsigned", async () => {
    const u = await createUser();
    const { access } = await webLogin(u.email);
    const { sid } = decodeJwt(access) as { sid: string };
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await me(access)).status).toBe(200);

    const otherKey = generateKeyPairSync("ed25519").privateKey;
    expect((await me(await forge({ sub: u.id, sid }, { key: otherKey }))).status).toBe(401); // wrong signature
    expect((await me(await forge({ sub: u.id, sid }, { expSeconds: -60, iatOffset: -1000 }))).status).toBe(401); // expired
    expect((await me(await forge({ sub: u.id, sid }, { iss: "someone-else" }))).status).toBe(401);
    expect((await me(await forge({ sub: u.id, sid }, { aud: "mavelle-mobile" }))).status).toBe(401); // mobile token in a web cookie
    expect((await me(access, "bearer")).status).toBe(401); // web token as a mobile bearer
    expect((await me(await forge({ sub: u.id, sid }))).status).toBe(200); // control: a correct token works

    // Tampered payload: swap the subject, keep the signature.
    const other = await createUser();
    const [h, p, sig] = access.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...payload, sub: other.id })).toString("base64url")}.${sig}`;
    expect((await me(tampered)).status).toBe(401);
    // A valid signature naming someone else's session is refused too.
    expect((await me(await forge({ sub: other.id, sid }))).status).toBe(401);
    // alg "none".
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    expect((await me(none)).status).toBe(401);
  });

  it("stop working the moment their session is revoked", async () => {
    const u = await createUser();
    const { access } = await webLogin(u.email);
    const { sid } = decodeJwt(access) as { sid: string };
    await prisma.session.update({ where: { id: sid }, data: { revokedAt: new Date() } });
    expect((await me(access)).status).toBe(401);
  });
});

describe("refresh tokens (web)", () => {
  it("rotate on every use, with HttpOnly cookies scoped to /api/auth", async () => {
    const u = await createUser();
    const { res, refresh } = await webLogin(u.email);
    const set = ([] as string[]).concat(res.headers["set-cookie"]).join("\n");
    expect(set).toMatch(/mv_refresh=[^;]+;.*Path=\/api\/auth;.*HttpOnly;.*SameSite=Strict/);
    expect(set).toMatch(/mv_access=[^;]+;.*Path=\/;.*HttpOnly;.*SameSite=Lax/);
    const r = await webRefresh(refresh);
    expect(r.status).toBe(200);
    const next = cookieValue(r, "mv_refresh")!;
    expect(next).not.toBe(refresh);
    expect((await me(cookieValue(r, "mv_access")!)).status).toBe(200);
    // Only hashes are stored.
    const s = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
    expect([s.refreshHash, s.previousRefreshHash]).toEqual([sha256(next), sha256(refresh)]);
  });

  it("lets racing tabs share a refresh without breaking the session", async () => {
    const u = await createUser();
    const { refresh } = await webLogin(u.email);
    const results = await Promise.all(Array.from({ length: 5 }, () => webRefresh(refresh)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => cookieValue(r, "mv_refresh")).length).toBe(1); // rotated exactly once
    const s = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
    expect(s.revokedAt).toBeNull();
  });

  it("closes the whole session when an old refresh token is replayed, and logs it", async () => {
    const u = await createUser();
    const { refresh } = await webLogin(u.email);
    const r = await webRefresh(refresh);
    const current = cookieValue(r, "mv_refresh")!;
    // Past the grace window, the previous token can only be a copy.
    await prisma.session.updateMany({ where: { userId: u.id }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    expect((await webRefresh(refresh)).status).toBe(401);
    expect((await webRefresh(current)).status).toBe(401); // the legitimate holder is signed out too
    const s = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
    expect(s.revokedReason).toBe("REFRESH_REUSE");
    expect(await prisma.securityEvent.count({ where: { userId: u.id, type: "REFRESH_REUSE_DETECTED" } })).toBe(1);
  });

  it("refuses unknown, expired, idle and revoked refresh tokens", async () => {
    const u = await createUser();
    expect((await webRefresh(randomToken())).status).toBe(401);
    const { refresh } = await webLogin(u.email);
    await prisma.session.updateMany({ where: { userId: u.id }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await webRefresh(refresh)).status).toBe(401);
    const second = await webLogin(u.email);
    await prisma.session.updateMany({ where: { userId: u.id, refreshHash: sha256(second.refresh) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await webRefresh(second.refresh)).status).toBe(401);
    const third = await webLogin(u.email);
    await request(app).post("/api/auth/logout").set("Origin", ORIGIN).set("Cookie", `mv_access=${third.access}`);
    expect((await webRefresh(third.refresh)).status).toBe(401);
  });

  it("needs our own origin (CSRF) and won't refresh a suspended account", async () => {
    const u = await createUser();
    const { refresh } = await webLogin(u.email);
    expect((await request(app).post("/api/auth/refresh").set("Origin", "https://evil.example").set("Cookie", `mv_refresh=${refresh}`)).status).toBe(403);
    await prisma.user.update({ where: { id: u.id }, data: { status: "BANNED" } });
    expect((await webRefresh(refresh)).status).toBe(401);
  });
});

describe("mobile tokens", () => {
  it("sign in, call the API with a bearer token, refresh with rotation and sign out, without cookies or an Origin", async () => {
    const u = await createUser();
    const login = await request(app).post("/api/auth/mobile/login").send({ email: u.email, password: PASSWORD, deviceName: "Pixel" });
    expect(login.status).toBe(200);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const t = login.body.data;
    expect(t).toMatchObject({ tokenType: "Bearer", expiresIn: 900, account: { id: u.id } });
    expect(decodeJwt(t.accessToken).aud).toBe("mavelle-mobile");
    expect((await me(t.accessToken, "bearer")).status).toBe(200);
    expect((await me(t.accessToken, "cookie")).status).toBe(401); // a mobile token isn't a web cookie

    // Writes work with a bearer token and no Origin header (native apps have none).
    const other = await createUser({ gender: "MAN" });
    expect((await request(app).post("/api/likes").set("Authorization", `Bearer ${t.accessToken}`).send({ userId: other.id })).status).toBe(201);
    // But a bearer request that also carries cookies must pass the origin check.
    expect((await request(app).post("/api/likes/pass").set("Authorization", `Bearer ${t.accessToken}`).set("Cookie", "x=1").send({ userId: other.id })).status).toBe(403);

    const r = (await mobileRefresh(t.refreshToken)).body.data;
    expect(r.refreshToken).not.toBe(t.refreshToken);
    const out = await request(app).post("/api/auth/mobile/logout").set("Authorization", `Bearer ${r.accessToken}`).send({});
    expect(out.status).toBe(200);
    expect((await me(r.accessToken, "bearer")).status).toBe(401);
    expect((await mobileRefresh(r.refreshToken)).status).toBe(401);
  });

  it("has no grace window: replaying a refresh token closes that device only", async () => {
    const u = await createUser();
    const phone = await mobileLogin(u.email);
    const laptop = await webLogin(u.email);
    expect((await mobileRefresh(phone.refreshToken)).status).toBe(200);
    expect((await mobileRefresh(phone.refreshToken)).status).toBe(401);
    expect((await me(laptop.access)).status).toBe(200); // another device is untouched
    expect((await prisma.session.findFirstOrThrow({ where: { userId: u.id, client: "MOBILE" } })).revokedReason).toBe("REFRESH_REUSE");
  });
});

describe("signing out", () => {
  it("one device, or every device after re-entering the password", async () => {
    const u = await createUser();
    const a = await webLogin(u.email);
    const b = await webLogin(u.email);
    const phone = await mobileLogin(u.email);
    await request(app).post("/api/auth/logout").set("Origin", ORIGIN).set("Cookie", `mv_access=${a.access}`);
    expect((await me(a.access)).status).toBe(401);
    expect((await me(b.access)).status).toBe(200);

    const wrong = await request(app).post("/api/auth/logout-all").set("Origin", ORIGIN).set("Cookie", `mv_access=${b.access}`).send({ password: "WrongPass99" });
    expect(wrong.status).toBe(401);
    const all = await request(app).post("/api/auth/logout-all").set("Origin", ORIGIN).set("Cookie", `mv_access=${b.access}`).send({ password: PASSWORD });
    expect(all.status).toBe(200);
    expect((await me(b.access)).status).toBe(401);
    expect((await me(phone.accessToken, "bearer")).status).toBe(401);
    expect((await mobileRefresh(phone.refreshToken)).status).toBe(401);
  });

  it("an expired access token still lets logout close the session through the refresh cookie", async () => {
    const u = await createUser();
    const { refresh } = await webLogin(u.email);
    await request(app).post("/api/auth/logout").set("Origin", ORIGIN).set("Cookie", `mv_refresh=${refresh}`);
    expect((await webRefresh(refresh)).status).toBe(401);
  });

  it("suspending or deleting an account ends its sessions at once", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    const { access } = await webLogin(u.email);
    const admin = await loginAs(await createUser({ role: "ADMIN" }));
    await admin.post(`/api/admin/users/${u.id}/status`, { status: "SUSPENDED", reason: "Testing suspension." });
    expect((await me(access)).status).toBe(401);
    expect((await s.get("/api/auth/me")).status).toBe(401);

    const v = await createUser();
    const vs = await loginAs(v);
    await vs.post("/api/settings/delete-account", { password: PASSWORD });
    expect((await vs.get("/api/auth/me")).status).toBe(401);
    expect((await request(app).post("/api/auth/mobile/login").send({ email: v.email, password: PASSWORD })).status).toBe(403);
  });
});

describe("upgrade from cookie sessions", () => {
  it("swaps an old session cookie once, without signing the member out", async () => {
    const u = await createUser();
    const legacy = randomToken();
    await prisma.session.create({ data: { userId: u.id, tokenHash: sha256(legacy), expiresAt: new Date(Date.now() + 86400000) } });
    const first = await request(app).get("/api/auth/me").set("Cookie", `knot_session=${legacy}`);
    expect(first.status).toBe(200);
    expect(cookieValue(first, "mv_access")).toBeTruthy();
    expect(cookieValue(first, "mv_refresh")).toBeTruthy();
    expect(cookieValue(first, "knot_session")).toBe(""); // cleared
    expect((await request(app).get("/api/auth/me").set("Cookie", `knot_session=${legacy}`)).status).toBe(401); // single use
    expect((await webRefresh(cookieValue(first, "mv_refresh")!)).status).toBe(200);
    expect(await prisma.securityEvent.count({ where: { type: "LEGACY_SESSION_MIGRATED" } })).toBe(1);
  });
});

describe("security events and staff boundaries", () => {
  it("records sign-ins and failures without passwords, tokens or unknown email addresses", async () => {
    const u = await createUser();
    await webLogin(u.email);
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: u.email, password: "WrongPass99" });
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "stranger@knot.test", password: "WrongPass99" });
    const events = await prisma.securityEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["LOGIN_SUCCESS", "LOGIN_FAILED", "LOGIN_FAILED"]);
    expect(events[2]).toMatchObject({ userId: null, emailHash: sha256("stranger@knot.test") });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("WrongPass99");
    expect(dump).not.toContain("stranger@knot.test");
  });

  it("members can't reach staff routes, and moderators can't act on other staff", async () => {
    const member = await loginAs(await createUser());
    expect((await member.get("/api/admin/users")).status).toBe(403);
    expect((await member.get("/api/experts/workspace/queue")).status).toBe(403);
    const mod = await loginAs(await createUser({ role: "MODERATOR" }));
    const otherMod = await createUser({ role: "MODERATOR" });
    expect((await mod.post(`/api/admin/users/${otherMod.id}/status`, { status: "SUSPENDED", reason: "Should be refused." })).status).toBe(400);
    const plain = await createUser();
    expect((await mod.post(`/api/admin/users/${plain.id}/status`, { status: "SUSPENDED", reason: "Allowed for members." })).status).toBe(200);
  });

  it("revoking another device asks for the password again", async () => {
    const u = await createUser();
    const laptop = await loginAs(u);
    const phone = await mobileLogin(u.email);
    const sessions = (await laptop.get("/api/settings/sessions")).body.data as { id: string; client: string }[];
    const phoneSession = sessions.find((s) => s.client === "MOBILE")!;
    expect((await laptop.agent.delete(`/api/settings/sessions/${phoneSession.id}`).set("Origin", ORIGIN).send({})).status).toBe(422);
    expect((await laptop.agent.delete(`/api/settings/sessions/${phoneSession.id}`).set("Origin", ORIGIN).send({ password: "WrongPass99" })).status).toBe(401);
    expect((await laptop.agent.delete(`/api/settings/sessions/${phoneSession.id}`).set("Origin", ORIGIN).send({ password: PASSWORD })).status).toBe(200);
    expect((await me(phone.accessToken, "bearer")).status).toBe(401);
  });
});

describe("Socket.IO with tokens", () => {
  let http: HttpServer;
  let url = "";
  const sockets: Socket[] = [];
  beforeAll(async () => {
    http = createServer(app);
    createSocketServer(http);
    await new Promise<void>((r) => http.listen(0, r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    sockets.forEach((s) => s.close());
    setIo(null);
    http.close();
  });
  const connect = (opts: { cookie?: string; token?: string }) =>
    new Promise<Socket>((resolve, reject) => {
      const s = ioClient(url, { extraHeaders: { origin: ORIGIN, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, auth: opts.token ? { token: opts.token } : {}, transports: ["websocket"], reconnection: false });
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", (e) => reject(e));
    });

  it("accepts a web access cookie or a mobile token, and nothing else", async () => {
    const u = await createUser();
    const { access } = await webLogin(u.email);
    const phone = await mobileLogin(u.email);
    expect((await connect({ cookie: `mv_access=${access}` })).connected).toBe(true);
    expect((await connect({ token: phone.accessToken })).connected).toBe(true);
    await expect(connect({ token: access })).rejects.toThrow("UNAUTHENTICATED"); // web token used as mobile
    await expect(connect({ cookie: `mv_access=${phone.accessToken}` })).rejects.toThrow("UNAUTHENTICATED");
    const expired = await forge({ sub: u.id, sid: (decodeJwt(access) as { sid: string }).sid }, { expSeconds: -60, iatOffset: -1000 });
    await expect(connect({ cookie: `mv_access=${expired}` })).rejects.toThrow("UNAUTHENTICATED");
    await expect(connect({})).rejects.toThrow("UNAUTHENTICATED");
  });

  it("disconnects a phone's socket when that session is signed out", async () => {
    const u = await createUser();
    const phone = await mobileLogin(u.email);
    const s = await connect({ token: phone.accessToken });
    const gone = new Promise((r) => s.once("disconnect", r));
    await request(app).post("/api/auth/mobile/logout").set("Authorization", `Bearer ${phone.accessToken}`).send({});
    await expect(Promise.race([gone, new Promise((_, j) => setTimeout(() => j(new Error("still connected")), 2000))])).resolves.toBeDefined();
  });
});

describe("changing ids in requests (IDOR)", () => {
  it("an outsider can't touch another pair's match, chat, game, Astro or Together space", async () => {
    const a = await createUser({ name: "A" });
    const b = await createUser({ name: "B", gender: "MAN" });
    const { matchId, conversationId } = await match(a, b);
    const outsider = await loginAs(await createUser({ name: "Outsider" }));
    const checks = await Promise.all([
      outsider.get(`/api/conversations/${conversationId}`),
      outsider.get(`/api/conversations/${conversationId}/messages`),
      outsider.post(`/api/conversations/${conversationId}/messages`, { body: "hi" }),
      outsider.get(`/api/conversations/${conversationId}/games`),
      outsider.get(`/api/astro/matches/${matchId}`),
      outsider.get(`/api/couple/matches/${matchId}`),
      outsider.post(`/api/couple/matches/${matchId}/request`),
      outsider.get(`/api/friend-reviews/matches/${matchId}`),
      outsider.delete(`/api/matches/${matchId}`),
    ]);
    expect(checks.map((r) => r.status)).toEqual(Array(checks.length).fill(404));
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe("ACTIVE");
  });

  it("a member can't edit someone else's media or read their settings and sessions", async () => {
    const owner = await createUser();
    const photo = await prisma.profilePhoto.findFirstOrThrow({ where: { userId: owner.id } });
    const other = await loginAs(await createUser());
    expect((await other.patch(`/api/profiles/me/photos/${photo.id}`, { caption: "mine now" })).status).toBe(404);
    expect((await other.delete(`/api/profiles/me/photos/${photo.id}`)).status).toBe(404);
    const ownerSession = await prisma.session.create({ data: { userId: owner.id, refreshHash: sha256(randomToken()), expiresAt: new Date(Date.now() + 86400000) } });
    await other.agent.delete(`/api/settings/sessions/${ownerSession.id}`).set("Origin", ORIGIN).send({ password: PASSWORD });
    expect((await prisma.session.findUniqueOrThrow({ where: { id: ownerSession.id } })).revokedAt).toBeNull();
  });
});

