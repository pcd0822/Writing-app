"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./ShareAssignmentModal.module.css";
import {
  createShareLink,
  isShareActive,
  loadTeacherDb,
  mergeRemoteSharesFromSheet,
  mergeRemoteSharesIntoLocalDb,
  revokeAllSharesForAssignment,
  saveTeacherDb,
} from "@/lib/localDb";
import { loadTeacherSettings } from "@/lib/teacherSettings";
import {
  flushPendingPush,
  pullDbFromSheetWithRetry,
  pushDbToSheet,
  setActiveSpreadsheetId,
} from "@/lib/spreadsheetSync";
import type { TeacherDb } from "@/lib/types";

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
  const [info, setInfo] = useState<string | null>(null);
  const [isSyncingShares, setIsSyncingShares] = useState(false);
  const [localVer, setLocalVer] = useState(0);

  const db = useMemo(() => {
    if (!isOpen) return null;
    try {
      return loadTeacherDb();
    } catch {
      return null;
    }
  }, [isOpen, localVer]);

  /**
   * 모달이 열릴 때 시트에서 다른 교사가 만든 공유를 끌어와 표시한다.
   * 두 교사가 같은 과제에 대해 새 링크를 동시에 만드는 충돌을 예방.
   */
  useEffect(() => {
    if (!isOpen || !assignmentId) return;
    const sid = loadTeacherSettings()?.spreadsheetId;
    if (!sid) return;
    let cancelled = false;
    setIsSyncingShares(true);
    setError(null);
    setInfo(null);
    void mergeRemoteSharesFromSheet(sid)
      .then((merged) => {
        if (cancelled || !merged) return;
        const hasOther = merged.shares.some(
          (s) => s.assignmentId === assignmentId && isShareActive(s),
        );
        if (hasOther) {
          setInfo(
            "다른 디바이스에서 만든 활성 공유 링크를 시트에서 가져왔습니다. 새로 만들지 말고 이 링크를 공유해주세요.",
          );
        }
        setLocalVer((v) => v + 1);
      })
      .finally(() => {
        if (!cancelled) setIsSyncingShares(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, assignmentId]);

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
    setInfo(null);
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) {
      setError("유효시간(분)을 올바르게 입력해주세요.");
      return;
    }
    setIsCreating(true);
    try {
      const sid = loadTeacherSettings()?.spreadsheetId;
      if (sid) setActiveSpreadsheetId(sid);

      // 1) 다른 교사의 변경이 묻히지 않도록 시트에서 최신 상태를 먼저 끌어와 머지.
      //    또 진행 중인 코얼레싱 푸시가 있다면 끝낸 뒤에 pull → 우리 푸시가
      //    덮어쓸 baseline에 다른 교사의 공유가 반드시 포함되도록 한다.
      let baseDb = loadTeacherDb();
      if (sid) {
        try {
          await flushPendingPush(sid);
          const result = await pullDbFromSheetWithRetry(sid, {
            attempts: 2,
            delayMs: 700,
          });
          if (result.db) {
            baseDb = mergeRemoteSharesIntoLocalDb(baseDb, result.db as TeacherDb);
          }
        } catch (e) {
          console.warn("[Writing app] share-create pre-pull failed:", e);
          // 네트워크 실패 시 로컬만으로 진행 — 한쪽 교사라도 동작하도록 fail-soft.
        }
      }

      // 2) 이미 활성 공유가 있으면 그것을 재사용하라고 안내(중복 생성 방지).
      const existingActive = baseDb.shares
        .filter((s) => s.assignmentId === assignmentId && isShareActive(s))
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      if (existingActive) {
        // baseline(머지된 결과)을 로컬에 저장해 모달이 즉시 그 링크를 보여주도록.
        saveTeacherDb(baseDb, { skipRemotePush: true });
        setLocalVer((v) => v + 1);
        onChanged();
        setInfo(
          `이미 활성 공유 링크가 존재합니다(만료 ${new Date(existingActive.expiresAt).toLocaleString(
            "ko-KR",
          )}). 중복 생성을 막기 위해 이 링크를 그대로 공유해주세요. 새로 만들려면 먼저 폐기하세요.`,
        );
        return;
      }

      // 3) 머지된 baseline 위에 새 토큰을 올리고 시트에 반영. 그래야 다른 교사의
      //    기존 공유가 우리 푸시로 사라지지 않는다.
      const { db: next } = createShareLink(baseDb, {
        assignmentId,
        expiresAt: minutesFromNow(m),
        spreadsheetId: sid,
      });

      if (sid) {
        try {
          await pushDbToSheet(sid, next, { skipPullMerge: true });
        } catch (e) {
          console.error("[Writing app] share push failed:", e);
          setError("시트 반영에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
          return;
        }
      }
      saveTeacherDb(next, { skipRemotePush: true });
      setLocalVer((v) => v + 1);
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
    setInfo(null);
    setIsRevoking(true);
    try {
      const sid = loadTeacherSettings()?.spreadsheetId;
      // 다른 교사의 신규 공유가 묻히지 않도록 폐기 직전에도 머지.
      let baseDb = loadTeacherDb();
      if (sid) {
        try {
          await flushPendingPush(sid);
          const result = await pullDbFromSheetWithRetry(sid, {
            attempts: 2,
            delayMs: 700,
          });
          if (result.db)
            baseDb = mergeRemoteSharesIntoLocalDb(baseDb, result.db as TeacherDb);
        } catch (e) {
          console.warn("[Writing app] revoke pre-pull failed:", e);
        }
      }
      const next = revokeAllSharesForAssignment(baseDb, assignmentId);
      // 폐기는 학생 접근을 즉시 끊어야 하므로 코얼레싱이 아닌 직접 푸시.
      if (sid) {
        try {
          await pushDbToSheet(sid, next, { skipPullMerge: true });
        } catch (e) {
          console.error("[Writing app] revoke push failed:", e);
          setError("시트 반영에 실패했습니다. 네트워크 확인 후 다시 시도해주세요.");
          return;
        }
      }
      saveTeacherDb(next, { skipRemotePush: true });
      setLocalVer((v) => v + 1);
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
          <div className={styles.boxTitle}>
            현재 유효 링크{isSyncingShares ? " (시트에서 확인 중…)" : ""}
          </div>
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

        {info ? (
          <div
            className={styles.error}
            style={{
              background: "#eff6ff",
              borderColor: "#bfdbfe",
              color: "#1e3a8a",
            }}
          >
            {info}
          </div>
        ) : null}
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

