import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "../config.js";

/**
 * Verifies the ID token Firebase's client SDK hands the browser after "Sign in with Google". This is the only
 * thing Firebase does for us: prove the token really came from Google for this project. Our own session system
 * (sessions.ts) takes over immediately after, exactly as it does for a password login.
 */
let app: App | null = null;

function firebaseApp(): App {
  if (!config.firebase) {
    throw new Error("Google sign-in is not configured (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).");
  }
  if (!app) {
    app = getApps()[0] ?? initializeApp({ credential: cert(config.firebase) });
  }
  return app;
}

export type GoogleIdentity = { uid: string; email: string; emailVerified: boolean; name: string | null; picture: string | null };

/** Throws if the token is missing, expired, or not actually issued by this Firebase project. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const decoded = await getAuth(firebaseApp()).verifyIdToken(idToken);
  if (!decoded.email) throw new Error("Google did not share an email address for this account.");
  return {
    uid: decoded.uid,
    email: decoded.email.toLowerCase(),
    emailVerified: !!decoded.email_verified,
    name: typeof decoded.name === "string" ? decoded.name : null,
    picture: typeof decoded.picture === "string" ? decoded.picture : null,
  };
}
