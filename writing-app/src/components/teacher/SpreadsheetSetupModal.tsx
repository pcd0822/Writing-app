"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./SpreadsheetSetupModal.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { loadTeacherSettings, saveTeacherSettings } from "@/lib/teacherSettings";
import {
  pullDbFromSheetWithRetry,
  pushDbToSheet,
  setActiveSpreadsheetId,
  type PullDiag,
} from "@/lib/spreadsheetSync";
import { loadTeacherDb, mergeTeacherDbs, saveTeacherDb } from "@/lib/localDb";
import type { TeacherDb } from "@/lib/types";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type PullSummary = {
  classes: number;
  students: number;
  assignments: number;
  submissions: number;
};

export function SpreadsheetSetupModal({ isOpen, onClose, onSaved }: Props) {
  const current = loadTeacherSettings();
  const [spreadsheetId, setSpreadsheetId] = useState(current?.spreadsheetId || "");
  const [isSaving, setIsSaving] = useState(false);
  const [stage, setStage] = useState<
    null | "init" | "pulling" | "retrying" | "merging" | "uploading"
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<PullSummary | null>(null);
  const [emptyNotice, setEmptyNotice] = useState<PullDiag | true | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    id: string;
    diag: PullDiag | null;
  } | null>(null);

  async function onSave() {
    setError(null);
    setSuccess(null);
    setEmptyNotice(null);
    setPendingUpload(null);
    const id = spreadsheetId.trim();
    if (!id) {
      setError("스프레드시트 ID를 입력해주세요.");
      return;
    }
    setIsSaving(true);
    try {
      setStage("init");
      // 1) 시트 구조 보장 (없는 탭만 추가)
      await callFunction<{ ok: true }>("sheets-init", { spreadsheetId: id });

      // 2) 로컬 설정 저장 + 활성 시트 ID 등록
      const prev = loadTeacherSettings();
      saveTeacherSettings({
        spreadsheetId: id,
        driveFolderId: prev?.driveFolderId,
        driveOAuthRefreshToken: prev?.driveOAuthRefreshToken,
      });
      setActiveSpreadsheetId(id);

      // 3) retry로 시트 lag를 흡수해 안전하게 pull.
      setStage("pulling");
      const result = await pullDbFromSheetWithRetry(id, {
        attempts: 3,
        delayMs: 900,
        onAttempt: (n) => {
          if (n > 1) setStage("retrying");
        },
      });
      const local = loadTeacherDb();
      if (result.db) {
        setStage("merging");
        const remoteDb = result.db as TeacherDb;
        const merged = mergeTeacherDbs(local, remoteDb);
        saveTeacherDb(merged, { skipRemotePush: true });
        // 로컬에만 있던 항목을 시트에도 정착(다른 디바이스에서 보이도록).
        try {
          setStage("uploading");
          await pushDbToSheet(id, merged, { skipPullMerge: true });
        } catch (e) {
          console.warn("[Writing app] sheet-setup post-push failed:", e);
        }
        const totalStudents = (merged.classes || []).reduce(
          (sum, c) => sum + (c.students?.length || 0),
          0,
        );
        setSuccess({
          classes: merged.classes?.length || 0,
          students: totalStudents,
          assignments: merged.assignments?.length || 0,
          submissions: merged.submissions?.length || 0,
        });
        onSaved();
      } else {
        // 빈 시트로 확정. 로컬 데이터가 있더라도 자동 업로드는 하지 않는다.
        // (다른 교사의 데이터가 propagation lag로 빈 결과처럼 보인 경우, 자동
        //  업로드가 그 데이터를 덮어쓰는 데이터 손실을 일으키기 때문.)
        const hasLocalData =
          (local.classes?.length || 0) > 0 ||
          (local.assignments?.length || 0) > 0 ||
          (local.submissions?.length || 0) > 0;
        if (hasLocalData) {
          setPendingUpload({ id, diag: result.diag ?? null });
        } else {
          setEmptyNotice(result.diag ?? true);
        }
        onSaved();
      }
    } catch (e) {
      setError((e as Error).message || "저장 실패");
    } finally {
      setStage(null);
      setIsSaving(false);
    }
  }

  /** 사용자가 명시적으로 "내 로컬 데이터를 시트로 업로드" 확인했을 때만 실행. */
  async function onConfirmUpload() {
    if (!pendingUpload) return;
    setError(null);
    setIsSaving(true);
    try {
      setStage("uploading");
      const local = loadTeacherDb();
      await pushDbToSheet(pendingUpload.id, local, { skipPullMerge: true });
      const totalStudents = (local.classes || []).reduce(
        (sum, c) => sum + (c.students?.length || 0),
        0,
      );
      setSuccess({
        classes: local.classes?.length || 0,
        students: totalStudents,
        assignments: local.assignments?.length || 0,
        submissions: local.submissions?.length || 0,
      });
      setPendingUpload(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message || "업로드 실패");
    } finally {
      setStage(null);
      setIsSaving(false);
    }
  }

  function onCloseAndReset() {
    setError(null);
    setSuccess(null);
    setEmptyNotice(null);
    setPendingUpload(null);
    onClose();
  }

  const stageLabel = (() => {
    switch (stage) {
      case "init":
        return "시트 구조 점검 중…";
      case "pulling":
        return "시트에서 데이터 가져오는 중…";
      case "retrying":
        return "시트 응답 지연. 재시도 중…";
      case "merging":
        return "로컬 데이터와 병합 중…";
      case "uploading":
        return "시트에 반영 중…";
      default:
        return "";
    }
  })();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCloseAndReset}
      title="구글 스프레드시트(DB) 연결"
      description="교사님의 스프레드시트를 DB로 사용합니다. 시트는 서비스 계정 이메일에 '편집자'로 공유되어 있어야 합니다 (개인 Gmail이 아닌 서버측 service account)."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onCloseAndReset} disabled={isSaving}>
            닫기
          </Button>
          <Button onClick={onSave} isLoading={isSaving}>
            {success || emptyNotice ? "다시 가져오기" : "연결하기"}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <label className={styles.label}>
          <span>스프레드시트 ID</span>
          <input
            className={styles.input}
            value={spreadsheetId}
            onChange={(e) => setSpreadsheetId(e.target.value)}
            placeholder="예) 1AbC... (URL의 /d/ 와 /edit 사이)"
          />
        </label>
        <div className={styles.hint}>
          스프레드시트 URL 예:{" "}
          <span className={styles.mono}>
            https://docs.google.com/spreadsheets/d/&lt;ID&gt;/edit
          </span>
        </div>

        {isSaving && stage ? (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1e3a8a",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
            role="status"
            aria-live="polite"
          >
            <span
              style={{
                width: 14,
                height: 14,
                border: "2px solid #bfdbfe",
                borderTopColor: "#2563eb",
                borderRadius: "50%",
                display: "inline-block",
                animation: "spin 0.9s linear infinite",
              }}
            />
            {stageLabel}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : null}

        {success ? (
          <div className={styles.successBox}>
            <div className={styles.successTitle}>✓ 시트에서 DB를 가져왔습니다</div>
            <div className={styles.successMeta}>
              학급 <b>{success.classes}</b>개 · 학생 <b>{success.students}</b>명 · 과제{" "}
              <b>{success.assignments}</b>개 · 제출 <b>{success.submissions}</b>건
            </div>
          </div>
        ) : null}

        {pendingUpload ? (
          <div className={styles.warnBox}>
            <div className={styles.warnTitle}>
              시트에서 데이터를 가져오지 못했습니다 (여러 번 재시도)
            </div>
            <div className={styles.warnMeta}>
              로컬 디바이스에는 데이터가 있지만 시트에서 데이터를 확인하지 못했습니다.
              <br />
              <b>다른 교사가 같은 시트를 사용 중이라면</b>, 그 데이터가 일시적으로 보이지
              않는 것일 수 있습니다. 잠시 후 &ldquo;다시 가져오기&rdquo;를 눌러보세요.
              <br />
              <br />
              만약 시트가 정말 비어있고 <b>로컬 데이터를 시트로 업로드</b>하려면 아래
              버튼을 눌러주세요. (이 작업은 시트의 모든 기존 데이터가 로컬 데이터로
              교체될 수 있으니 주의하세요.)
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <Button onClick={onConfirmUpload} isLoading={isSaving}>
                  로컬 데이터를 시트로 업로드
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setPendingUpload(null)}
                  disabled={isSaving}
                >
                  취소
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {emptyNotice ? (
          <div className={styles.warnBox}>
            <div className={styles.warnTitle}>시트는 연결됐지만 가져올 데이터가 없습니다</div>
            <div className={styles.warnMeta}>
              {typeof emptyNotice === "object" ? (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <b>시트 진단:</b>
                    <ul style={{ margin: "4px 0 8px 18px" }}>
                      <li>
                        meta!A1: {emptyNotice.metaCellLen > 0
                          ? `${emptyNotice.metaCellLen}자 (${emptyNotice.metaParsed ? "정상 파싱됨" : "파싱 실패"})`
                          : "비어 있음"}
                      </li>
                      <li>classes 행: {emptyNotice.tabularRowCounts.classes}</li>
                      <li>students 행: {emptyNotice.tabularRowCounts.students}</li>
                      <li>assignments 행: {emptyNotice.tabularRowCounts.assignments}</li>
                      <li>submissions 행: {emptyNotice.tabularRowCounts.submissions}</li>
                    </ul>
                  </div>
                  {emptyNotice.tabularRowCounts.classes > 0 ||
                  emptyNotice.tabularRowCounts.students > 0 ? (
                    <div style={{ color: "var(--danger)", marginBottom: 8 }}>
                      <b>⚠ 시트에 행은 있지만 복원하지 못했습니다.</b> 헤더가 변경됐거나 컬럼 순서가 다를 수 있습니다.
                      배포된 Netlify 함수가 최신 코드인지 확인해 주세요(재배포 필요).
                    </div>
                  ) : null}
                </>
              ) : null}
              가능한 원인:
              <ul>
                <li>다른 디바이스에서 한 번도 저장(push)되지 않았습니다.</li>
                <li>시트 ID가 다릅니다 (URL의 /d/ 뒤 부분 재확인).</li>
                <li>시트가 서비스 계정 이메일에 공유되어 있지 않습니다.</li>
                <li>배포된 Netlify 함수가 옛 버전입니다 (수정사항이 반영되지 않음 → 재배포 필요).</li>
              </ul>
            </div>
          </div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}
