"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { callFunction } from "@/lib/netlifyClient";
import { loadTeacherSettings, saveTeacherSettings } from "@/lib/teacherSettings";

function DriveCallbackInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [message, setMessage] = useState("연결 처리 중…");

  useEffect(() => {
    const code = sp.get("code");
    const err = sp.get("error");
    if (err) {
      setMessage(`Google 오류: ${err}`);
      return;
    }
    if (!code) {
      setMessage("인증 코드가 없습니다. 다시 시도해주세요.");
      return;
    }

    const redirectUri =
      typeof window !== "undefined"
        ? `${window.location.origin}${window.location.pathname}`
        : "";

    void (async () => {
      try {
        const res = await callFunction<{
          ok: true;
          refreshToken: string;
        }>("google-drive-oauth-token", { code, redirectUri });

        const prev = loadTeacherSettings();
        if (!prev?.spreadsheetId) {
          setMessage("먼저 교사 화면에서 스프레드시트(DB)를 연결한 뒤 다시 시도해주세요.");
          return;
        }

        saveTeacherSettings({
          spreadsheetId: prev.spreadsheetId,
          driveFolderId: prev.driveFolderId,
          driveOAuthRefreshToken: res.refreshToken,
        });
        setMessage("연결되었습니다. 잠시 후 대시보드로 이동합니다.");
        window.setTimeout(() => router.replace("/teacher"), 1200);
      } catch (e) {
        setMessage((e as Error).message || "토큰 저장 실패");
      }
    })();
  }, [sp, router]);

  return (
    <div
      style={{
        minHeight: "40vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontSize: 15,
        color: "#0f172a",
      }}
    >
      {message}
    </div>
  );
}

export default function DriveCallbackPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, fontSize: 15, color: "#64748b" }}>불러오는 중…</div>
      }
    >
      <DriveCallbackInner />
    </Suspense>
  );
}
