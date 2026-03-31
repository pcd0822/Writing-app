"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./teacher-assignment.module.css";
import {
  addFeedbackNote,
  loadTeacherDb,
  updateSubmission,
  upsertScore,
} from "@/lib/localDb";
import { nanoid } from "nanoid";
import type { Stage } from "@/lib/types";

function stageText(stage: Stage) {
  if (stage === "outline") return "개요";
  if (stage === "draft") return "초고";
  return "고쳐쓰기";
}

function getTextOffsetWithin(container: HTMLElement, node: Node, nodeOffset: number) {
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(node, nodeOffset);
  return range.toString().length;
}

export default function TeacherAssignmentPage() {
  const params = useParams<{ assignmentId: string }>();
  const router = useRouter();
  const assignmentId = params?.assignmentId;

  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [generalFeedback, setGeneralFeedback] = useState("");
  const [score, setScore] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  const state = useMemo(() => {
    try {
      const db = loadTeacherDb();
      const assignment = db.assignments.find((a) => a.id === assignmentId) || null;
      if (!assignment) return { ok: false as const };
      const subs = db.submissions
        .filter((s) => s.assignmentId === assignmentId)
        .sort((a, b) => a.studentNo.localeCompare(b.studentNo));
      const aiCountBySubmissionId = new Map<string, number>();
      for (const l of db.aiLogs) {
        aiCountBySubmissionId.set(l.submissionId, (aiCountBySubmissionId.get(l.submissionId) || 0) + 1);
      }
      return { ok: true as const, db, assignment, subs, aiCountBySubmissionId };
    } catch {
      return { ok: false as const };
    }
  }, [assignmentId, selectedSubmissionId]);

  const selected = useMemo(() => {
    if (!state.ok || !selectedSubmissionId) return null;
    const sub = state.subs.find((s) => s.id === selectedSubmissionId) || null;
    if (!sub) return null;
    const notes = state.db.feedbackNotes
      .filter((n) => n.submissionId === sub.id && !n.resolvedAt)
      .sort((a, b) => a.createdAt - b.createdAt);
    const logs = state.db.aiLogs
      .filter((l) => l.submissionId === sub.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    const scoreRow = state.db.scores.find((s) => s.submissionId === sub.id) || null;
    return { sub, notes, logs, scoreRow };
  }, [state, selectedSubmissionId]);

  function currentStage(sub: any): Stage {
    if (!sub.outlineApprovedAt) return "outline";
    if (!sub.draftApprovedAt) return "draft";
    return "revise";
  }

  function stageStatus(sub: any, stage: Stage) {
    if (stage === "outline") {
      if (sub.outlineApprovedAt) return "승인";
      if (sub.outlineSubmittedAt) return "제출(대기)";
      return "미제출";
    }
    if (stage === "draft") {
      if (sub.draftApprovedAt) return "승인";
      if (sub.draftSubmittedAt) return "제출(대기)";
      return "미제출";
    }
    if (sub.reviseApprovedAt) return "승인";
    if (sub.reviseSubmittedAt) return "제출(대기)";
    return "미제출";
  }

  function approveStage(subId: string, stage: Stage) {
    setError(null);
    const db = loadTeacherDb();
    const sub = db.submissions.find((s) => s.id === subId);
    if (!sub) return;

    if (stage === "draft") {
      // 초고->고쳐쓰기 넘어갈 때: 교사 피드백 필수(최소 1개)
      const hasAnyNote = db.feedbackNotes.some(
        (n) => n.submissionId === subId && (n.stage === "draft" || n.stage === "revise") && !n.resolvedAt,
      );
      if (!hasAnyNote) {
        setError("초고 승인 전, 반드시 피드백(메모)을 1개 이상 입력해야 합니다.");
        return;
      }
    }

    if (stage === "outline") updateSubmission(subId, { outlineApprovedAt: Date.now() });
    if (stage === "draft") updateSubmission(subId, { draftApprovedAt: Date.now() });
    if (stage === "revise") updateSubmission(subId, { reviseApprovedAt: Date.now(), finalApprovedAt: Date.now() });
  }

  function addNote() {
    setError(null);
    if (!selected) return;
    const text = noteText.trim();
    if (!text) return;
    const stage: Stage = currentStage(selected.sub);
    const base =
      stage === "outline" ? selected.sub.outlineText :
      stage === "draft" ? selected.sub.draftText :
      selected.sub.reviseText;
    const box = document.getElementById("select-box");
    const sel = window.getSelection();

    let start = 0;
    let end = Math.min(base.length, 120);
    if (box && sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (box.contains(r.startContainer) && box.contains(r.endContainer)) {
        start = getTextOffsetWithin(box, r.startContainer, r.startOffset);
        end = getTextOffsetWithin(box, r.endContainer, r.endOffset);
        if (end < start) [start, end] = [end, start];
        start = Math.max(0, Math.min(base.length, start));
        end = Math.max(start, Math.min(base.length, end));
      }
    }

    const anchorText = base.slice(start, Math.min(end, start + 200)) || "(텍스트 없음)";

    addFeedbackNote({
      id: nanoid(12),
      submissionId: selected.sub.id,
      stage,
      createdAt: Date.now(),
      teacherText: text,
      anchorText,
      start,
      end,
      resolvedAt: null,
    });
    setNoteText("");
  }

  function saveScore() {
    setError(null);
    if (!selected) return;
    const summary = generalFeedback.trim();
    const sc = score === "" ? null : Number(score);
    if (score !== "" && (!Number.isFinite(sc) || sc! < 0)) {
      setError("점수를 올바르게 입력해주세요.");
      return;
    }
    upsertScore({
      submissionId: selected.sub.id,
      createdAt: Date.now(),
      teacherSummary: summary,
      score: sc,
    });
  }

  if (!state.ok) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>과제를 찾을 수 없습니다.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <button className={styles.back} onClick={() => router.push("/teacher")}>
          ← 교사 화면
        </button>
        <div>
          <div className={styles.title}>{state.assignment.title}</div>
          <div className={styles.sub}>학생별 제출/승인/AI 로그/피드백/점수</div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.panelTitle}>학생 현황</div>
          {state.subs.length === 0 ? (
            <div className={styles.empty}>
              아직 학생 제출 데이터가 없습니다. 학생이 공유 링크로 접속해 작성/제출하면 여기에서 확인할 수 있습니다.
            </div>
          ) : (
            <div className={styles.list}>
              {state.subs.map((s) => (
                <button
                  key={s.id}
                  className={[
                    styles.row,
                    selectedSubmissionId === s.id ? styles.rowActive : "",
                  ].join(" ")}
                  onClick={() => setSelectedSubmissionId(s.id)}
                >
                  <div className={styles.rowMain}>
                    <div className={styles.no}>{s.studentNo}</div>
                    <div className={styles.meta}>
                      <span>개요: {stageStatus(s, "outline")}</span>
                      <span>초고: {stageStatus(s, "draft")}</span>
                      <span>고쳐쓰기: {stageStatus(s, "revise")}</span>
                    </div>
                  </div>
                  <div className={styles.ai}>
                    AI {state.aiCountBySubmissionId.get(s.id) || 0}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.panel}>
          <div className={styles.panelTitle}>학생 대시보드</div>
          {!selected ? (
            <div className={styles.empty}>왼쪽에서 학생을 선택하세요.</div>
          ) : (
            <>
              <div className={styles.block}>
                <div className={styles.blockTitle}>현재 단계: {stageText(currentStage(selected.sub))}</div>
                <div className={styles.actions}>
                  <button
                    className={styles.smallBtn}
                    onClick={() => approveStage(selected.sub.id, currentStage(selected.sub))}
                    title="현재 단계 제출을 승인합니다."
                  >
                    승인하기
                  </button>
                </div>
              </div>

              <div className={styles.block}>
                <div className={styles.blockTitle}>학생 글(드래그로 선택)</div>
                <div
                  id="select-box"
                  className={styles.selectBox}
                  style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}
                >
                  {(() => {
                    const st = currentStage(selected.sub);
                    if (st === "outline") return selected.sub.outlineText || "";
                    if (st === "draft") return selected.sub.draftText || "";
                    return selected.sub.reviseText || "";
                  })()}
                </div>
                <div className={styles.dim}>
                  글의 특정 구간을 드래그로 선택한 뒤, 아래 “메모 입력하기”로 해당 구간에 메모가 연결됩니다.
                </div>
              </div>

              <div className={styles.block}>
                <div className={styles.blockTitle}>피드백(메모)</div>
                <textarea
                  className={styles.textarea}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="학생 글의 특정 부분에 대한 피드백을 입력하세요."
                />
                <button className={styles.smallBtn} onClick={addNote}>
                  메모 입력하기
                </button>
                {selected.notes.length ? (
                  <div className={styles.noteList}>
                    {selected.notes.map((n) => (
                      <div key={n.id} className={styles.noteItem}>
                        <div className={styles.quote}>{n.anchorText}</div>
                        <div className={styles.noteText}>{n.teacherText}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.dim}>아직 메모가 없습니다.</div>
                )}
              </div>

              <div className={styles.block}>
                <div className={styles.blockTitle}>AI 대화/프롬프트 로그</div>
                {selected.logs.length ? (
                  <div className={styles.log}>
                    {selected.logs.slice(-30).map((l) => (
                      <div key={l.id} className={styles.logRow}>
                        <span className={styles.role}>{l.role}</span>
                        <span className={styles.logText}>{l.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.dim}>AI 사용 기록이 없습니다.</div>
                )}
              </div>

              <div className={styles.block}>
                <div className={styles.blockTitle}>총평/점수</div>
                <textarea
                  className={styles.textarea}
                  value={generalFeedback}
                  onChange={(e) => setGeneralFeedback(e.target.value)}
                  placeholder="총평을 입력하세요."
                />
                <div className={styles.scoreRow}>
                  <label className={styles.scoreLabel}>
                    점수
                    <input
                      className={styles.scoreInput}
                      type="number"
                      value={score}
                      onChange={(e) => setScore(e.target.value === "" ? "" : Number(e.target.value))}
                    />
                  </label>
                  <button className={styles.smallBtn} onClick={saveScore}>
                    전송하기
                  </button>
                </div>
              </div>

              {error ? <div className={styles.error}>{error}</div> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

