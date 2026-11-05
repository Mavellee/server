import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { mailer } from "../src/lib/mailer.js";
import { anon, app, createUser, loginAs, ORIGIN, PASSWORD, resetDb } from "./helpers.js";

const outbox = (mailer as unknown as { outbox: { to: string; subject: string; text: string }[] }).outbox;
const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1];
const dobForAge = (age: number) => {
  const d = new Date();
  return `${d.getUTCFullYear() - age}-01-01`;
};
const valid = () => ({ email: `new${Date.now()}@example.com`, password: PASSWORD, dateOfBirth: dobForAge(30), ageConfirmed: true, acceptTerms: true });

beforeEach(resetDb);

describe("registration", () => {
  it("creates a pending account without signing in, and the emailed link verifies and signs in", async () => {
    const s = anon();
    const body = valid();
    const res = await s.post("/api/auth/register", body);
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ checkEmail: true });
    expect(res.headers["set-cookie"]).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.status).toBe("PENDING_VERIFICATION");

    // Signing in before verifying works, but social features stay locked.
    const early = await loginAs(user);
    expect((await early.get("/api/discovery")).status).toBe(403);

    const mail = outbox.filter((m) => m.to === body.email).at(-1)!;
    expect(mail.text).toContain("/verify-email#token="); // fragment: never sent to a server or logged
    const verify = await s.post("/api/auth/verify-email", { token: tokenFrom(mail.text) });
    expect(verify.status).toBe(200);
    expect(([] as string[]).concat(verify.headers["set-cookie"]).join(";")).toMatch(/mv_access=.*HttpOnly/);
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

  it("never reveals whether an email is registered, and tells the real owner instead", async () => {
    const body = valid();
    const first = await anon().post("/api/auth/register", body);
    const again = await anon().post("/api/auth/register", { ...body, email: body.email.toUpperCase(), password: "SomethingElse9" });
    expect([first.status, again.status]).toEqual([202, 202]);
    expect(again.body).toEqual(first.body);
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
    expect(outbox.filter((m) => m.to === body.email).at(-1)!.subject).toMatch(/tried to create a Mavelle account/);
    // The original password still works; the second attempt changed nothing.
    expect((await anon().post("/api/auth/login", { email: body.email, password: PASSWORD })).status).toBe(200);
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
    const resetMail = outbox.filter((m) => m.to === u.email).at(-1)!.text;
    expect(resetMail).toContain("/reset-password#token=");
    const token = tokenFrom(resetMail);
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

  it("treats a malformed Referer as a foreign origin rather than crashing", async () => {
    const res = await request(app).post("/api/auth/login").set("Referer", "not a url").send({ email: "a@b.co", password: "x" });
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

  it("locks out guessing on one account without locking out other people on the same network", async () => {
    const neighbour = await createUser();
    const attempt = (email: string, password: string) => request(app).post("/api/auth/login").set("Origin", ORIGIN).set("x-test-rate-limit", "on").send({ email, password });
    for (let i = 0; i < 10; i++) await attempt("guessed@knot.test", "WrongPass99");
    expect((await attempt("guessed@knot.test", "WrongPass99")).status).toBe(429);
    expect((await attempt(neighbour.email, PASSWORD)).status).toBe(200); // same IP, different account
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
