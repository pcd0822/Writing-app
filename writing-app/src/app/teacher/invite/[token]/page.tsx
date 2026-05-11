"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../providers";
import { signInTeacherWithGoogle } from "@/lib/auth";
import { acceptByToken } from "@/lib/collaborators";
import { Button } from "@/components/ui/Button";

// 공동 교사 초대 링크 랜딩.
//
// /teacher/invite/<token> 으로 들어오면:
//   1) 로그인 안 됐으면 "Google로 로그인" 버튼만 노출
//   2) 로그인 된 직후 acceptByToken(token) 호출
//   3) 성공 → /teacher 로 리다이렉트
//   4) 실패 → 에러 메시지 + 재시도 / 홈으로
//
// Next.js 16에서 dynamic params는 Promise — use()로 해제.

export default function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [stage, setStage] = useState<"idle" | "signingIn" | "accepting" | "ok" | "err">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    // 로그인된 상태로 페이지가 보이면 즉시 토큰을 사용해 수락 시도.
    if (stage !== "idle") return;
    setStage("accepting");
    void (async () => {
      try {
        await acceptByToken(token);
        setStage("ok");
        window.setTimeout(() => router.replace("/teacher"), 1200);
      } catch (e) {
        setError((e as Error).message || "초대 수락 실패");
        setStage("err");
      }
    })();
  }, [isLoading, user, token, stage, router]);

  async function onSignIn() {
    setStage("signingIn");
    setError(null);
    try {
      await signInTeacherWithGoogle();
      // useEffect가 user 변화를 감지해 다시 accept 시도. 여기서는 stage만 풀어
      // useEffect의 stage !== "idle" 가드를 통과시킨다.
      setStage("idle");
    } catch (e) {
      setError((e as Error).message || "로그인 실패");
      setStage("err");
    }
  }

  function onRetry() {
    setError(null);
    setStage("idle");
  }

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>공동 교사 초대</h1>
      <p style={{ color: "var(--ink-muted)", maxWidth: 480, lineHeight: 1.55 }}>
        이 링크를 통해 다른 교사의 학급·과제·제출물 워크스페이스에 공동 교사로 참여할 수
        있습니다. Google 계정으로 로그인하면 즉시 수락됩니다.
      </p>

      {isLoading ? (
        <div style={{ color: "var(--ink-muted)" }}>로그인 상태 확인 중…</div>
      ) : !user ? (
        <Button onClick={onSignIn} isLoading={stage === "signingIn"}>
          Google 계정으로 로그인하고 수락
        </Button>
      ) : stage === "accepting" ? (
        <div style={{ color: "var(--ink-muted)" }}>초대 수락 처리 중…</div>
      ) : stage === "ok" ? (
        <div style={{ color: "var(--tertiary)", fontWeight: 700 }}>
          ✓ 수락 완료. 대시보드로 이동합니다.
        </div>
      ) : stage === "err" ? (
        <>
          <div
            style={{
              background: "var(--danger-soft)",
              borderLeft: "3px solid var(--danger)",
              color: "var(--danger)",
              padding: "10px 14px",
              borderRadius: 8,
              maxWidth: 480,
            }}
          >
            {error}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" onClick={() => router.replace("/teacher")}>
              대시보드로 이동
            </Button>
            <Button onClick={onRetry}>다시 시도</Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
