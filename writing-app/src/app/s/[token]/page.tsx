"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./share.module.css";
import { Button } from "@/components/ui/Button";
import {
  findShare,
  isShareActive,
  loadTeacherDb,
  mergeRemoteSharesIntoLocalDb,
  saveTeacherDb,
} from "@/lib/localDb";
import type { ClassRoom, TeacherDb } from "@/lib/types";
import {
  pullDbFromSheet,
  pullDbFromSheetWithRetry,
  setActiveSpreadsheetId,
} from "@/lib/spreadsheetSync";

/**
 * 교사가 방금 만든 공유 토큰이 시트에 반영되기 전에 학생이 접속하면 1회 pull로는
 * 토큰을 못 찾을 수 있다. 짧은 백오프로 최대 3회까지 재시도하고, 시트 응답에
 * 토큰이 들어 있으면 즉시 종료해서 사용자 경험은 빠르게 유지한다.
 */
async function pullSharedDbWithRetry(
  spreadsheetId: string,
  token: string,
  isCancelled: () => boolean,
): Promise<TeacherDb | null> {
  const delays = [0, 800, 2000];
  for (let i = 0; i < delays.length; i++) {
    if (isCancelled()) return null;
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    if (isCancelled()) return null;
    try {
      const remote = (await pullDbFromSheet(spreadsheetId)) as TeacherDb | null;
      if (!remote) continue;
      const hasToken = remote.shares?.some((s) => s.token === token);
      if (hasToken || i === delays.length - 1) return remote;
    } catch (e) {
      if (i === delays.length - 1) throw e;
    }
  }
  return null;
}

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

      // 2) 로컬에 없으면 URL의 sid로 원격 시트 동기화 후 재검증.
      //    교사 푸시가 아직 끝나지 않았을 수 있어 짧은 백오프로 재시도한다.
      const sidFromUrl =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("sid")
          : null;
      if (sidFromUrl && token) {
        try {
          setActiveSpreadsheetId(sidFromUrl);
          const remote = await pullSharedDbWithRetry(sidFromUrl, token, () => cancelled);
          if (cancelled) return;
          if (remote) {
            // 학생 디바이스에 다른 토큰의 진행 중 작업이 있다면 보존하기 위해
            // 전체 덮어쓰기 대신 shares를 머지한 결과를 저장한다.
            const merged = mergeRemoteSharesIntoLocalDb(loadTeacherDb(), remote);
            saveTeacherDb(
              { ...remote, shares: merged.shares },
              { skipRemotePush: true },
            );
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
      let pullFailed = false;
      if (effectiveSid) {
        setActiveSpreadsheetId(effectiveSid);
        try {
          // 다수 동시 접속 시 1회 pull은 quota·timeout으로 실패할 수 있어 retry 사용.
          // pull 실패 시 stale localStorage로 검증하면 일부 학생만 로그인 실패하는 증상이 발생.
          const result = await pullDbFromSheetWithRetry(effectiveSid, {
            attempts: 3,
            delayMs: 800,
          });
          const remote = (result.db as TeacherDb | null) ?? null;
          if (remote) {
            const merged = mergeRemoteSharesIntoLocalDb(loadTeacherDb(), remote);
            saveTeacherDb(
              { ...remote, shares: merged.shares },
              { skipRemotePush: true },
            );
          } else {
            pullFailed = true;
          }
        } catch {
          pullFailed = true;
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
        setError(
          pullFailed
            ? "서버가 일시적으로 바쁘거나 네트워크가 불안정합니다. 30초 후 다시 시도해주세요."
            : "공유 링크가 유효하지 않습니다.",
        );
        return;
      }

      const { db, allocation } = latestState2;
      // 학번이 동일한 학생이 여러 학급에 등록된 경우, first-match 학급으로 잘못 매칭되어
      // 학생 코드 검증에서 실패하던 문제를 해결하기 위해 (학번 AND 학생 코드)가 함께
      // 일치하는 학급을 찾는다.
      let cls: ClassRoom | null = null;
      let student: ClassRoom["students"][number] | null = null;
      for (const c of db.classes) {
        const found = c.students.find(
          (s) => s.studentNo === no && s.studentCode === code,
        );
        if (found) {
          cls = c;
          student = found;
          break;
        }
      }
      if (!cls || !student) {
        // 시트 pull이 실패해 stale local로 검증한 경우 진짜 mismatch가 아닐 수 있으므로
        // 메시지를 분리한다.
        setError(
          pullFailed
            ? "서버가 일시적으로 바빠 학생 정보를 가져오지 못했습니다. 잠시 후 다시 시도해주세요."
            : "학번 또는 학생 코드가 올바르지 않습니다.",
        );
        return;
      }
      if (!allocation) {
        setError("이 과제는 아직 배당되지 않았습니다. 교사에게 문의하세요.");
        return;
      }

      const matchedClass = cls;
      const isAssigned =
        allocation.targets.some((t) => t.type === "class" && t.classId === matchedClass.id) ||
        allocation.targets.some(
          (t) =>
            t.type === "student" && t.classId === matchedClass.id && t.studentNo === no,
        );
      if (!isAssigned) {
        setError("이 과제가 본인에게 배당되지 않았습니다.");
        return;
      }

      // 다음 단계에서 실제 작문 화면(/write/...)로 이동하도록 연결
      const sidForWrite = sidFromUrl || latestState2.share.spreadsheetId || "";
      const sidQ = sidForWrite ? `&sid=${encodeURIComponent(sidForWrite)}` : "";
      // partial update endpoint는 학생 코드를 인증 정보로 사용한다. URL에 노출되면 공유 링크
      // 자체가 코드까지 포함해 유출 위험이 있으므로 sessionStorage(같은 탭에만 유효)에 보관.
      try {
        const authPayload = JSON.stringify({
          shareToken: token,
          studentNo: no,
          studentCode: code,
          spreadsheetId: sidForWrite,
        });
        window.sessionStorage.setItem(`writing-app:studentAuth:${token}`, authPayload);
      } catch {
        /* sessionStorage 차단 환경(시크릿 모드 등)에서는 partial path 비활성화로 fallback */
      }
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

