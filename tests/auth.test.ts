import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { mailer } from "../src/lib/mailer.js";
import { anon, app, createUser, loginAs, ORIGIN, PASSWORD, resetDb } from "./helpers.js";

const outbox = (mailer as unknown as { outbox: { to: string; text: string }[] }).outbox;
const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1];
const dobForAge = (age: number) => {
  const d = new Date();
  return `${d.getUTCFullYear() - age}-01-01`;
};
const valid = () => ({ email: `new${Date.now()}@example.com`, password: PASSWORD, dateOfBirth: dobForAge(30), ageConfirmed: true, acceptTerms: true });

beforeEach(resetDb);

describe("registration", () => {
  it("creates a pending account, logs in, and sends a verification email", async () => {
    const s = anon();
    const body = valid();
    const res = await s.post("/api/auth/register", body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: body.email, status: "PENDING_VERIFICATION", emailVerified: false, age: expect.any(Number) });
    expect(res.body.data).not.toHaveProperty("passwordHash");
    expect(res.headers["set-cookie"][0]).toMatch(/knot_session=.*HttpOnly.*SameSite=Lax/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);

    // Social features are locked until verification.
    expect((await s.get("/api/discovery")).status).toBe(403);

    const mail = outbox.filter((m) => m.to === body.email).at(-1)!;
    const verify = await s.post("/api/auth/verify-email", { token: tokenFrom(mail.text) });
    expect(verify.status).toBe(200);
    expect((await s.get("/api/auth/me")).body.data.status).toBe("ACTIVE");
    // Tokens are single use.
    expect((await s.post("/api/auth/verify-email", { token: tokenFrom(mail.text) })).status).toBe(400);
  });

  it("rejects people under 18 using the server-side age calculation", async () => {
    const res = await anon().post("/api/auth/register", { ...valid(), dateOfBirth: dobForAge(17) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNDERAGE");
  });

  it("requires the age confirmation and validates fields", async () => {
    const res = await anon().post("/api/auth/register", { email: "nope", password: "short", dateOfBirth: "1990-01-01", ageConfirmed: false, acceptTerms: true });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details)).toEqual(expect.arrayContaining(["email", "password", "ageConfirmed"]));
  });

  it("does not allow duplicate emails (case-insensitive)", async () => {
    const body = valid();
    await anon().post("/api/auth/register", body);
    const res = await anon().post("/api/auth/register", { ...body, email: body.email.toUpperCase() });
    expect(res.status).toBe(409);
  });
});

describe("login and sessions", () => {
  it("gives the same error for unknown email and wrong password", async () => {
    const u = await createUser();
    const a = await anon().post("/api/auth/login", { email: u.email, password: "WrongPass99" });
    const b = await anon().post("/api/auth/login", { email: "nobody@knot.test", password: "WrongPass99" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  it("logout revokes the session server-side", async () => {
    const s = await loginAs(await createUser());
    expect((await s.get("/api/auth/me")).status).toBe(200);
    await s.post("/api/auth/logout");
    expect((await s.get("/api/auth/me")).status).toBe(401);
  });

  it("password reset works once and signs out every session", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    const forgot = await anon().post("/api/auth/forgot-password", { email: u.email });
    expect(forgot.status).toBe(200);
    // Unknown emails get the same response.
    expect((await anon().post("/api/auth/forgot-password", { email: "ghost@knot.test" })).body).toEqual(forgot.body);
    const token = tokenFrom(outbox.filter((m) => m.to === u.email).at(-1)!.text);
    expect((await anon().post("/api/auth/reset-password", { token, password: "BrandNewPass1" })).status).toBe(200);
    expect((await s.get("/api/auth/me")).status).toBe(401);
    expect((await anon().post("/api/auth/reset-password", { token, password: "AnotherPass22" })).status).toBe(400);
    expect((await anon().post("/api/auth/login", { email: u.email, password: "BrandNewPass1" })).status).toBe(200);
  });
});

describe("request protections", () => {
  it("rejects state-changing requests from another origin (CSRF)", async () => {
    const res = await request(app).post("/api/auth/login").set("Origin", "https://evil.example").send({ email: "a@b.co", password: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BAD_ORIGIN");
  });

  it("rate-limits login attempts", async () => {
    let last = 0;
    for (let i = 0; i < 22; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .set("x-test-rate-limit", "on")
        .send({ email: "ratelimit@knot.test", password: "WrongPass99" });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("returns consistent JSON errors for unknown routes and malformed JSON", async () => {
    const notFound = await anon().get("/api/does-not-exist");
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe("NOT_FOUND");
    const bad = await request(app).post("/api/auth/login").set("Origin", ORIGIN).set("Content-Type", "application/json").send("{bad");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_JSON");
  });
});
