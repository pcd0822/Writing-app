"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./SpreadsheetSetupModal.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { loadTeacherSettings, saveTeacherSettings } from "@/lib/teacherSettings";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";
import { saveTeacherDb } from "@/lib/localDb";
import type { TeacherDb } from "@/lib/types";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function SpreadsheetSetupModal({ isOpen, onClose, onSaved }: Props) {
  const current = loadTeacherSettings();
  const [spreadsheetId, setSpreadsheetId] = useState(current?.spreadsheetId || "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    setError(null);
    const id = spreadsheetId.trim();
    if (!id) {
      setError("스프레드시트 ID를 입력해주세요.");
      return;
    }
    setIsSaving(true);
    try {
      await callFunction<{ ok: true }>("sheets-init", { spreadsheetId: id });
      saveTeacherSettings({ spreadsheetId: id });
      setActiveSpreadsheetId(id);
      // 시트에 기존 DB가 있으면 pull해서 로컬을 최신으로 맞춤(기기 이동 대비)
      const remote = await pullDbFromSheet(id);
      if (remote) saveTeacherDb(remote as TeacherDb);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message || "저장 실패");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="구글 스프레드시트(DB) 연결"
      description="교사님의 스프레드시트를 DB로 사용합니다. 서비스 계정 이메일을 시트에 '공유'하고, 스프레드시트 ID를 입력하세요."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            닫기
          </Button>
          <Button onClick={onSave} isLoading={isSaving}>
            연결하기
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
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}

