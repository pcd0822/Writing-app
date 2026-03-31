"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./page.module.css";
import { signInTeacherWithGoogle } from "@/lib/auth";
import { useAuth } from "./providers";

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [isSigningIn, setIsSigningIn] = useState(false);

  async function onTeacherLogin() {
    setIsSigningIn(true);
    try {
      await signInTeacherWithGoogle();
      router.push("/teacher");
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.badge}>LIVE</div>
            <div className={styles.titleBlock}>
              <h1 className={styles.title}>실시간 작문</h1>
              <p className={styles.subtitle}>
                교사/학생이 같은 과제를 단계별로 수행하고, 승인·피드백·AI 튜터 기록까지
                남기는 작문 수행평가 앱
              </p>
            </div>
          </div>
        </div>

        <div className={styles.grid}>
          <section className={styles.card}>
            <h2>교사</h2>
            <p>Google 로그인(파이어베이스)로 교사 대시보드에 प्रवेश합니다.</p>
            <button
              className={styles.primaryButton}
              onClick={onTeacherLogin}
              disabled={isSigningIn || isLoading}
            >
              {isSigningIn ? (
                <span className={styles.inline}>
                  <span className={styles.spinner} aria-hidden="true" />
                  로그인 중…
                </span>
              ) : (
                "Google로 로그인"
              )}
            </button>
            {user ? (
              <button
                className={styles.secondaryButton}
                onClick={() => router.push("/teacher")}
                disabled={isLoading}
              >
                교사 화면으로 이동
              </button>
            ) : null}
          </section>

          <section className={styles.card}>
            <h2>학생</h2>
            <p>
              교사가 공유한 링크로 접속 후, 학번과 학생 코드를 입력해 작문을 시작합니다.
            </p>
            <div className={styles.placeholder}>
              학생 화면은 다음 단계에서 “공유 링크(유효시간)” 기능과 함께 연결됩니다.
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
