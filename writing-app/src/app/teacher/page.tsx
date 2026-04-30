"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../providers";
import { signOutCurrentUser } from "@/lib/auth";
import { CreateClassModal } from "@/components/teacher/CreateClassModal";
import {
  deleteAssignment,
  deleteClass,
  loadTeacherDb,
  mergeTeacherDbs,
  saveTeacherDb,
} from "@/lib/localDb";
import {
  flushPendingPush,
  pullDbFromSheetWithRetry,
  pushDbToSheet,
  setActiveSpreadsheetId,
} from "@/lib/spreadsheetSync";
import type { TeacherDb } from "@/lib/types";
import styles from "./teacher.module.css";
import { SpreadsheetSetupModal } from "@/components/teacher/SpreadsheetSetupModal";
import { DriveSetupModal } from "@/components/teacher/DriveSetupModal";
import { loadTeacherSettings } from "@/lib/teacherSettings";
import { CreateAssignmentModal } from "@/components/teacher/CreateAssignmentModal";
import { ShareAssignmentModal } from "@/components/teacher/ShareAssignmentModal";
import { StudentCodeExport } from "@/components/teacher/StudentCodeExport";
import { EditAssignmentModal } from "@/components/teacher/EditAssignmentModal";
import { Modal } from "@/components/ui/Modal";

type DeleteTarget =
  | { kind: "class"; id: string; name: string; studentCount: number; submissionCount: number }
  | { kind: "assignment"; id: string; title: string; submissionCount: number };

export default function TeacherPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isCreateClassOpen, setIsCreateClassOpen] = useState(false);
  const [isSheetSetupOpen, setIsSheetSetupOpen] = useState(false);
  const [isDriveSetupOpen, setIsDriveSetupOpen] = useState(false);
  const [isCreateAssignmentOpen, setIsCreateAssignmentOpen] = useState(false);
  const [shareAssignmentId, setShareAssignmentId] = useState<string | null>(null);
  const [editAssignmentId, setEditAssignmentId] = useState<string | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [dbVersion, setDbVersion] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStage, setSyncStage] = useState<
    | null
    | "flushing"
    | "pulling"
    | "retrying"
    | "merging"
    | "pushing"
    | "polling"
  >(null);
  const [pollingElapsed, setPollingElapsed] = useState(0);
  const syncCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const [syncStatus, setSyncStatus] = useState<{
    kind: "ok" | "empty" | "warn" | "err";
    msg: string;
  } | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace("/");
  }, [isLoading, user, router]);

  /** 기존 공유 링크에 스프레드시트 ID가 없으면 현재 DB 연결 ID로 채워 학생 측 시트 동기화가 되도록 함 */
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    try {
      const sid = loadTeacherSettings()?.spreadsheetId;
      if (!sid) return;
      const db = loadTeacherDb();
      let changed = false;
      const shares = db.shares.map((s) => {
        if (s.revokedAt == null && !s.spreadsheetId) {
          changed = true;
          return { ...s, spreadsheetId: sid };
        }
        return s;
      });
      if (changed) {
        saveTeacherDb({ ...db, shares });
        setDbVersion((v) => v + 1);
      }
    } catch {
      /* ignore */
    }
  }, [user]);

  const displayName = useMemo(() => {
    if (!user) return "";
    return user.displayName || user.email || "교사";
  }, [user]);

  async function onSignOut() {
    setIsSigningOut(true);
    try {
      await signOutCurrentUser();
      router.replace("/");
    } finally {
      setIsSigningOut(false);
    }
  }

  const db = useMemo(() => {
    if (typeof window === "undefined")
      return { version: 2 as const, classes: [], assignments: [], allocations: [] };
    try {
      return loadTeacherDb();
    } catch {
      return { version: 2 as const, classes: [], assignments: [], allocations: [] };
    }
  }, [dbVersion]);

  const selectedClass = useMemo(() => {
    if (!selectedClassId) return null;
    return db.classes.find((c) => c.id === selectedClassId) || null;
  }, [db.classes, selectedClassId]);

  const allocationsByAssignmentId = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of db.allocations) m.set(a.assignmentId, a.targets.length);
    return m;
  }, [db.allocations]);

  const sheetId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return loadTeacherSettings()?.spreadsheetId || null;
  }, [dbVersion]);

  const driveReady = useMemo(() => {
    if (typeof window === "undefined") return false;
    const s = loadTeacherSettings();
    return !!(s?.driveFolderId && s?.driveOAuthRefreshToken);
  }, [dbVersion]);

  function refreshDb() {
    setDbVersion((v) => v + 1);
  }

  /**
   * 시트에서 원격 DB를 가져와 로컬과 양방향 머지.
   *
   * 안전성 설계:
   *  - pull은 retry로 시트 propagation lag를 흡수.
   *  - 빈 결과여도 로컬을 자동으로 시트에 덮어쓰지 않는다(데이터 손실 방지).
   *  - **push back은 직접 호출하지 않고 saveTeacherDb로 코얼레싱에 위임**한다.
   *    코얼레싱 push 자체가 pre-pull merge로 안전하게 다른 디바이스의 변경을
   *    union하므로, 이번 머지 시점에 lag로 share가 비어있어도 800ms 뒤의
   *    코얼레싱 push가 시트의 최신 share를 다시 보존한다.
   *  - **활성 공유링크 long polling**: 머지 결과에 active share가 0인데 시트에
   *    공유가 있을 가능성(lag)이 있으므로, 사용자가 명시 취소 또는 share 발견 또는
   *    timeout(180초)까지 5초 간격 polling. 그 동안 로딩 오버레이 유지.
   */
  function cancelOngoingSync() {
    syncCancelRef.current.cancelled = true;
  }

  async function syncFromSheet(silent = false) {
    if (typeof window === "undefined") return;
    const sid = loadTeacherSettings()?.spreadsheetId;
    if (!sid) {
      if (!silent)
        setSyncStatus({ kind: "err", msg: "먼저 'DB 연결'에서 스프레드시트 ID를 등록해주세요." });
      return;
    }
    syncCancelRef.current = { cancelled: false };
    if (!silent) setIsSyncing(true);
    setSyncStatus(null);
    setPollingElapsed(0);
    try {
      setActiveSpreadsheetId(sid);

      // 1) 진행 중인 변경을 먼저 시트에 반영
      setSyncStage("flushing");
      await flushPendingPush(sid);
      if (syncCancelRef.current.cancelled) return;

      // 2) 시트에서 최신 상태 pull (시트 lag 대응 retry)
      setSyncStage("pulling");
      const result = await pullDbFromSheetWithRetry(sid, {
        attempts: 3,
        delayMs: 900,
        onAttempt: (n) => {
          if (n > 1) setSyncStage("retrying");
        },
      });
      if (syncCancelRef.current.cancelled) return;

      if (!result.db) {
        const local = loadTeacherDb();
        const hasLocalData =
          (local.classes?.length || 0) > 0 ||
          (local.assignments?.length || 0) > 0 ||
          (local.submissions?.length || 0) > 0;
        if (hasLocalData) {
          setSyncStatus({
            kind: "warn",
            msg:
              "시트에서 데이터를 가져오지 못했습니다(여러 번 재시도). 다른 교사가 방금 push한 직후라면 잠시 후 다시 동기화해주세요. " +
              "데이터 손실 방지를 위해 자동으로 시트에 덮어쓰지 않습니다. 시트 ID·접근 권한·서비스 계정 공유 상태도 확인해주세요.",
          });
        } else {
          setSyncStatus({
            kind: "empty",
            msg:
              "시트에 저장된 데이터가 없습니다. (다른 디바이스에서 한 번도 저장되지 않았거나 시트 ID가 다를 수 있습니다)",
          });
        }
        return;
      }

      // 3) 머지 → 로컬 갱신. push back은 saveTeacherDb로 코얼레싱에 위임.
      setSyncStage("merging");
      let mergedDb: TeacherDb = mergeTeacherDbs(loadTeacherDb(), result.db as TeacherDb);
      saveTeacherDb(mergedDb); // skipRemotePush 기본 false → 코얼레싱 push가 pre-pull merge

      // 4) 활성 공유링크 long polling — 시트 propagation lag로 share가 늦게
      //    도착하는 경우(1~2분) 사용자가 모달에서 기다릴 수 있게 polling.
      const countActive = (db: TeacherDb) =>
        (db.shares || []).filter((s) => !s.revokedAt && Date.now() < s.expiresAt).length;
      let activeShares = countActive(mergedDb);

      if (activeShares === 0) {
        setSyncStage("polling");
        const POLL_INTERVAL_MS = 5000;
        const POLL_TIMEOUT_MS = 180_000; // 3분
        const startedAt = Date.now();
        while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
          if (syncCancelRef.current.cancelled) break;
          // 1초 단위로 elapsed 갱신
          for (let waited = 0; waited < POLL_INTERVAL_MS; waited += 1000) {
            if (syncCancelRef.current.cancelled) break;
            await new Promise((r) => setTimeout(r, 1000));
            setPollingElapsed(Math.floor((Date.now() - startedAt) / 1000));
          }
          if (syncCancelRef.current.cancelled) break;

          // 짧은 retry로 시트 한 번 더 조회
          const r2 = await pullDbFromSheetWithRetry(sid, { attempts: 2, delayMs: 500 });
          if (syncCancelRef.current.cancelled) break;
          if (!r2.db) continue;
          const next = mergeTeacherDbs(loadTeacherDb(), r2.db as TeacherDb);
          if (countActive(next) > 0) {
            mergedDb = next;
            saveTeacherDb(mergedDb);
            activeShares = countActive(mergedDb);
            break;
          }
        }
      }

      const totalStudents = (mergedDb.classes || []).reduce(
        (sum, c) => sum + (c.students?.length || 0),
        0,
      );
      if (syncCancelRef.current.cancelled) {
        setSyncStatus({
          kind: "warn",
          msg: `동기화는 진행됐지만 활성 공유링크 propagation 대기를 취소했습니다. 잠시 후 다시 동기화해주세요. (학급 ${mergedDb.classes?.length || 0}개 · 학생 ${totalStudents}명 · 과제 ${mergedDb.assignments?.length || 0}개)`,
        });
      } else {
        setSyncStatus({
          kind: "ok",
          msg:
            `시트와 양방향 동기화 완료 — 학급 ${mergedDb.classes?.length || 0}개 · ` +
            `학생 ${totalStudents}명 · 과제 ${mergedDb.assignments?.length || 0}개 · ` +
            `활성 공유링크 ${activeShares}개`,
        });
      }
      refreshDb();
    } catch (e) {
      setSyncStatus({ kind: "err", msg: (e as Error).message || "동기화 실패" });
    } finally {
      setSyncStage(null);
      setPollingElapsed(0);
      setIsSyncing(false);
    }
  }

  /** 시트 연결됐는데 로컬이 비어 있으면 자동 pull (디바이스 전환 시) */
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const sid = loadTeacherSettings()?.spreadsheetId;
    if (!sid) return;
    try {
      const localDb = loadTeacherDb();
      const isEmpty =
        (localDb.classes?.length || 0) === 0 &&
        (localDb.assignments?.length || 0) === 0;
      if (isEmpty) {
        void syncFromSheet(true);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function openDeleteClassConfirm(classId: string) {
    const fresh = loadTeacherDb();
    const cls = fresh.classes.find((c) => c.id === classId);
    if (!cls) return;
    const submissionCount = fresh.submissions.filter((s) => s.classId === classId).length;
    setDeleteTarget({
      kind: "class",
      id: classId,
      name: cls.name,
      studentCount: cls.students.length,
      submissionCount,
    });
  }

  function openDeleteAssignmentConfirm(assignmentId: string) {
    const fresh = loadTeacherDb();
    const a = fresh.assignments.find((x) => x.id === assignmentId);
    if (!a) return;
    const submissionCount = fresh.submissions.filter((s) => s.assignmentId === assignmentId).length;
    setDeleteTarget({
      kind: "assignment",
      id: assignmentId,
      title: a.title,
      submissionCount,
    });
  }

  /**
   * union 머지 모델에서는 단순히 로컬에서 삭제만 하면, 다음 push의 pull-merge에서
   * 시트에 있던 항목이 되살아난다. 그래서 삭제 시점에 직접 pull→merge→삭제→push
   * 를 명시적으로 수행해 시트에서도 즉시 사라지게 한다.
   */
  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const sid = loadTeacherSettings()?.spreadsheetId;

      let base = loadTeacherDb();
      if (sid) {
        try {
          await flushPendingPush(sid);
          // lag로 빈 결과를 받아 다른 교사 데이터를 잃지 않도록 retry.
          const result = await pullDbFromSheetWithRetry(sid, {
            attempts: 2,
            delayMs: 700,
          });
          if (result.db) base = mergeTeacherDbs(base, result.db as TeacherDb);
        } catch (e) {
          console.warn("[Writing app] delete pre-pull failed:", e);
        }
      }

      const next =
        deleteTarget.kind === "class"
          ? deleteClass(base, deleteTarget.id)
          : deleteAssignment(base, deleteTarget.id);

      saveTeacherDb(next, { skipRemotePush: true });
      if (sid) {
        try {
          // pre-pull merge로 다른 디바이스의 동시 변경을 union하면서, 우리
          // tombstone(deletedAssignment/Class)은 applyTombstones에서 cascade로 시트의
          // 같은 id를 제거한다. 다른 디바이스의 stale push가 거의 동시 일어나도,
          // 그 push도 결국 시트의 tombstone을 union하여 cascade로 잘리기 때문에
          // 삭제가 안정적으로 정착된다.
          await pushDbToSheet(sid, next);

          // 정착 검증: 우리가 추가한 tombstone이 실제 시트의 meta에 들어갔는지
          // 확인해, race로 누락됐다면 한 번 더 push해 정착시킨다.
          const verify = await pullDbFromSheetWithRetry(sid, {
            attempts: 2,
            delayMs: 700,
          });
          if (verify.db) {
            const sheetDb = verify.db as TeacherDb;
            const sheetTombKey = new Set(
              (sheetDb.tombstones || []).map((t) => `${t.kind}:${t.id}`),
            );
            const myKey = `${deleteTarget.kind}:${deleteTarget.id}`;
            if (!sheetTombKey.has(myKey)) {
              console.warn(
                "[Writing app] delete tombstone not on sheet after push, re-pushing",
              );
              await pushDbToSheet(sid, loadTeacherDb());
            }
          }
        } catch (e) {
          console.error("[Writing app] delete push failed:", e);
          setSyncStatus({
            kind: "err",
            msg: "삭제는 로컬에 반영됐지만 시트 반영이 실패했습니다. 동기화를 다시 눌러주세요.",
          });
        }
      }

      if (deleteTarget.kind === "class" && selectedClassId === deleteTarget.id) {
        setSelectedClassId(null);
      }
      setDeleteTarget(null);
      refreshDb();
    } finally {
      setIsDeleting(false);
    }
  }

  if (isLoading) {
    return (
      <div className={styles.page}>로딩 중…</div>
    );
  }

  if (!user) return null;

  const syncStageLabel = (() => {
    switch (syncStage) {
      case "flushing":
        return "진행 중인 변경을 시트에 반영하는 중…";
      case "pulling":
        return "시트에서 최신 데이터를 가져오는 중…";
      case "retrying":
        return "시트가 응답 지연 중입니다. 잠시 후 다시 시도하는 중…";
      case "merging":
        return "다른 디바이스의 변경과 병합하는 중…";
      case "pushing":
        return "병합 결과를 시트에 반영하는 중…";
      case "polling":
        return `활성 공유링크 동기화 대기 중 (${pollingElapsed}초 / 최대 180초). 시트 propagation에 1~2분 걸릴 수 있습니다.`;
      default:
        return "준비 중…";
    }
  })();

  // 진행 단계 도트(시각화). polling은 5번째 단계로 표시.
  const stageOrder = ["flushing", "pulling", "merging", "polling"] as const;
  const stageStatus = (s: (typeof stageOrder)[number]): "done" | "active" | "pending" => {
    const idx = stageOrder.indexOf(s);
    const cur = syncStage === "retrying" ? "pulling" : syncStage;
    const curIdx = stageOrder.indexOf(cur as (typeof stageOrder)[number]);
    if (curIdx < 0) return "pending";
    if (idx < curIdx) return "done";
    if (idx === curIdx) return "active";
    return "pending";
  };

  return (
    <div className={styles.page}>
      {isSyncing && syncStage ? (
        <div
          className={styles.syncOverlay}
          role="status"
          aria-live="polite"
          aria-label="동기화 진행 중"
        >
          <div className={styles.syncCard}>
            <div className={styles.syncSpinner} />
            <div className={styles.syncTitle}>
              {syncStage === "polling"
                ? "활성 공유링크 동기화 대기 중"
                : "동기화 진행 중"}
            </div>
            <div className={styles.syncStageMsg}>{syncStageLabel}</div>
            <div className={styles.syncSteps} aria-hidden="true">
              {stageOrder.map((s) => {
                const st = stageStatus(s);
                const cls =
                  st === "done"
                    ? `${styles.syncDot} ${styles.syncDotDone}`
                    : st === "active"
                      ? `${styles.syncDot} ${styles.syncDotActive}`
                      : styles.syncDot;
                return <span key={s} className={cls} />;
              })}
            </div>
            {syncStage === "polling" ? (
              <button
                type="button"
                onClick={cancelOngoingSync}
                className={styles.tinyButton}
                style={{ marginTop: 8 }}
              >
                기다리지 않고 닫기
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={styles.container}>
        <div className={styles.topbar}>
          <div>
            <div className={styles.title}>📚 교사 대시보드</div>
            <div className={styles.sub}>{displayName}</div>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.tinyButton}
              onClick={() => setIsSheetSetupOpen(true)}
              title="구글 스프레드시트(DB) 연결"
            >
              {sheetId ? "📗 DB 연결됨" : "📎 DB 연결"}
            </button>
            {sheetId ? (
              <button
                className={styles.tinyButton}
                onClick={() => void syncFromSheet(false)}
                disabled={isSyncing}
                title="시트에서 최신 데이터를 다시 가져옵니다 (다른 디바이스에서 변경된 내용을 반영)"
              >
                {isSyncing ? "동기화 중…" : "🔄 시트에서 동기화"}
              </button>
            ) : null}
            <button
              className={styles.tinyButton}
              onClick={() => setIsDriveSetupOpen(true)}
              title="구글 드라이브에 과제 첨부 저장"
            >
              {driveReady ? "📁 드라이브 연결됨" : "📁 드라이브 연동"}
            </button>
            <button className={styles.tinyButton} onClick={onSignOut} disabled={isSigningOut}>
              {isSigningOut ? "로그아웃 중…" : "로그아웃"}
            </button>
          </div>
        </div>

        {syncStatus ? (
          <div
            className={
              syncStatus.kind === "ok"
                ? styles.syncToastOk
                : syncStatus.kind === "empty"
                  ? styles.syncToastWarn
                  : styles.syncToastErr
            }
          >
            <span>{syncStatus.msg}</span>
            <button
              type="button"
              className={styles.syncToastClose}
              onClick={() => setSyncStatus(null)}
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        ) : null}

        <div className={styles.grid}>
          <div className={styles.row2}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>🏫 학급 폴더</div>
                <div className={styles.toolbarRow}>
                  <button
                    className={styles.tinyButton}
                    onClick={() => setIsCreateClassOpen(true)}
                  >
                    ✨ 학급 생성하기
                  </button>
                </div>
              </div>

              {db.classes.length === 0 ? (
                <div className={styles.empty}>
                  아직 학급이 없습니다. <b>학급 생성하기</b>로 학번을 입력하면 학생별
                  8자리 코드가 자동 생성됩니다.
                </div>
              ) : (
                <div className={styles.classes}>
                  {db.classes.map((c) => (
                    <div key={c.id} className={styles.classCardWrap}>
                      <button
                        type="button"
                        className={styles.classCard}
                        onClick={() => setSelectedClassId(c.id)}
                        title="학급 열기"
                      >
                        <div className={styles.className}>{c.name}</div>
                        <div className={styles.classMeta}>
                          <span>학생 {c.students.length}명</span>
                          <span>
                            {new Date(c.createdAt).toLocaleDateString("ko-KR")}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={styles.cardDeleteBtn}
                        onClick={() => openDeleteClassConfirm(c.id)}
                        title="학급 삭제"
                        aria-label={`${c.name} 학급 삭제`}
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>📝 과제</div>
                <div className={styles.toolbarRow}>
                  <button
                    className={styles.tinyButton}
                    onClick={() => setIsCreateAssignmentOpen(true)}
                    disabled={db.classes.length === 0}
                    title={db.classes.length === 0 ? "학급을 먼저 생성해주세요." : undefined}
                  >
                    🎀 과제 생성하기
                  </button>
                </div>
              </div>

              {db.assignments.length === 0 ? (
                <div className={styles.empty}>
                  아직 과제가 없습니다. <b>과제 생성하기</b>에서 제시문/과제를 입력하고,
                  학급 또는 학생에게 배당할 수 있습니다.
                </div>
              ) : (
                <div className={styles.classes}>
                  {db.assignments.map((a) => (
                    <div key={a.id} className={styles.assignmentCard}>
                      <div className={styles.className}>{a.title}</div>
                      <div className={styles.classMeta}>
                        <span>배당 {allocationsByAssignmentId.get(a.id) || 0}개</span>
                        <span>{new Date(a.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      <div className={styles.assignmentCardActions}>
                        <button
                          type="button"
                          className={styles.cardMiniBtn}
                          onClick={() => setShareAssignmentId(a.id)}
                          title="공유 링크 생성/관리"
                        >
                          🔗 공유
                        </button>
                        <button
                          type="button"
                          className={styles.cardMiniBtn}
                          onClick={() => setEditAssignmentId(a.id)}
                          title="과제 내용 수정"
                        >
                          ✏️ 과제 수정
                        </button>
                        <button
                          type="button"
                          className={styles.cardMiniBtn}
                          onClick={() => router.push(`/teacher/assignments/${a.id}`)}
                          title="과제 대시보드"
                        >
                          📊 대시보드 보기
                        </button>
                        <button
                          type="button"
                          className={styles.cardMiniBtnDanger}
                          onClick={() => openDeleteAssignmentConfirm(a.id)}
                          title="과제 삭제"
                        >
                          🗑 삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selectedClass ? (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>
                  {selectedClass.name} · 학생 목록(코드)
                </div>
                <div className={styles.studentPanelActions}>
                  <StudentCodeExport
                    roomName={selectedClass.name}
                    students={selectedClass.students}
                  />
                  <button
                    className={styles.tinyButton}
                    onClick={() => setSelectedClassId(null)}
                  >
                    닫기
                  </button>
                </div>
              </div>
              <div className={styles.students}>
                {selectedClass.students.map((s) => (
                  <div key={s.studentNo} className={styles.studentRow}>
                    <div className={styles.studentNo}>{s.studentNo}</div>
                    <div className={styles.studentCode}>{s.studentCode}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <CreateClassModal
        isOpen={isCreateClassOpen}
        onClose={() => setIsCreateClassOpen(false)}
        onCreated={refreshDb}
      />
      <SpreadsheetSetupModal
        isOpen={isSheetSetupOpen}
        onClose={() => setIsSheetSetupOpen(false)}
        onSaved={refreshDb}
      />
      <DriveSetupModal
        isOpen={isDriveSetupOpen}
        onClose={() => setIsDriveSetupOpen(false)}
        onSaved={refreshDb}
      />
      <CreateAssignmentModal
        isOpen={isCreateAssignmentOpen}
        onClose={() => setIsCreateAssignmentOpen(false)}
        onCreated={refreshDb}
      />
      <ShareAssignmentModal
        isOpen={!!shareAssignmentId}
        assignmentId={shareAssignmentId}
        onClose={() => setShareAssignmentId(null)}
        onChanged={refreshDb}
      />
      <EditAssignmentModal
        isOpen={!!editAssignmentId}
        assignmentId={editAssignmentId}
        onClose={() => setEditAssignmentId(null)}
        onSaved={refreshDb}
      />
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => { if (!isDeleting) setDeleteTarget(null); }}
        title={deleteTarget?.kind === "class" ? "학급 삭제" : "과제 삭제"}
        description="삭제한 데이터는 복구할 수 없습니다. 진행 전에 한 번 더 확인해주세요."
        size="lg"
        footer={
          <div className={styles.confirmFooter}>
            <button
              type="button"
              className={styles.tinyButton}
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              취소
            </button>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={onConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "삭제 중…" : "삭제"}
            </button>
          </div>
        }
      >
        {deleteTarget ? (
          <div>
            <div className={styles.confirmText}>
              {deleteTarget.kind === "class" ? (
                <>
                  학급 <b>{deleteTarget.name}</b>을(를) 삭제하시겠어요?
                  <br />
                  학생 {deleteTarget.studentCount}명의 코드와 관련 제출 {deleteTarget.submissionCount}건이 함께 삭제됩니다.
                </>
              ) : (
                <>
                  과제 <b>{deleteTarget.title}</b>을(를) 삭제하시겠어요?
                  <br />
                  공유 링크와 관련 제출 {deleteTarget.submissionCount}건이 함께 삭제됩니다.
                </>
              )}
            </div>
            <div className={styles.confirmHint}>
              로컬 DB에서 즉시 삭제되며, DB 연결이 활성화된 경우 연결된 스프레드시트에도 동기화됩니다.
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

