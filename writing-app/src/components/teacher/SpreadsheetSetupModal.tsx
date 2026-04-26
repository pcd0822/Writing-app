"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./SpreadsheetSetupModal.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { loadTeacherSettings, saveTeacherSettings } from "@/lib/teacherSettings";
import {
  pullDbFromSheetWithDiag,
  setActiveSpreadsheetId,
  type PullDiag,
} from "@/lib/spreadsheetSync";
import { saveTeacherDb } from "@/lib/localDb";
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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<PullSummary | null>(null);
  const [emptyNotice, setEmptyNotice] = useState<PullDiag | true | null>(null);

  async function onSave() {
    setError(null);
    setSuccess(null);
    setEmptyNotice(null);
    const id = spreadsheetId.trim();
    if (!id) {
      setError("스프레드시트 ID를 입력해주세요.");
      return;
    }
    setIsSaving(true);
    try {
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

      // 3) 시트의 기존 DB를 가져와 로컬에 저장 (push는 생략 — race 방지)
      const result = await pullDbFromSheetWithDiag(id);
      if (result.db) {
        const db = result.db as TeacherDb;
        saveTeacherDb(db, { skipRemotePush: true });
        const totalStudents = (db.classes || []).reduce(
          (sum, c) => sum + (c.students?.length || 0),
          0,
        );
        setSuccess({
          classes: db.classes?.length || 0,
          students: totalStudents,
          assignments: db.assignments?.length || 0,
          submissions: db.submissions?.length || 0,
        });
      } else {
        setEmptyNotice(result.diag ?? true);
      }

      onSaved();
    } catch (e) {
      setError((e as Error).message || "저장 실패");
    } finally {
      setIsSaving(false);
    }
  }

  function onCloseAndReset() {
    setError(null);
    setSuccess(null);
    setEmptyNotice(null);
    onClose();
  }

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

        {success ? (
          <div className={styles.successBox}>
            <div className={styles.successTitle}>✓ 시트에서 DB를 가져왔습니다</div>
            <div className={styles.successMeta}>
              학급 <b>{success.classes}</b>개 · 학생 <b>{success.students}</b>명 · 과제{" "}
              <b>{success.assignments}</b>개 · 제출 <b>{success.submissions}</b>건
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
