"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../providers";
import { signOutCurrentUser } from "@/lib/auth";
import { CreateClassModal } from "@/components/teacher/CreateClassModal";
import {
  deleteAssignment,
  deleteClass,
  loadTeacherDb,
  saveTeacherDb,
} from "@/lib/localDb";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";
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
  const [syncStatus, setSyncStatus] = useState<{ kind: "ok" | "empty" | "err"; msg: string } | null>(null);

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

  /** 시트에서 원격 DB를 가져와 로컬에 저장 (push는 생략하여 race 방지) */
  async function syncFromSheet(silent = false) {
    if (typeof window === "undefined") return;
    const sid = loadTeacherSettings()?.spreadsheetId;
    if (!sid) {
      if (!silent) setSyncStatus({ kind: "err", msg: "먼저 'DB 연결'에서 스프레드시트 ID를 등록해주세요." });
      return;
    }
    if (!silent) setIsSyncing(true);
    setSyncStatus(null);
    try {
      setActiveSpreadsheetId(sid);
      const remote = await pullDbFromSheet(sid);
      if (remote) {
        const remoteDb = remote as TeacherDb;
        saveTeacherDb(remoteDb, { skipRemotePush: true });
        const totalStudents = (remoteDb.classes || []).reduce(
          (sum, c) => sum + (c.students?.length || 0),
          0,
        );
        setSyncStatus({
          kind: "ok",
          msg: `시트에서 가져옴 — 학급 ${remoteDb.classes?.length || 0}개 · 학생 ${totalStudents}명 · 과제 ${remoteDb.assignments?.length || 0}개`,
        });
        refreshDb();
      } else {
        setSyncStatus({
          kind: "empty",
          msg: "시트에 저장된 데이터가 없습니다. (다른 디바이스에서 한 번도 저장되지 않았거나 시트 ID가 다를 수 있습니다)",
        });
      }
    } catch (e) {
      setSyncStatus({ kind: "err", msg: (e as Error).message || "동기화 실패" });
    } finally {
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

  function onConfirmDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const current = loadTeacherDb();
      const next =
        deleteTarget.kind === "class"
          ? deleteClass(current, deleteTarget.id)
          : deleteAssignment(current, deleteTarget.id);
      saveTeacherDb(next);
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

  return (
    <div className={styles.page}>
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

