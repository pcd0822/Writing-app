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
};

type ExportResponse = { ok: true; counts: Counts | null };

type Props = {
  isOpen: boolean;
  onClose: () => void;
  spreadsheetId: string | null;
};

const box: React.CSSProperties = { padding: 12, borderRadius: 6, fontSize: 13 };

export function BackupToSheetModal({ isOpen, onClose, spreadsheetId }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  function reset() {
    setError(null);
    setCounts(null);
    setEmptyResult(false);
  }

  async function onExport() {
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
      const res = await callFunction<ExportResponse>(
        "supabase-export-to-sheet",
        { spreadsheetId },
        { authToken: token, retries: 0 },
      );
      if (res.counts == null) setEmptyResult(true);
      else setCounts(res.counts);
    } catch (e) {
      setError((e as Error).message || "백업 실패");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="📥 시트로 백업"
      description="Supabase의 현재 데이터를 연결된 스프레드시트로 덤프합니다."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            닫기
          </Button>
          <Button onClick={onExport} isLoading={running} loadingLabel="백업 중">
            지금 백업
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
          시트 전체를 Supabase 기준으로 다시 씁니다(기존 시트 내용은 덮어쓰기). 학생 작업은
          이 백업과 무관하게 Supabase에 계속 저장됩니다.
        </p>
        {spreadsheetId ? (
          <p style={{ fontSize: 13, color: "#666", margin: 0 }}>
            대상 시트 ID: <code>{spreadsheetId.slice(0, 12)}…</code>
          </p>
        ) : null}

        {!isUsingSupabase ? (
          <div style={{ ...box, background: "#fff3cd", color: "#7a5c00" }}>
            ⚠️ 클라이언트가 시트 모드입니다. 이 버튼은 Supabase에 별도로 옮겨둔 데이터가
            있을 때만 의미가 있습니다 — 보통은 <code>NEXT_PUBLIC_USE_SUPABASE=true</code>
            로 운영 중일 때 사용합니다.
          </div>
        ) : null}

        {counts ? (
          <div style={{ ...box, background: "#e7f5ff", color: "#0b3d66" }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>✅ 백업 완료</div>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              <li>
                학급 {counts.classes}개 / 학생 {counts.students}명
              </li>
              <li>
                과제 {counts.assignments}개 / 할당 {counts.allocations}건 / 공유 링크{" "}
                {counts.shares}개
              </li>
              <li>제출물 {counts.submissions}개</li>
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
            Supabase에 백업할 데이터가 없습니다. 시트가 통째로 비워지는 사고를 막기 위해
            기존 시트는 그대로 둡니다.
          </div>
        ) : null}

        {error ? (
          <div style={{ ...box, background: "#f8d7da", color: "#721c24" }}>❌ {error}</div>
        ) : null}
      </div>
    </Modal>
  );
}
