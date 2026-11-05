import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Short-lived access tokens: EdDSA (Ed25519) JWTs carrying only ids. Verification accepts no other algorithm and
 * checks issuer, audience and expiry. The signing key comes from configuration and never leaves the server.
 */
export type Audience = "mavelle-web" | "mavelle-mobile";
export type AccessClaims = { sub: string; sid: string; jti: string };

const ALG = "EdDSA";

function loadKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  const raw = config.auth.privateKey;
  if (raw) {
    const pem = raw.includes("-----BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("AUTH_JWT_PRIVATE_KEY must be an Ed25519 key");
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  if (config.isProd) throw new Error("AUTH_JWT_PRIVATE_KEY is required in production");
  // Development and tests: a fresh key per process. Access tokens die on restart; refresh tokens still work.
  if (!config.isTest) logger.warn("AUTH_JWT_PRIVATE_KEY is not set: using a temporary signing key for this process");
  return generateKeyPairSync("ed25519");
}

let keys = loadKeys();

export async function signAccessToken(userId: string, sessionId: string, audience: Audience) {
  const jti = randomUUID();
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(config.auth.issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.accessTtlSeconds}s`)
    .setJti(jti)
    .sign(keys.privateKey);
  return { token, expiresIn: config.auth.accessTtlSeconds };
}

/** Returns the claims, or null for anything invalid: bad signature, other algorithm, wrong issuer or audience, expired. */
export async function verifyAccessToken(token: string, audience: Audience): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      algorithms: [ALG],
      issuer: config.auth.issuer,
      audience,
      requiredClaims: ["sub", "sid", "jti", "iat", "exp"],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.jti !== "string") return null;
    return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
  } catch {
    return null;
  }
}

/** Test hook: the private key, so tests can mint deliberately bad tokens. */
export const signingKeyForTests = () => (config.isTest ? keys.privateKey : null);
/** Test hook: rotate the signing key (simulates a key change). */
export const resetKeysForTests = () => {
  if (config.isTest) keys = loadKeys();
};
