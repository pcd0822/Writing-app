import { GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { getFirebaseAuth } from "./firebase";

export async function signInTeacherWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });
  return await signInWithPopup(getFirebaseAuth(), provider);
}

export async function signOutCurrentUser() {
  return await signOut(getFirebaseAuth());
}

/**
 * Return the current teacher's Firebase ID token, or null if not signed in.
 * Used as the bearer token for Supabase-backed Netlify Functions.
 *
 * forceRefresh=true forces a fresh token from Google — call this on a 401
 * retry; otherwise let the SDK serve a cached token (it auto-refreshes when
 * the cached one is within 5 minutes of expiry).
 */
export async function getCurrentTeacherIdToken(
  forceRefresh = false,
): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return await user.getIdToken(forceRefresh);
}

