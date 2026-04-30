"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./share.module.css";
import { Button } from "@/components/ui/Button";
import { findShare, isShareActive, loadTeacherDb, saveTeacherDb } from "@/lib/localDb";
import type { TeacherDb } from "@/lib/types";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";

type ShareState =
  | {
      ok: true;
      share: NonNullable<ReturnType<typeof findShare>>;
      assignment: TeacherDb["assignments"][number] | null;
      allocation: TeacherDb["allocations"][number] | null;
      db: TeacherDb;
    }
  | { ok: false; reason: "missing" | "notfound" | "expired" | "error" };

export default function ShareLandingPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token;

  const [studentNo, setStudentNo] = useState("");
  const [studentCode, setStudentCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  // null = 아직 검증 중(로딩). 시트 동기화가 끝난 뒤에만 invalid 판정을 내려야
  // 다른 디바이스에서도 공유 링크가 정상 동작한다.
  const [shareState, setShareState] = useState<ShareState | null>(null);

  useEffect(() => {
    let cancelled = false;

    function validateFromLocal(): ShareState | null {
      if (!token) return { ok: false, reason: "missing" };
      try {
        const db = loadTeacherDb();
        const share = findShare(db, token);
        if (!share) return null;
        if (!isShareActive(share)) return { ok: false, reason: "expired" };
        const assignment = db.assignments.find((a) => a.id === share.assignmentId) || null;
        const allocation =
          db.allocations.find((x) => x.assignmentId === share.assignmentId) || null;
        return { ok: true, share, assignment, allocation, db };
      } catch {
        return { ok: false, reason: "error" };
      }
    }

    async function resolve() {
      // 1) 로컬 DB로 먼저 시도 (교사 본인 디바이스 fast-path)
      const local = validateFromLocal();
      if (local && local.ok) {
        if (!cancelled) setShareState(local);
        return;
      }
      if (local && !local.ok && local.reason !== "notfound") {
        if (!cancelled) setShareState(local);
        return;
      }

      // 2) 로컬에 없으면 URL의 sid로 원격 시트 동기화 후 재검증
      const sidFromUrl =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("sid")
          : null;
      if (sidFromUrl) {
        try {
          setActiveSpreadsheetId(sidFromUrl);
          const remote = await pullDbFromSheet(sidFromUrl);
          if (cancelled) return;
          if (remote) {
            saveTeacherDb(remote as TeacherDb);
            const after = validateFromLocal();
            if (cancelled) return;
            setShareState(after ?? { ok: false, reason: "notfound" });
            return;
          }
        } catch {
          if (!cancelled) setShareState({ ok: false, reason: "error" });
          return;
        }
      }

      if (!cancelled) setShareState({ ok: false, reason: "notfound" });
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onEnter() {
    setError(null);
    const no = studentNo.trim();
    const code = studentCode.trim();
    if (!no || !code) {
      setError("학번과 학생 코드를 모두 입력해주세요.");
      return;
    }

    setIsVerifying(true);
    try {
      const sidFromUrl = new URLSearchParams(window.location.search).get("sid");

      const latestState = (() => {
        try {
          const db = loadTeacherDb();
          const share = token ? findShare(db, token) : null;
          if (!share || !isShareActive(share)) return null;
          const assignment = db.assignments.find((a) => a.id === share.assignmentId) || null;
          const allocation =
            db.allocations.find((x) => x.assignmentId === share.assignmentId) || null;
          return { db, share, assignment, allocation };
        } catch {
          return null;
        }
      })();

      if (!latestState) {
        setError("공유 링크가 유효하지 않습니다.");
        return;
      }

      const { share } = latestState;
      const effectiveSid = sidFromUrl || share.spreadsheetId || null;
      if (effectiveSid) {
        setActiveSpreadsheetId(effectiveSid);
        const remote = await pullDbFromSheet(effectiveSid);
        if (remote) {
          saveTeacherDb(remote as TeacherDb);
        }
      }

      const latestState2 = (() => {
        try {
          const db = loadTeacherDb();
          const sh = token ? findShare(db, token) : null;
          if (!sh || !isShareActive(sh)) return null;
          const assignment = db.assignments.find((a) => a.id === sh.assignmentId) || null;
          const allocation =
            db.allocations.find((x) => x.assignmentId === sh.assignmentId) || null;
          return { db, share: sh, assignment, allocation };
        } catch {
          return null;
        }
      })();

      if (!latestState2) {
        setError("공유 링크가 유효하지 않습니다.");
        return;
      }

      const { db, allocation } = latestState2;
      const cls = db.classes.find((c) => c.students.some((s) => s.studentNo === no)) || null;
      const student =
        cls?.students.find((s) => s.studentNo === no && s.studentCode === code) || null;
      if (!cls || !student) {
        setError("학번 또는 학생 코드가 올바르지 않습니다.");
        return;
      }
      if (!allocation) {
        setError("이 과제는 아직 배당되지 않았습니다. 교사에게 문의하세요.");
        return;
      }

      const isAssigned =
        allocation.targets.some((t) => t.type === "class" && t.classId === cls.id) ||
        allocation.targets.some(
          (t) => t.type === "student" && t.classId === cls.id && t.studentNo === no,
        );
      if (!isAssigned) {
        setError("이 과제가 본인에게 배당되지 않았습니다.");
        return;
      }

      // 다음 단계에서 실제 작문 화면(/write/...)로 이동하도록 연결
      const sidForWrite = sidFromUrl || latestState2.share.spreadsheetId || "";
      const sidQ = sidForWrite ? `&sid=${encodeURIComponent(sidForWrite)}` : "";
      router.push(`/s/${token}/write?studentNo=${encodeURIComponent(no)}${sidQ}`);
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.title}>과제 작성 시작</div>
          <div className={styles.sub}>
            {shareState && shareState.ok && shareState.assignment
              ? `과제: ${shareState.assignment.title}`
              : "공유 링크 확인 중…"}
          </div>
        </div>

        {shareState === null ? null : !shareState.ok ? (
          <div className={styles.errorBox}>
            {shareState.reason === "expired"
              ? "이 공유 링크는 만료되었습니다. 교사에게 새 링크를 요청하세요."
              : "유효하지 않은 공유 링크입니다."}
          </div>
        ) : (
          <>
            <div className={styles.form}>
              <label className={styles.label}>
                <span>학번</span>
                <input
                  className={styles.input}
                  value={studentNo}
                  onChange={(e) => setStudentNo(e.target.value)}
                  placeholder="예) 30101"
                />
              </label>
              <label className={styles.label}>
                <span>학생 코드(8자리)</span>
                <input
                  className={styles.input}
                  value={studentCode}
                  onChange={(e) => setStudentCode(e.target.value)}
                  placeholder="예) aB3dE9kQ"
                />
              </label>
            </div>

            {error ? <div className={styles.errorBox}>{error}</div> : null}

            <Button onClick={onEnter} isLoading={isVerifying}>
              작문 시작
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

