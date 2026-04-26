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
                개요부터 고쳐쓰기까지 단계별로 수행하고, 교사 승인·피드백·AI 튜터 기록을
                한곳에 남기는 작문 학습 플랫폼.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.grid}>
          <section className={styles.card}>
            <h2>교사 로그인</h2>
            <p>Google 계정으로 로그인하여 학급·과제를 만들고 학생의 작문 진행을 실시간으로 확인하세요.</p>
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
                교사 대시보드로 이동
              </button>
            ) : null}
          </section>

          <section className={styles.card}>
            <h2>학생 시작하기</h2>
            <p>교사가 공유한 링크로 접속한 뒤, 학번과 8자리 코드를 입력하면 작문을 시작할 수 있어요.</p>
            <div className={styles.placeholder}>
              <b>로그인 불필요.</b> 별도 가입 없이 공유 링크 + 학번 + 코드만으로 어느 기기에서든 작업을 이어갈 수 있습니다.
            </div>
          </section>
        </div>

        <div className={styles.footer}>
          <span aria-hidden="true" />
          단계별 작문 · GRASP 맥락 설계 · AI 협력 · 사고 성장 대시보드
          <span aria-hidden="true" />
        </div>
      </main>
    </div>
  );
}
