"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./SpreadsheetSetupModal.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { loadTeacherSettings, saveTeacherSettings } from "@/lib/teacherSettings";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function DriveSetupModal({ isOpen, onClose, onSaved }: Props) {
  const current = loadTeacherSettings();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConnect() {
    setError(null);
    const prev = loadTeacherSettings();
    if (!prev?.spreadsheetId) {
      setError("먼저 구글 스프레드시트(DB) 연결을 완료해주세요.");
      return;
    }
    setIsSaving(true);
    try {
      const res = await callFunction<{ ok: true; folderId: string }>("drive-init", {});
      saveTeacherSettings({ spreadsheetId: prev.spreadsheetId, driveFolderId: res.folderId });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message || "연결 실패");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="구글 드라이브(첨부) 연결"
      description="과제 첨부 파일을 서비스 계정 드라이브에 저장해, 학생이 시트 동기화 후에도 내려받을 수 있게 합니다. Google Cloud에서 Drive API를 켠 뒤 사용하세요."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            닫기
          </Button>
          <Button onClick={() => void onConnect()} isLoading={isSaving}>
            {current?.driveFolderId ? "새 폴더 만들고 다시 연결" : "폴더 생성 및 연결"}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        {current?.driveFolderId ? (
          <div className={styles.hint} style={{ marginBottom: 12 }}>
            현재 폴더 ID: <span className={styles.mono}>{current.driveFolderId}</span>
            <br />
            다시 연결하면 새 루트 폴더가 하나 더 만들어집니다. (기존 폴더는 드라이브에서 직접 정리할 수
            있습니다.)
          </div>
        ) : null}
        <div className={styles.hint}>
          스프레드시트와 동일한 서비스 계정이 사용됩니다. 첨부는 업로드 후 &quot;링크가 있는 모든
          사용자&quot; 읽기 권한으로 공개되어, 학생이 로그인 없이 ZIP으로 받을 수 있습니다.
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}
