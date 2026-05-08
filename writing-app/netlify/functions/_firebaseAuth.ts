import type { HandlerEvent } from "@netlify/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ─────────────────────────────────────────────────────────────────────────
// Firebase ID token verification.
//
// Firebase signs ID tokens with rotating RS256 keys served by Google's
// securetoken service. We pull the JWK set from Google directly and let
// jose handle in-memory caching with rotation. Verifying server-side means
// we can trust the `sub` claim as the teacher's Firebase UID without ever
// asking the client for it.
//
// We deliberately avoid `firebase-admin` here — it pulls in google-auth,
// firebase-app, firebase-functions, etc., which inflate the function bundle
// and slow cold starts. jose is small and standards-compliant.
// ─────────────────────────────────────────────────────────────────────────

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const JWKS = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));

function getProjectId(): string {
  // The same project ID the client uses (NEXT_PUBLIC_*) is what Firebase
  // signs into the iss/aud claims.
  const id = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!id) {
    throw new Error(
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID is not set — cannot verify Firebase ID tokens",
    );
  }
  return id;
}

export type VerifiedTeacher = {
  uid: string;
  email?: string;
};

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedTeacher> {
  const projectId = getProjectId();
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ["RS256"],
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Firebase ID token missing sub claim");
  }
  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

/**
 * Extract the bearer token from an Authorization header. Returns null if
 * the header is missing or malformed (callers should respond with 401).
 */
export function extractBearerToken(event: HandlerEvent): string | null {
  const raw =
    event.headers["authorization"] ||
    event.headers["Authorization"] ||
    event.headers["AUTHORIZATION"];
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

export type RequireTeacherResult =
  | { ok: true; teacher: VerifiedTeacher }
  | { ok: false; status: number; error: string };

/**
 * One-shot helper for endpoints: pull the bearer token, verify it, return
 * the teacher's uid. On failure returns the exact status/body to send back.
 */
export async function requireTeacher(event: HandlerEvent): Promise<RequireTeacherResult> {
  const token = extractBearerToken(event);
  if (!token) {
    return { ok: false, status: 401, error: "Authorization 헤더가 필요합니다." };
  }
  try {
    const teacher = await verifyFirebaseIdToken(token);
    return { ok: true, teacher };
  } catch (e) {
    return {
      ok: false,
      status: 401,
      error: `토큰 검증 실패: ${(e as Error).message}`,
    };
  }
}
