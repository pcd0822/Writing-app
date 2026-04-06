"use client";

import { useEffect, useState } from "react";
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

function extractFolderIdFromInput(raw: string): string {
  const t = raw.trim();
  const m = t.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m?.[1]) return m[1];
  return t;
}

export function DriveSetupModal({ isOpen, onClose, onSaved }: Props) {
  const connectedFolderId = loadTeacherSettings()?.driveFolderId;
  const [folderIdInput, setFolderIdInput] = useState("");
  const [serviceEmail, setServiceEmail] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const s = loadTeacherSettings();
    setFolderIdInput(s?.driveFolderId || "");
    setError(null);
    void callFunction<{ ok: true; clientEmail: string }>("drive-service-email", {})
      .then((r) => setServiceEmail(r.clientEmail))
      .catch(() => setServiceEmail(null));
  }, [isOpen]);

  async function onConnect() {
    setError(null);
    const prev = loadTeacherSettings();
    if (!prev?.spreadsheetId) {
      setError("먼저 구글 스프레드시트(DB) 연결을 완료해주세요.");
      return;
    }
    const folderId = extractFolderIdFromInput(folderIdInput);
    if (!folderId) {
      setError("폴더 ID 또는 폴더 URL을 입력해주세요.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await callFunction<{
        ok: true;
        folderId: string;
        folderName: string;
      }>("drive-verify-folder", { folderId });
      saveTeacherSettings({
        spreadsheetId: prev.spreadsheetId,
        driveFolderId: res.folderId,
      });
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
      description="서비스 계정에는 저장 용량이 없습니다. 교사님 드라이브의 폴더를 만든 뒤, 아래 이메일을 그 폴더에 편집자로 공유한 다음 폴더 ID를 입력하세요."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            닫기
          </Button>
          <Button onClick={() => void onConnect()} isLoading={isSaving}>
            연결 확인
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.hint} style={{ marginBottom: 14 }}>
          <b>1)</b> Google Drive에서 새 <b>폴더</b>를 만듭니다.
          <br />
          <b>2)</b> 폴더를 우클릭 → <b>공유</b> → 아래 서비스 계정 이메일을 <b>편집자</b>로
          추가합니다.
          <br />
          <b>3)</b> 폴더를 연 뒤 주소창의 <span className={styles.mono}>/folders/뒤의_ID</span>를
          복사하거나, 아래 칸에 붙여넣습니다.
        </div>

        {serviceEmail ? (
          <div
            className={styles.mono}
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              background: "#f1f5f9",
              borderRadius: 10,
              fontSize: 13,
              wordBreak: "break-all",
            }}
          >
            {serviceEmail}
          </div>
        ) : (
          <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.75 }}>
            서비스 계정 이메일을 불러오는 중…
          </div>
        )}

        <label className={styles.label}>
          <span>폴더 ID 또는 폴더 URL</span>
          <input
            className={styles.input}
            value={folderIdInput}
            onChange={(e) => setFolderIdInput(e.target.value)}
            placeholder="예) 1a2b3c... 또는 https://drive.google.com/drive/folders/..."
          />
        </label>

        {connectedFolderId ? (
          <div className={styles.hint} style={{ marginTop: 12 }}>
            현재 연결: <span className={styles.mono}>{connectedFolderId}</span>
          </div>
        ) : null}

        <div className={styles.hint} style={{ marginTop: 12 }}>
          업로드된 파일은 학생이 받을 수 있도록 &quot;링크가 있는 모든 사용자&quot; 읽기로
          공개됩니다. 공유 드라이브를 쓰는 경우에도, 서비스 계정을 해당 드라이브 멤버로 두면 같은 방식으로
          사용할 수 있습니다.
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}
