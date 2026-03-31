import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("Firebase는 브라우저 환경에서만 초기화됩니다.");
  }
}

export function getFirebaseApp() {
  assertBrowser();
  if (_app) return _app;
  _app = getApps().length > 0 ? getApps()[0]! : initializeApp(firebaseConfig);
  return _app;
}

export function getFirebaseAuth() {
  assertBrowser();
  if (_auth) return _auth;
  _auth = getAuth(getFirebaseApp());
  return _auth;
}

