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

/** Development: prints the email (including links) to the server log instead of sending it. */
class ConsoleMailer implements Mailer {
  public outbox: Mail[] = [];
  async send(mail: Mail) {
    this.outbox.push(mail);
    if (!config.isTest) logger.info({ to: mail.to, subject: mail.subject }, `\n--- DEV EMAIL ---\n${mail.text}\n-----------------`);
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
