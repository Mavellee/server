import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../../config.js";

/** AES-256-GCM for stored birth details. The key lives only in the environment; "v1." allows future rotation. */
function key() {
  const raw = config.astro.encryptionKey;
  const buf = raw ? Buffer.from(raw, "base64") : null;
  return buf?.length === 32 ? buf : null;
}
export const cipherReady = () => key() !== null;

export function seal(value: object) {
  const k = key();
  if (!k) throw new Error("ASTRO_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function open<T>(sealed: string): T {
  const k = key();
  if (!k) throw new Error("ASTRO_ENCRYPTION_KEY is not configured");
  const [, iv, tag, body] = sealed.split(".");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8")) as T;
}
