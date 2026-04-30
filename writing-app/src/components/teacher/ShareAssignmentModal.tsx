"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./ShareAssignmentModal.module.css";
import {
  createShareLink,
  isShareActive,
  loadTeacherDb,
  revokeAllSharesForAssignment,
  saveTeacherDb,
} from "@/lib/localDb";
import { loadTeacherSettings } from "@/lib/teacherSettings";
import { pushDbToSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";

type Props = {
  isOpen: boolean;
  assignmentId: string | null;
  onClose: () => void;
  onChanged: () => void;
};

function minutesFromNow(min: number) {
  return Date.now() + min * 60_000;
}

export function ShareAssignmentModal({
  isOpen,
  assignmentId,
  onClose,
  onChanged,
}: Props) {
  const [minutes, setMinutes] = useState(60);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localVer, setLocalVer] = useState(0);

  const db = useMemo(() => {
    if (!isOpen) return null;
    try {
      return loadTeacherDb();
    } catch {
      return null;
    }
  }, [isOpen, localVer]);

  const activeShare = useMemo(() => {
    if (!db || !assignmentId) return null;
    const shares = db.shares
      .filter((s) => s.assignmentId === assignmentId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const candidate = shares.find((s) => isShareActive(s)) || null;
    return candidate;
  }, [db, assignmentId]);

  const shareUrl = useMemo(() => {
    if (!activeShare) return null;
    if (typeof window === "undefined") return null;
    const sid = loadTeacherSettings()?.spreadsheetId;
    if (sid) return `${window.location.origin}/s/${activeShare.token}?sid=${encodeURIComponent(sid)}`;
    return `${window.location.origin}/s/${activeShare.token}`;
  }, [activeShare]);

  async function onCreate() {
    if (!assignmentId) return;
    setError(null);
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) {
      setError("유효시간(분)을 올바르게 입력해주세요.");
      return;
    }
    setIsCreating(true);
    try {
      const db0 = loadTeacherDb();
      const sid = loadTeacherSettings()?.spreadsheetId;
      if (sid) setActiveSpreadsheetId(sid);
      const { db: next } = createShareLink(db0, {
        assignmentId,
        expiresAt: minutesFromNow(m),
        spreadsheetId: sid,
      });
      // 시트가 연결되어 있으면 원격 반영이 끝난 뒤에 로컬 저장 + URL 노출을 한다.
      // 그래야 교사가 곧바로 링크를 공유했을 때 학생 디바이스가 시트를 끌어와
      // 토큰을 찾을 수 있다(레이스 방지).
      if (sid) {
        try {
          await pushDbToSheet(sid, next);
        } catch (e) {
          console.error("[Writing app] share push failed:", e);
          setError("시트 반영에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
          return;
        }
      }
      saveTeacherDb(next, { skipRemotePush: true });
      setLocalVer((v) => v + 1); // 모달 내 즉시 갱신
      onChanged();
    } catch {
      setError("공유 링크 생성에 실패했습니다.");
    } finally {
      setIsCreating(false);
    }
  }

  async function onRevoke() {
    if (!activeShare || !assignmentId) return;
    setError(null);
    setIsRevoking(true);
    try {
      const db0 = loadTeacherDb();
      const next = revokeAllSharesForAssignment(db0, assignmentId);
      saveTeacherDb(next);
      setLocalVer((v) => v + 1); // 모달 내 즉시 갱신
      onChanged();
    } catch {
      setError("공유 링크 폐기에 실패했습니다.");
    } finally {
      setIsRevoking(false);
    }
  }

  async function onCopy() {
    if (!shareUrl) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      setError("복사에 실패했습니다. 링크를 직접 선택해 복사해주세요.");
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="과제 공유 링크"
      description="교사가 공유한 링크가 유효할 때만 학생이 작문을 진행할 수 있습니다. 유효시간이 지나면 새로 생성해야 합니다."
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
          <Button onClick={onCreate} isLoading={isCreating}>
            새 링크 생성
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.row}>
          <label className={styles.label}>
            <span>유효시간(분)</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
          <div className={styles.quick}>
            {[15, 30, 60, 120].map((m) => (
              <button
                key={m}
                className={styles.quickBtn}
                onClick={() => setMinutes(m)}
              >
                {m}분
              </button>
            ))}
          </div>
        </div>

        <div className={styles.box}>
          <div className={styles.boxTitle}>현재 유효 링크</div>
          {activeShare && shareUrl ? (
            <>
              <div className={styles.urlRow}>
                <input className={styles.url} value={shareUrl} readOnly />
                <button className={styles.smallBtn} onClick={onCopy}>
                  복사
                </button>
              </div>
              <div className={styles.meta}>
                만료:{" "}
                <b>{new Date(activeShare.expiresAt).toLocaleString("ko-KR")}</b>
              </div>
              <button
                className={styles.revoke}
                onClick={() => setIsConfirmOpen(true)}
                disabled={isRevoking}
              >
                {isRevoking ? "폐기 중…" : "이 링크 폐기하기"}
              </button>
            </>
          ) : (
            <div className={styles.empty}>
              현재 유효한 공유 링크가 없습니다. “새 링크 생성”을 눌러 학생에게 공유하세요.
            </div>
          )}
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>

      <Modal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        title="이 링크를 폐기하시겠습니까?"
        description="폐기하면 이 링크로는 더 이상 학생이 작문을 이어갈 수 없습니다. 계속하려면 새 링크를 생성해야 합니다."
        size="lg"
        footer={
          <div className={styles.footer}>
            <Button
              variant="secondary"
              onClick={() => setIsConfirmOpen(false)}
              disabled={isRevoking}
            >
              취소
            </Button>
            <Button
              onClick={async () => {
                await onRevoke();
                setIsConfirmOpen(false);
              }}
              isLoading={isRevoking}
              disabled={!activeShare}
            >
              폐기하기
            </Button>
          </div>
        }
      >
        <div className={styles.body}>
          <div className={styles.box}>
            <div className={styles.boxTitle}>폐기 대상 링크</div>
            {shareUrl ? (
              <div className={styles.urlRow}>
                <input className={styles.url} value={shareUrl} readOnly />
              </div>
            ) : (
              <div className={styles.empty}>폐기할 유효 링크가 없습니다.</div>
            )}
          </div>
        </div>
      </Modal>
    </Modal>
  );
}

