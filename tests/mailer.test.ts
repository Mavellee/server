import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleMailer } from "../src/lib/mailer.js";
import { logger } from "../src/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("email without SMTP", () => {
  const mail = { to: "person@example.com", subject: "Confirm your email for Mavelle", text: "Open http://x/verify-email?token=SECRET-TOKEN-123" };

  it("in production never logs the message body (live account tokens) or keeps emails in memory", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const m = new ConsoleMailer("production");
    await m.send(mail);
    const logged = JSON.stringify([...error.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain("SECRET-TOKEN-123");
    expect(logged).not.toContain("person@example.com");
    expect(logged).toContain("NOT sent");
    expect(m.outbox).toHaveLength(0);
  });

  it("in development prints the email so links can be followed locally", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    await new ConsoleMailer("development").send(mail);
    expect(JSON.stringify(info.mock.calls)).toContain("SECRET-TOKEN-123");
  });
});
