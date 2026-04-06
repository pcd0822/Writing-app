"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../providers";
import { signOutCurrentUser } from "@/lib/auth";
import { CreateClassModal } from "@/components/teacher/CreateClassModal";
import { loadTeacherDb, saveTeacherDb } from "@/lib/localDb";
import styles from "./teacher.module.css";
import { SpreadsheetSetupModal } from "@/components/teacher/SpreadsheetSetupModal";
import { loadTeacherSettings } from "@/lib/teacherSettings";
import { CreateAssignmentModal } from "@/components/teacher/CreateAssignmentModal";
import { ShareAssignmentModal } from "@/components/teacher/ShareAssignmentModal";
import { StudentCodeExport } from "@/components/teacher/StudentCodeExport";
import { EditAssignmentModal } from "@/components/teacher/EditAssignmentModal";

export default function TeacherPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isCreateClassOpen, setIsCreateClassOpen] = useState(false);
  const [isSheetSetupOpen, setIsSheetSetupOpen] = useState(false);
  const [isCreateAssignmentOpen, setIsCreateAssignmentOpen] = useState(false);
  const [shareAssignmentId, setShareAssignmentId] = useState<string | null>(null);
  const [editAssignmentId, setEditAssignmentId] = useState<string | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [dbVersion, setDbVersion] = useState(0);

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

  function refreshDb() {
    setDbVersion((v) => v + 1);
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
            <button className={styles.tinyButton} onClick={onSignOut} disabled={isSigningOut}>
              {isSigningOut ? "로그아웃 중…" : "로그아웃"}
            </button>
          </div>
        </div>

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
                    <button
                      key={c.id}
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
    </div>
  );
}

