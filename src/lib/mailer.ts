import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Used when SMTP isn't configured. In development it prints the email (including links) to the log.
 * In production it never logs the body — verification and reset links are live account tokens — and
 * reports that nothing was sent. Tests keep an in-memory outbox; nothing is retained otherwise.
 */
export class ConsoleMailer implements Mailer {
  public outbox: Mail[] = [];
  constructor(private mode: "development" | "test" | "production" = config.isTest ? "test" : config.isProd ? "production" : "development") {}
  async send(mail: Mail) {
    if (this.mode === "test") return void this.outbox.push(mail);
    if (this.mode === "production") return void logger.error({ subject: mail.subject }, "Email NOT sent: SMTP is not configured (SMTP_HOST is empty)");
    logger.info({ to: mail.to, subject: mail.subject }, `\n--- DEV EMAIL ---\n${mail.text}\n-----------------`);
  }
}

class SmtpMailer implements Mailer {
  private transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  async send(mail: Mail) {
    await this.transport.sendMail({ from: config.mail.from, ...mail });
  }
}

export const mailer: Mailer = config.mail.host ? new SmtpMailer() : new ConsoleMailer();

if (config.isProd && !config.mail.host) {
  logger.error("SMTP_HOST is not set: verification and password-reset emails will NOT be sent. Configure SMTP before inviting members.");
}
