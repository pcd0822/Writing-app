"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./teacher-assignment.module.css";
import { addFeedbackNote, loadTeacherDb, updateSubmission, upsertScore } from "@/lib/localDb";
import { nanoid } from "nanoid";
import type { AiLog, FeedbackNote, Score, Stage, Submission } from "@/lib/types";
import { buildFinalReportSnapshot } from "@/lib/finalReport";

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

type DashTab = Stage | "final";

function textForStage(sub: { outlineText: string; draftText: string; reviseText: string }, st: Stage) {
  if (st === "outline") return sub.outlineText || "";
  if (st === "draft") return sub.draftText || "";
  return sub.reviseText || "";
}

export default function TeacherAssignmentPage() {
  const params = useParams<{ assignmentId: string }>();
  const router = useRouter();
  const assignmentId = params?.assignmentId;

  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [dashTab, setDashTab] = useState<DashTab>("outline");
  const [noteText, setNoteText] = useState("");
  const [generalFeedback, setGeneralFeedback] = useState("");
  const [score, setScore] = useState<number | "">("");
  const [outlinePart, setOutlinePart] = useState<number | "">("");
  const [draftPart, setDraftPart] = useState<number | "">("");
  const [revisePart, setRevisePart] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [dbBump, setDbBump] = useState(0);
  const [dropQuote, setDropQuote] = useState<string | null>(null);
  const [pendingRange, setPendingRange] = useState<{ start: number; end: number } | null>(null);

  const state = useMemo(() => {
    try {
      const db = loadTeacherDb();
      const assignment = db.assignments.find((a) => a.id === assignmentId) || null;
      if (!assignment) return { ok: false as const };
      const subs = db.submissions
        .filter((s) => s.assignmentId === assignmentId)
        .sort((a, b) => a.studentNo.localeCompare(b.studentNo, "ko", { numeric: true }));
      const aiCountBySubmissionId = new Map<string, number>();
      for (const l of db.aiLogs) {
        aiCountBySubmissionId.set(l.submissionId, (aiCountBySubmissionId.get(l.submissionId) || 0) + 1);
      }
      return { ok: true as const, db, assignment, subs, aiCountBySubmissionId };
    } catch {
      return { ok: false as const };
    }
  }, [assignmentId, selectedSubmissionId, dbBump]);

  const subsByClass = useMemo(() => {
    if (!state.ok) return [];
    const map = new Map<string, typeof state.subs>();
    for (const s of state.subs) {
      const cls = state.db.classes.find((c) => c.id === s.classId);
      const label = cls?.name || "학급";
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.studentNo.localeCompare(b.studentNo, "ko", { numeric: true }));
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "ko"))
      .map(([className, subs]) => ({ className, subs }));
  }, [state]);

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

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 선택 학생/점수 행이 바뀔 때 폼을 DB 값과 동기화 */
    if (!selected?.scoreRow) {
      setGeneralFeedback("");
      setScore("");
      setOutlinePart("");
      setDraftPart("");
      setRevisePart("");
      return;
    }
    setGeneralFeedback(selected.scoreRow.teacherSummary || "");
    setScore(selected.scoreRow.score ?? "");
    setOutlinePart(selected.scoreRow.outlineScore ?? "");
    setDraftPart(selected.scoreRow.draftScore ?? "");
    setRevisePart(selected.scoreRow.reviseScore ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selected?.sub.id, selected?.scoreRow?.submissionId]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 학생·탭 전환 시 드래그 인용 초기화 */
    setDropQuote(null);
    setPendingRange(null);
    setNoteText("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedSubmissionId, dashTab]);

  function bump() {
    setDbBump((v) => v + 1);
  }

  function currentStage(sub: { outlineApprovedAt: number | null; draftApprovedAt: number | null; reviseApprovedAt: number | null }): Stage {
    if (!sub.outlineApprovedAt) return "outline";
    if (!sub.draftApprovedAt) return "draft";
    return "revise";
  }

  function stageStatus(sub: Submission, stage: Stage) {
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
    bump();
  }

  function addNote() {
    setError(null);
    if (!selected || dashTab === "final") return;
    const text = noteText.trim();
    if (!text) return;
    const stage = dashTab as Stage;
    const base = textForStage(selected.sub, stage);
    const box = document.getElementById("select-box");
    const sel = window.getSelection();

    let start = 0;
    let end = Math.min(base.length, 120);
    if (pendingRange && dropQuote) {
      start = pendingRange.start;
      end = pendingRange.end;
    } else if (box && sel && sel.rangeCount > 0) {
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
    setDropQuote(null);
    setPendingRange(null);
    bump();
  }

  function saveScore() {
    setError(null);
    if (!selected) return;
    const summary = generalFeedback.trim();
    const sc = score === "" ? null : Number(score);
    const o = outlinePart === "" ? null : Number(outlinePart);
    const d = draftPart === "" ? null : Number(draftPart);
    const r = revisePart === "" ? null : Number(revisePart);
    if (score !== "" && (!Number.isFinite(sc) || sc! < 0)) {
      setError("점수를 올바르게 입력해주세요.");
      return;
    }
    upsertScore({
      submissionId: selected.sub.id,
      createdAt: Date.now(),
      teacherSummary: summary,
      score: sc,
      outlineScore: o,
      draftScore: d,
      reviseScore: r,
    });
    bump();
  }

  function publishFinalReport() {
    setError(null);
    if (!selected) return;
    saveScore();
    const db = loadTeacherDb();
    const sub = db.submissions.find((s) => s.id === selected.sub.id);
    if (!sub) return;
    const notes = db.feedbackNotes.filter((n) => n.submissionId === sub.id);
    const logs = db.aiLogs.filter((l) => l.submissionId === sub.id);
    const scoreRow = db.scores.find((s) => s.submissionId === sub.id) || null;
    const partial = {
      outline: scoreRow?.outlineScore ?? null,
      draft: scoreRow?.draftScore ?? null,
      revise: scoreRow?.reviseScore ?? null,
    };
    const snap = buildFinalReportSnapshot({
      submission: sub,
      aiLogs: logs,
      notes,
      score: scoreRow,
      partial,
    });
    updateSubmission(sub.id, {
      finalReportSnapshot: JSON.stringify(snap),
      finalReportPublishedAt: Date.now(),
    });
    bump();
  }

  const onDragStartSelect = useCallback((e: React.DragEvent) => {
    const t = window.getSelection()?.toString() || "";
    if (t) {
      e.dataTransfer.setData("text/plain", t);
      e.dataTransfer.effectAllowed = "copy";
    }
  }, []);

  const onDropFeedback = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (dashTab === "final") return;
      const q = e.dataTransfer.getData("text/plain").trim();
      if (!q || !selected) return;
      setDropQuote(q);
      const stage = dashTab as Stage;
      const base = textForStage(selected.sub, stage);
      const start = base.indexOf(q);
      if (start >= 0) setPendingRange({ start, end: start + q.length });
      else {
        setPendingRange({ start: 0, end: Math.min(q.length, base.length) });
      }
    },
    [dashTab, selected],
  );

  if (!state.ok) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>과제를 찾을 수 없습니다.</div>
      </div>
    );
  }

  const notesForTab =
    selected?.notes.filter((n) => (dashTab === "final" ? true : n.stage === dashTab)) ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <button className={styles.back} onClick={() => router.push("/teacher")}>
          ← 교사 화면
        </button>
        <div>
          <div className={styles.title}>{state.assignment.title}</div>
          <div className={styles.sub}>학급별 · 학생별 제출/승인/피드백/최종 배포</div>
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
              {subsByClass.map(({ className, subs }) => (
                <div key={className} className={styles.classGroup}>
                  <div className={styles.classGroupTitle}>{className}</div>
                  {subs.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={[styles.row, selectedSubmissionId === s.id ? styles.rowActive : ""].join(" ")}
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
                      <div className={styles.ai}>AI {state.aiCountBySubmissionId.get(s.id) || 0}</div>
                    </button>
                  ))}
                </div>
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
              <div className={styles.dashTabs}>
                {(["outline", "draft", "revise", "final"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={[styles.dashTab, dashTab === t ? styles.dashTabOn : ""].join(" ")}
                    onClick={() => setDashTab(t)}
                  >
                    {t === "outline"
                      ? "개요쓰기"
                      : t === "draft"
                        ? "초고쓰기"
                        : t === "revise"
                          ? "고쳐쓰기"
                          : "최종 대시보드"}
                  </button>
                ))}
              </div>

              {dashTab !== "final" ? (
                <>
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>
                      현재 단계: {stageText(currentStage(selected.sub))}
                      <button
                        type="button"
                        className={styles.approveBtn}
                        style={{ marginLeft: 10 }}
                        disabled={dashTab !== currentStage(selected.sub)}
                        onClick={() => approveStage(selected.sub.id, currentStage(selected.sub))}
                        title={
                          dashTab !== currentStage(selected.sub)
                            ? "현재 단계에서만 승인할 수 있습니다."
                            : dashTab === "revise"
                              ? "최종 승인(고쳐쓰기 승인)"
                              : "승인"
                        }
                      >
                        {dashTab === "outline"
                          ? "개요 승인"
                          : dashTab === "draft"
                            ? "초고 승인"
                            : "최종 승인"}
                      </button>
                    </div>
                  </div>

                  <div className={styles.block}>
                    <div className={styles.blockTitle}>학생 글 (드래그하여 아래 피드백 영역에 놓기)</div>
                    <div
                      id="select-box"
                      className={styles.selectBox}
                      style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}
                      onDragStart={onDragStartSelect}
                    >
                      {textForStage(selected.sub, dashTab as Stage)}
                    </div>
                    <div className={styles.dim}>
                      글에서 드래그한 뒤 아래 점선 영역에 놓으면 인용 박스로 고정됩니다. 메모는 별도 입력란에만
                      적습니다.
                    </div>
                  </div>

                  <div
                    className={styles.feedbackDropZone}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={onDropFeedback}
                  >
                    <div className={styles.blockTitle}>피드백(메모)</div>
                    {dropQuote ? (
                      <div className={styles.quoteBox}>
                        <div className={styles.quoteBoxLabel}>인용 구간</div>
                        <div className={styles.quoteBoxText}>{dropQuote}</div>
                      </div>
                    ) : (
                      <div className={styles.dropHint}>여기로 글을 드래그하면 인용 박스가 표시됩니다.</div>
                    )}
                    <textarea
                      className={styles.textarea}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="피드백 내용만 입력하세요. (인용과 섞이지 않습니다)"
                    />
                    <button type="button" className={styles.smallBtn} onClick={addNote}>
                      메모 저장
                    </button>
                    {notesForTab.length ? (
                      <div className={styles.noteList}>
                        {notesForTab.map((n) => (
                          <div key={n.id} className={styles.noteItem}>
                            <div className={styles.quote}>{n.anchorText}</div>
                            <div className={styles.noteText}>{n.teacherText}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.dim}>이 단계 메모가 없습니다.</div>
                    )}
                  </div>

                  <div className={styles.block}>
                    <div className={styles.blockTitle}>AI 대화 로그</div>
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
                </>
              ) : (
                <FinalDashboardPanel
                  selected={selected}
                  dbBump={dbBump}
                  generalFeedback={generalFeedback}
                  setGeneralFeedback={setGeneralFeedback}
                  score={score}
                  setScore={setScore}
                  outlinePart={outlinePart}
                  setOutlinePart={setOutlinePart}
                  draftPart={draftPart}
                  setDraftPart={setDraftPart}
                  revisePart={revisePart}
                  setRevisePart={setRevisePart}
                  saveScore={saveScore}
                  publishFinalReport={publishFinalReport}
                />
              )}

              {error ? <div className={styles.error}>{error}</div> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FinalDashboardPanel({
  selected,
  dbBump,
  generalFeedback,
  setGeneralFeedback,
  score,
  setScore,
  outlinePart,
  setOutlinePart,
  draftPart,
  setDraftPart,
  revisePart,
  setRevisePart,
  saveScore,
  publishFinalReport,
}: {
  selected: {
    sub: Submission;
    notes: FeedbackNote[];
    logs: AiLog[];
    scoreRow: Score | null;
  };
  dbBump: number;
  generalFeedback: string;
  setGeneralFeedback: (s: string) => void;
  score: number | "";
  setScore: (v: number | "") => void;
  outlinePart: number | "";
  setOutlinePart: (v: number | "") => void;
  draftPart: number | "";
  setDraftPart: (v: number | "") => void;
  revisePart: number | "";
  setRevisePart: (v: number | "") => void;
  saveScore: () => void;
  publishFinalReport: () => void;
}) {
  const snap = useMemo(() => {
    const db = loadTeacherDb();
    const sub = db.submissions.find((s) => s.id === selected.sub.id);
    if (!sub?.finalReportSnapshot) return null;
    try {
      return JSON.parse(sub.finalReportSnapshot) as import("@/lib/finalReport").FinalReportSnapshotV1;
    } catch {
      return null;
    }
  }, [selected.sub.id, selected, dbBump]);

  const preview = useMemo(() => {
    const db = loadTeacherDb();
    const sub = db.submissions.find((s) => s.id === selected.sub.id);
    if (!sub) return null;
    const notes = db.feedbackNotes.filter((n) => n.submissionId === sub.id);
    const logs = db.aiLogs.filter((l) => l.submissionId === sub.id);
    const scoreRow = db.scores.find((s) => s.submissionId === sub.id) || null;
    return buildFinalReportSnapshot({
      submission: sub,
      aiLogs: logs,
      notes,
      score: scoreRow,
      partial: {
        outline: scoreRow?.outlineScore ?? null,
        draft: scoreRow?.draftScore ?? null,
        revise: scoreRow?.reviseScore ?? null,
      },
    });
  }, [selected.sub.id, dbBump]);

  const total =
    (typeof outlinePart === "number" ? outlinePart : 0) +
    (typeof draftPart === "number" ? draftPart : 0) +
    (typeof revisePart === "number" ? revisePart : 0);

  return (
    <div className={styles.finalPanel}>
      <div className={styles.blockTitle}>총평 · 부분 점수 · 최종 배포</div>
      <p className={styles.dim}>
        모든 단계가 승인되고 피드백을 반영한 뒤, 아래 점수와 요약을 저장하고 학생에게 배포하세요.
      </p>

      <div className={styles.infographic}>
        <div className={styles.infoCard}>
          <div className={styles.infoLabel}>질문 키워드 빈도 (상위)</div>
          <div className={styles.barList}>
            {(preview?.questionStats.wordFrequency || []).slice(0, 6).map((w) => (
              <div key={w.word} className={styles.barRow}>
                <span>{w.word}</span>
                <div className={styles.barTrack}>
                  <div className={styles.barFill} style={{ width: `${Math.min(100, w.count * 12)}%` }} />
                </div>
                <span className={styles.barNum}>{w.count}</span>
              </div>
            ))}
            {!preview?.questionStats.wordFrequency.length ? <span className={styles.dim}>데이터 없음</span> : null}
          </div>
        </div>
        <div className={styles.infoCard}>
          <div className={styles.infoLabel}>질문 길이 수준 (짧음/중간/김)</div>
          <div className={styles.levelPie}>
            <span>짧음 {preview?.questionStats.levelBuckets.low ?? 0}</span>
            <span>중간 {preview?.questionStats.levelBuckets.mid ?? 0}</span>
            <span>김 {preview?.questionStats.levelBuckets.high ?? 0}</span>
          </div>
        </div>
      </div>

      <div className={styles.partialRow}>
        <label>
          개요 점수
          <input
            type="number"
            className={styles.scoreInput}
            value={outlinePart}
            onChange={(e) => setOutlinePart(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <label>
          초고 점수
          <input
            type="number"
            className={styles.scoreInput}
            value={draftPart}
            onChange={(e) => setDraftPart(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
        <label>
          고쳐쓰기 점수
          <input
            type="number"
            className={styles.scoreInput}
            value={revisePart}
            onChange={(e) => setRevisePart(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
      </div>
      <div className={styles.totalLine}>부분 합계: <b>{total}</b></div>

      <textarea
        className={styles.textarea}
        value={generalFeedback}
        onChange={(e) => setGeneralFeedback(e.target.value)}
        placeholder="총평"
      />
      <div className={styles.scoreRow}>
        <label className={styles.scoreLabel}>
          통합 점수(표시용)
          <input
            className={styles.scoreInput}
            type="number"
            value={score}
            onChange={(e) => setScore(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </label>
      </div>

      <div className={styles.narrativeBox}>
        <div className={styles.infoLabel}>자동 요약(미리보기)</div>
        <div className={styles.narrativeText}>{preview?.narrativeSummary}</div>
      </div>

      {snap ? (
        <div className={styles.publishedBadge}>배포됨 · {new Date(snap.generatedAt).toLocaleString("ko-KR")}</div>
      ) : null}

      <div className={styles.finalActions}>
        <button type="button" className={styles.smallBtn} onClick={saveScore}>
          저장하기
        </button>
        <button type="button" className={styles.publishBtn} onClick={publishFinalReport}>
          저장 후 배포하기
        </button>
      </div>
    </div>
  );
}
