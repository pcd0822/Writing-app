"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { callFunction } from "@/lib/netlifyClient";
import { getCurrentTeacherIdToken } from "@/lib/auth";
import { isUsingSupabase } from "@/lib/spreadsheetSync";

type Counts = {
  classes: number;
  students: number;
  assignments: number;
  allocations: number;
  shares: number;
  submissions: number;
  feedbackNotes: number;
  aiLogs: number;
  scores: number;
  stepTransitions: number;
  aiInteractions: number;
  teacherComments: number;
  tombstones: number;
  /** 시트에 (학생, 과제, 학급) 중복으로 들어있어 1개로 정리한 submission 수 */
  dedupedSubmissions?: number;
};

type MigrateResponse = { ok: true; counts: Counts | null };

type Props = {
  isOpen: boolean;
  onClose: () => void;
  spreadsheetId: string | null;
};

const box: React.CSSProperties = { padding: 12, borderRadius: 6, fontSize: 13 };

export function MigrateToSupabaseModal({ isOpen, onClose, spreadsheetId }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  function reset() {
    setError(null);
    setCounts(null);
    setEmptyResult(false);
  }

  async function onMigrate() {
    reset();
    if (!spreadsheetId) {
      setError("연결된 스프레드시트가 없습니다.");
      return;
    }
    setRunning(true);
    try {
      const token = await getCurrentTeacherIdToken();
      if (!token) {
        setError("로그인 상태를 확인할 수 없습니다. 다시 로그인 후 시도해주세요.");
        return;
      }
      // retries: 0 — 마이그레이션은 사용자 트리거라, 실패하면 사용자가 명시적으로
      // 다시 누르도록 해야 한다(자동 재시도가 데이터 중복 우려는 없지만 사용자
      // 혼란만 만든다).
      const res = await callFunction<MigrateResponse>(
        "supabase-migrate-from-sheet",
        { spreadsheetId },
        { authToken: token, retries: 0 },
      );
      if (res.counts == null) setEmptyResult(true);
      else setCounts(res.counts);
    } catch (e) {
      setError((e as Error).message || "마이그레이션 실패");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="🚚 Supabase로 이전 (일회성)"
      description="시트에 있던 기존 데이터를 Supabase로 한 번만 옮기는 작업입니다. 이전 후에는 학생/교사가 새로 작성하는 모든 데이터가 자동으로 Supabase에 저장됩니다."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            닫기
          </Button>
          <Button onClick={onMigrate} isLoading={running} loadingLabel="이전 중">
            Supabase로 이전 시작
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ ...box, background: "#e7f5ff", color: "#0b3d66" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 한 번만 누르세요</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>매 과제 시작 때마다 누를 필요 없습니다.</li>
            <li>새 디바이스에서 접속할 때도 누를 필요 없습니다.</li>
            <li>이전 후에는 학생이 작성한 모든 글이 자동으로 Supabase에 저장됩니다.</li>
            <li>여러 번 눌러도 같은 ID는 덮어쓰기라 안전합니다(시트 데이터도 보존).</li>
          </ul>
        </div>
        {spreadsheetId ? (
          <p style={{ fontSize: 13, color: "#666", margin: 0 }}>
            시트 ID: <code>{spreadsheetId.slice(0, 12)}…</code>
          </p>
        ) : null}

        {!isUsingSupabase ? (
          <div style={{ ...box, background: "#fff3cd", color: "#7a5c00" }}>
            ⚠️ 현재 클라이언트는 시트 모드입니다. 이전을 끝낸 뒤 운영자 측에서{" "}
            <code>NEXT_PUBLIC_USE_SUPABASE=true</code>로 재배포해야 학생/교사 작업이
            Supabase로 흐릅니다.
          </div>
        ) : (
          <div style={{ ...box, background: "#d1ecf1", color: "#0c5460" }}>
            ℹ️ 클라이언트가 이미 Supabase 모드입니다. 이전 후 즉시 새 데이터가 보입니다.
          </div>
        )}

        {counts ? (
          <div style={{ ...box, background: "#e7f5ff", color: "#0b3d66" }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>✅ 이전 완료</div>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              <li>
                학급 {counts.classes}개 / 학생 {counts.students}명
              </li>
              <li>
                과제 {counts.assignments}개 / 할당 {counts.allocations}건 / 공유 링크{" "}
                {counts.shares}개
              </li>
              <li>
                제출물 {counts.submissions}개
                {counts.dedupedSubmissions && counts.dedupedSubmissions > 0 ? (
                  <span style={{ color: "#a05a00" }}>
                    {" "}
                    (중복 {counts.dedupedSubmissions}개 정리됨)
                  </span>
                ) : null}
              </li>
              <li>
                피드백 노트 {counts.feedbackNotes} · AI 로그 {counts.aiLogs} · 점수{" "}
                {counts.scores}
              </li>
              <li>
                단계 이동 {counts.stepTransitions} · AI 협력 {counts.aiInteractions} · 교사
                코멘트 {counts.teacherComments}
              </li>
            </ul>
          </div>
        ) : null}

        {emptyResult ? (
          <div style={{ ...box, background: "#fff3cd", color: "#7a5c00" }}>
            시트에서 옮길 데이터를 찾지 못했습니다. (빈 워크북이거나 학급/과제가 아직
            없음)
          </div>
        ) : null}

        {error ? (
          <div style={{ ...box, background: "#f8d7da", color: "#721c24" }}>❌ {error}</div>
        ) : null}
      </div>
    </Modal>
  );
}
