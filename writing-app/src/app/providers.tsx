"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type AuthState = {
  user: User | null;
  isLoading: boolean;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let isActive = true;

    (async () => {
      try {
        const { getFirebaseAuth } = await import("@/lib/firebase");
        if (!isActive) return;
        unsub = onAuthStateChanged(getFirebaseAuth(), (u) => {
          setUser(u);
          setIsLoading(false);
        });
      } catch {
        setIsLoading(false);
      }
    })();

    return () => {
      isActive = false;
      unsub?.();
    };
  }, []);

  const value = useMemo(() => ({ user, isLoading }), [user, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}

