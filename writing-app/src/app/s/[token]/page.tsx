"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./share.module.css";
import { Button } from "@/components/ui/Button";
import { findShare, isShareActive, loadTeacherDb, saveTeacherDb } from "@/lib/localDb";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";

export default function ShareLandingPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token;

  const [studentNo, setStudentNo] = useState("");
  const [studentCode, setStudentCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const shareState = useMemo(() => {
    if (!token) return { ok: false as const, reason: "missing" };
    try {
      const db = loadTeacherDb();
      const share = findShare(db, token);
      if (!share) return { ok: false as const, reason: "notfound" };
      if (!isShareActive(share)) return { ok: false as const, reason: "expired" };
      const assignment = db.assignments.find((a) => a.id === share.assignmentId) || null;
      const allocation =
        db.allocations.find((x) => x.assignmentId === share.assignmentId) || null;
      return { ok: true as const, share, assignment, allocation, db };
    } catch {
      return { ok: false as const, reason: "error" };
    }
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
      // 스프레드시트 완전 이관: 공유 링크에 sid가 있으면, 시트에서 최신 DB를 pull
      const sid = new URLSearchParams(window.location.search).get("sid");
      if (sid) {
        setActiveSpreadsheetId(sid);
        const remote = await pullDbFromSheet(sid);
        if (remote) {
          // local storage에 덮어써서 이후 흐름이 동일하게 동작하도록
          saveTeacherDb(remote as any);
        }
      }

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

      const { db, allocation } = latestState;
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
      const sidQ = sid ? `&sid=${encodeURIComponent(sid)}` : "";
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
            {shareState.ok && shareState.assignment
              ? `과제: ${shareState.assignment.title}`
              : "공유 링크 확인 중…"}
          </div>
        </div>

        {!shareState.ok ? (
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

