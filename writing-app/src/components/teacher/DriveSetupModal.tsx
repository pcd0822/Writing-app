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
  const [folderIdInput, setFolderIdInput] = useState("");
  const [hasOAuth, setHasOAuth] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const s = loadTeacherSettings();
    setFolderIdInput(s?.driveFolderId || "");
    setHasOAuth(!!s?.driveOAuthRefreshToken?.trim());
    setError(null);
  }, [isOpen]);

  async function onStartGoogleOAuth() {
    setError(null);
    const prev = loadTeacherSettings();
    if (!prev?.spreadsheetId) {
      setError("먼저 구글 스프레드시트(DB) 연결을 완료해주세요.");
      return;
    }
    try {
      const redirectUri = `${window.location.origin}/teacher/drive-callback`;
      const res = await callFunction<{ ok: true; url: string }>("google-drive-oauth-url", {
        redirectUri,
      });
      window.location.href = res.url;
    } catch (e) {
      setError((e as Error).message || "OAuth URL 생성 실패");
    }
  }

  function onDisconnectGoogle() {
    const prev = loadTeacherSettings();
    if (!prev?.spreadsheetId) return;
    saveTeacherSettings({
      spreadsheetId: prev.spreadsheetId,
      driveFolderId: prev.driveFolderId,
      driveOAuthRefreshToken: undefined,
    });
    setHasOAuth(false);
    onSaved();
  }

  async function onSaveFolder() {
    setError(null);
    const prev = loadTeacherSettings();
    if (!prev?.spreadsheetId) {
      setError("먼저 구글 스프레드시트(DB) 연결을 완료해주세요.");
      return;
    }
    if (!prev.driveOAuthRefreshToken?.trim()) {
      setError("먼저 아래「Google 계정으로 연결」을 완료해주세요.");
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
      }>("drive-verify-folder", {
        folderId,
        refreshToken: prev.driveOAuthRefreshToken,
      });
      saveTeacherSettings({
        spreadsheetId: prev.spreadsheetId,
        driveFolderId: res.folderId,
        driveOAuthRefreshToken: prev.driveOAuthRefreshToken,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message || "연결 실패");
    } finally {
      setIsSaving(false);
    }
  }

  const connectedFolderId = loadTeacherSettings()?.driveFolderId;
  const oauthOk = hasOAuth || !!loadTeacherSettings()?.driveOAuthRefreshToken?.trim();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="구글 드라이브(첨부) 연결"
      description="과제 첨부는 교사님 Google 계정 용량에 저장됩니다. 서비스 계정 공유 방식은 사용하지 않습니다."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            닫기
          </Button>
          <Button onClick={() => void onSaveFolder()} isLoading={isSaving} disabled={!oauthOk}>
            폴더 저장
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.hint} style={{ marginBottom: 14 }}>
          <b>1)</b> Google Cloud Console → API 및 서비스 → 사용자 인증 정보에서{" "}
          <b>OAuth 2.0 클라이언트 ID</b>(웹 애플리케이션)를 만들고, 승인된 리디렉션 URI에{" "}
          <span className={styles.mono}>
            https://(배포주소)/teacher/drive-callback
          </span>{" "}
          및 로컬용 <span className={styles.mono}>http://localhost:3000/teacher/drive-callback</span> 등을
          넣으세요.
          <br />
          <b>2)</b> 아래 버튼으로 <b>같은 Google 계정</b>(과제를 저장할 Drive가 있는 계정)으로 로그인합니다.
          <br />
          <b>3)</b> 그 계정의 Drive에서 폴더를 만들고, 주소의 <span className={styles.mono}>/folders/</span>{" "}
          뒤 ID를 입력한 뒤 <b>폴더 저장</b>을 누릅니다.
        </div>

        <div style={{ marginBottom: 14 }}>
          {oauthOk ? (
            <div
              style={{
                padding: "10px 12px",
                background: "#ecfdf5",
                borderRadius: 10,
                fontSize: 13,
                color: "#065f46",
              }}
            >
              Google 계정 연결됨 (refresh token 저장됨)
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => void onStartGoogleOAuth()}>
              Google 계정으로 드라이브 연결
            </Button>
          )}
          {oauthOk ? (
            <button
              type="button"
              onClick={onDisconnectGoogle}
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "#64748b",
                background: "none",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Google 연결 해제
            </button>
          ) : null}
        </div>

        <label className={styles.label}>
          <span>폴더 ID 또는 폴더 URL</span>
          <input
            className={styles.input}
            value={folderIdInput}
            onChange={(e) => setFolderIdInput(e.target.value)}
            placeholder="예) 1a2b3c... 또는 https://drive.google.com/drive/folders/..."
            disabled={!oauthOk}
          />
        </label>

        {connectedFolderId ? (
          <div className={styles.hint} style={{ marginTop: 12 }}>
            저장된 폴더: <span className={styles.mono}>{connectedFolderId}</span>
          </div>
        ) : null}

        <div className={styles.hint} style={{ marginTop: 12 }}>
          업로드된 파일은 학생이 받을 수 있도록 &quot;링크가 있는 모든 사용자&quot; 읽기로 공개됩니다.
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}
