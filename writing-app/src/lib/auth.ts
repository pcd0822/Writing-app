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

