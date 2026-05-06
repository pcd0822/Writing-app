"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "./teacher-assignment.module.css";
import {
  addFeedbackNote,
  addTeacherComment,
  deleteSubmission,
  getGraspData,
  loadTeacherDb,
  saveTeacherDb,
  updateSubmission,
  upsertScore,
} from "@/lib/localDb";
import { nanoid } from "nanoid";
import type {
  AiInteraction,
  AiLog,
  FeedbackNote,
  Grasp,
  Score,
  Stage,
  StepTransition,
  Submission,
  TeacherComment,
} from "@/lib/types";
import { buildFinalReportSnapshot } from "@/lib/finalReport";
import { GraspSummary } from "@/components/student/GraspSummary";
import { StudentDashboard } from "@/components/student/StudentDashboard";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import {
  downloadSubmissionsCsv,
  downloadSubmissionsPdf,
  type SubmissionExportRow,
} from "@/lib/exportSubmissions";

const FEEDBACK_TEMPLATES = [
  "개요에서 세운 논점이 초고에서 어떻게 구체화되었는지 확인해보세요.",
  "수정 단계에서 독자를 더 고려해서 표현을 다듬어보세요.",
  "초고의 논거가 개요의 핵심 주장을 충분히 뒷받침하고 있나요?",
  "독자의 관점에서 가장 설득력 있는 부분과 보완이 필요한 부분을 표시해보세요.",
  "이전 단계의 피드백이 이번 수정에 어떻게 반영되었는지 설명해주세요.",
];

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
  const [commentText, setCommentText] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectStage, setRejectStage] = useState<Stage>("outline");
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  const [classFilter, setClassFilter] = useState<string>("all");
  const [exportBusyClassId, setExportBusyClassId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // 실시간 모니터링 자동 새로고침
  useEffect(() => {
    const id = window.setInterval(() => setDbBump((v) => v + 1), 8000);
    return () => clearInterval(id);
  }, []);

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
    const map = new Map<string, { classId: string; className: string; subs: typeof state.subs }>();
    for (const s of state.subs) {
      const cls = state.db.classes.find((c) => c.id === s.classId);
      const className = cls?.name || "학급";
      const classId = cls?.id || s.classId;
      if (!map.has(classId)) map.set(classId, { classId, className, subs: [] });
      map.get(classId)!.subs.push(s);
    }
    for (const v of map.values()) {
      v.subs.sort((a, b) => a.studentNo.localeCompare(b.studentNo, "ko", { numeric: true }));
    }
    return [...map.values()].sort((a, b) =>
      a.className.localeCompare(b.className, "ko"),
    );
  }, [state]);

  const visibleGroups = useMemo(() => {
    if (classFilter === "all") return subsByClass;
    return subsByClass.filter((g) => g.classId === classFilter);
  }, [subsByClass, classFilter]);

  async function exportClassSubmissions(
    group: { classId: string; className: string; subs: Submission[] },
    format: "csv" | "pdf",
  ) {
    if (!state.ok) return;
    setExportError(null);
    setExportBusyClassId(group.classId);
    try {
      const rows: SubmissionExportRow[] = group.subs.map((s) => ({
        studentNo: s.studentNo,
        className: group.className,
        outlineText: s.outlineText || "",
        draftText: s.draftText || "",
        reviseText: s.reviseText || "",
      }));
      const base = `${state.assignment.title}_${group.className}_제출물`;
      if (format === "csv") {
        await downloadSubmissionsCsv(base, rows);
      } else {
        await downloadSubmissionsPdf(base, {
          assignmentTitle: state.assignment.title,
          className: group.className,
          rows,
        });
      }
    } catch (e) {
      setExportError((e as Error).message || "내보내기에 실패했습니다.");
    } finally {
      setExportBusyClassId(null);
    }
  }

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
    const grasp = getGraspData(sub);
    const comments = (state.db.teacherComments || [])
      .filter((c) => c.submissionId === sub.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const transitions = (state.db.stepTransitions || [])
      .filter((t) => t.submissionId === sub.id);
    const aiInteractions = (state.db.aiInteractions || [])
      .filter((i) => i.submissionId === sub.id);
    return { sub, notes, logs, scoreRow, grasp, comments, transitions, aiInteractions };
  }, [state, selectedSubmissionId]);

  useEffect(() => {
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
  }, [selected?.sub.id, selected?.scoreRow?.submissionId]);

  useEffect(() => {
    setDropQuote(null);
    setPendingRange(null);
    setNoteText("");
    setCommentText("");
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

    // 승인 시 거부 사유 초기화
    if (stage === "outline") updateSubmission(subId, { outlineApprovedAt: Date.now(), outlineRejectReason: "" });
    if (stage === "draft") updateSubmission(subId, { draftApprovedAt: Date.now(), draftRejectReason: "" });
    if (stage === "revise") updateSubmission(subId, { reviseApprovedAt: Date.now(), reviseRejectReason: "", finalApprovedAt: Date.now() });
    bump();
  }

  function openRejectModal(stage: Stage) {
    setRejectStage(stage);
    setRejectReason("");
    setShowRejectModal(true);
  }

  function confirmReject() {
    if (!selected || !rejectReason.trim()) return;
    const patch: Partial<Submission> = {};
    if (rejectStage === "outline") {
      patch.outlineRejectReason = rejectReason.trim();
      patch.outlineSubmittedAt = null; // 재제출 가능하도록
    } else if (rejectStage === "draft") {
      patch.draftRejectReason = rejectReason.trim();
      patch.draftSubmittedAt = null;
    } else {
      patch.reviseRejectReason = rejectReason.trim();
      patch.reviseSubmittedAt = null;
    }
    updateSubmission(selected.sub.id, patch);
    setShowRejectModal(false);
    bump();
  }

  function cancelFinalApproval(subId: string) {
    setError(null);
    const db = loadTeacherDb();
    const sub = db.submissions.find((s) => s.id === subId);
    if (!sub || !sub.finalApprovedAt) return;
    updateSubmission(subId, {
      reviseApprovedAt: null,
      finalApprovedAt: null,
      finalReportPublishedAt: null,
      finalReportSnapshot: "",
    });
    bump();
  }

  /**
   * 단계 승인 취소. 학생이 승인 이후 글을 수정해서 재피드백·재승인이 필요할 때 사용.
   * 후속 단계 승인이 이미 있으면 cascade로 함께 해제(논리 모순 방지).
   *  - outline 취소: outline + draft + revise + final 승인 모두 해제
   *  - draft 취소: draft + revise + final 해제
   *  - revise 취소: revise + final 해제
   * 승인을 취소해도 학생의 제출 시각·본문은 보존된다(다시 검토 가능).
   */
  function cancelStageApproval(subId: string, stage: Stage) {
    setError(null);
    const patch: Partial<Submission> = {};
    if (stage === "outline") {
      patch.outlineApprovedAt = null;
      patch.draftApprovedAt = null;
      patch.reviseApprovedAt = null;
      patch.finalApprovedAt = null;
      patch.finalReportPublishedAt = null;
      patch.finalReportSnapshot = "";
    } else if (stage === "draft") {
      patch.draftApprovedAt = null;
      patch.reviseApprovedAt = null;
      patch.finalApprovedAt = null;
      patch.finalReportPublishedAt = null;
      patch.finalReportSnapshot = "";
    } else {
      patch.reviseApprovedAt = null;
      patch.finalApprovedAt = null;
      patch.finalReportPublishedAt = null;
      patch.finalReportSnapshot = "";
    }
    updateSubmission(subId, patch);
    bump();
  }

  function deleteSelectedSubmission() {
    if (!selected) return;
    setError(null);
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `학생 ${selected.sub.studentNo}의 제출물을 삭제하시겠어요?\n작성 글·피드백·점수·AI 로그가 모두 삭제되며 복구할 수 없습니다.`,
      );
      if (!ok) return;
    }
    const db = loadTeacherDb();
    const next = deleteSubmission(db, selected.sub.id);
    saveTeacherDb(next);
    setSelectedSubmissionId(null);
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

  function sendComment() {
    if (!selected || dashTab === "final") return;
    const text = commentText.trim();
    if (!text) return;

    addTeacherComment({
      id: nanoid(12),
      submissionId: selected.sub.id,
      stage: dashTab as Stage,
      createdAt: Date.now(),
      text,
      readAt: null,
    });
    setCommentText("");
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
      isFinalized: selected.scoreRow?.isFinalized ?? false,
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
    // 점수 최종 확정
    if (scoreRow) {
      upsertScore({ ...scoreRow, isFinalized: true });
    }
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
      else setPendingRange({ start: 0, end: Math.min(q.length, base.length) });
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
      {/* 거부 모달 */}
      {showRejectModal ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}
          onClick={() => setShowRejectModal(false)}>
          <div style={{ background: "#fff", borderRadius: 16, padding: 20, maxWidth: 420, width: "90%", color: "#0f172a" }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10 }}>
              {stageText(rejectStage)} 거부 사유
            </div>
            <textarea
              className={styles.textarea}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="학생에게 전달할 거부 사유를 입력하세요..."
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
              <button type="button" className={styles.smallBtn} onClick={() => setShowRejectModal(false)}>취소</button>
              <button type="button" className={styles.approveBtn} style={{ background: "#fecaca", borderColor: "#ef4444", color: "#991b1b" }}
                onClick={confirmReject} disabled={!rejectReason.trim()}>거부 확인</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 학생 사고 성장 대시보드 모달 */}
      {selected ? (
        <Modal
          isOpen={showStudentDashboard}
          onClose={() => setShowStudentDashboard(false)}
          title={`사고 성장 대시보드 — 학생 ${selected.sub.studentNo}`}
          size="xl"
          footer={
            <Button variant="secondary" onClick={() => setShowStudentDashboard(false)}>
              닫기
            </Button>
          }
        >
          <StudentDashboard
            submission={selected.sub}
            transitions={selected.transitions}
            aiInteractions={selected.aiInteractions}
            grasp={selected.grasp}
          />
        </Modal>
      ) : null}

      <div className={styles.top}>
        <button className={styles.back} onClick={() => router.push("/teacher")}>
          ← 교사 화면
        </button>
        <div>
          <div className={styles.title}>{state.assignment.title}</div>
          <div className={styles.sub}>실시간 모니터링 · 승인/거부 · 피드백 · 최종 배포</div>
        </div>
      </div>

      <div className={styles.grid}>
        {/* ── 좌측: 학생 목록 ── */}
        <div className={styles.panel}>
          <div className={styles.panelTitle}>학생 현황</div>
          {state.subs.length === 0 ? (
            <div className={styles.empty}>
              아직 학생 제출 데이터가 없습니다.
            </div>
          ) : (
            <>
              {subsByClass.length > 1 ? (
                <div className={styles.filterRow}>
                  <button
                    type="button"
                    className={[styles.filterChip, classFilter === "all" ? styles.filterChipOn : ""].join(" ")}
                    onClick={() => setClassFilter("all")}
                  >
                    전체 ({state.subs.length})
                  </button>
                  {subsByClass.map((g) => (
                    <button
                      key={g.classId}
                      type="button"
                      className={[styles.filterChip, classFilter === g.classId ? styles.filterChipOn : ""].join(" ")}
                      onClick={() => setClassFilter(g.classId)}
                    >
                      {g.className} ({g.subs.length})
                    </button>
                  ))}
                </div>
              ) : null}

              {exportError ? <div className={styles.error} style={{ marginBottom: 12 }}>{exportError}</div> : null}

              <div className={styles.list}>
                {visibleGroups.map(({ classId, className, subs }) => (
                <div key={classId} className={styles.classGroup}>
                  <div className={styles.classGroupHead}>
                    <div className={styles.classGroupTitle}>{className}</div>
                    <div className={styles.classGroupActions}>
                      <button
                        type="button"
                        className={styles.exportBtn}
                        onClick={() => void exportClassSubmissions({ classId, className, subs }, "csv")}
                        disabled={exportBusyClassId === classId || subs.length === 0}
                        title="이 학급의 제출 글을 CSV로 내려받기"
                      >
                        {exportBusyClassId === classId ? "…" : "📊 CSV"}
                      </button>
                      <button
                        type="button"
                        className={styles.exportBtn}
                        onClick={() => void exportClassSubmissions({ classId, className, subs }, "pdf")}
                        disabled={exportBusyClassId === classId || subs.length === 0}
                        title="이 학급의 제출 글을 PDF로 내려받기"
                      >
                        {exportBusyClassId === classId ? "…" : "📄 PDF"}
                      </button>
                    </div>
                  </div>
                  {subs.map((s) => (
                    <button key={s.id} type="button"
                      className={[styles.row, selectedSubmissionId === s.id ? styles.rowActive : ""].join(" ")}
                      onClick={() => setSelectedSubmissionId(s.id)}>
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
                        {" · "}
                        {(s.outlineText + s.draftText + s.reviseText).replace(/\s/g, "").length}자
                      </div>
                    </button>
                  ))}
                </div>
              ))}
              </div>
            </>
          )}
        </div>

        {/* ── 우측: 학생 대시보드 ── */}
        <div className={styles.panel}>
          <div className={styles.panelTitle} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>학생 대시보드</span>
            {selected ? (
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className={styles.smallBtn}
                  style={{ fontSize: 11 }}
                  onClick={() => setShowStudentDashboard(true)}>
                  사고 성장 대시보드
                </button>
                <button
                  type="button"
                  className={styles.smallBtn}
                  style={{
                    fontSize: 11,
                    background: "#fef2f2",
                    borderColor: "#fecaca",
                    color: "#991b1b",
                  }}
                  onClick={deleteSelectedSubmission}
                  title="이 학생의 제출물(글·피드백·점수·AI 로그)을 삭제합니다."
                >
                  🗑 제출물 삭제
                </button>
              </div>
            ) : null}
          </div>
          {!selected ? (
            <div className={styles.empty}>왼쪽에서 학생을 선택하세요.</div>
          ) : (
            <>
              <div className={styles.dashTabs}>
                {(["outline", "draft", "revise", "final"] as const).map((t) => (
                  <button key={t} type="button"
                    className={[styles.dashTab, dashTab === t ? styles.dashTabOn : ""].join(" ")}
                    onClick={() => setDashTab(t)}>
                    {t === "outline" ? "개요쓰기" : t === "draft" ? "초고쓰기" : t === "revise" ? "고쳐쓰기" : "최종 대시보드"}
                  </button>
                ))}
              </div>

              {/* GRASP 정보 표시 */}
              {selected.grasp ? (
                <div style={{ marginBottom: 12 }}>
                  <GraspSummary grasp={selected.grasp} />
                </div>
              ) : null}

              {dashTab !== "final" ? (
                <>
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>
                      현재 단계: {stageText(currentStage(selected.sub))}
                      <div style={{ display: "flex", gap: 6 }}>
                        {(() => {
                          const tabStage = dashTab as Stage;
                          const tabApproved =
                            tabStage === "outline"
                              ? !!selected.sub.outlineApprovedAt
                              : tabStage === "draft"
                                ? !!selected.sub.draftApprovedAt
                                : !!selected.sub.reviseApprovedAt;
                          const isCurrentTab = dashTab === currentStage(selected.sub);
                          // 승인 완료된 단계: '승인완료' 표시 + '승인취소' 버튼
                          if (tabApproved) {
                            return (
                              <>
                                <span
                                  className={styles.approveBtn}
                                  style={{
                                    marginLeft: 10,
                                    background: "#dcfce7",
                                    borderColor: "#86efac",
                                    color: "#166534",
                                    cursor: "default",
                                  }}
                                  aria-disabled="true"
                                >
                                  ✓ 승인완료
                                </span>
                                <button
                                  type="button"
                                  className={styles.smallBtn}
                                  onClick={() =>
                                    cancelStageApproval(selected.sub.id, tabStage)
                                  }
                                  title="학생이 글을 수정한 뒤 다시 피드백·승인할 수 있도록 승인을 취소합니다."
                                >
                                  승인취소
                                </button>
                              </>
                            );
                          }
                          // 미승인: 승인/거부 버튼 (현재 단계에서만 활성)
                          return (
                            <>
                              <button
                                type="button"
                                className={styles.approveBtn}
                                style={{ marginLeft: 10 }}
                                disabled={!isCurrentTab}
                                onClick={() =>
                                  approveStage(selected.sub.id, tabStage)
                                }
                                title={
                                  !isCurrentTab
                                    ? "현재 단계에서만 승인할 수 있습니다."
                                    : undefined
                                }
                              >
                                {dashTab === "outline"
                                  ? "개요 승인"
                                  : dashTab === "draft"
                                    ? "초고 승인"
                                    : "최종 승인"}
                              </button>
                              {isCurrentTab ? (
                                <button
                                  type="button"
                                  className={styles.smallBtn}
                                  style={{
                                    background: "#fef2f2",
                                    borderColor: "#fecaca",
                                    color: "#991b1b",
                                  }}
                                  onClick={() => openRejectModal(tabStage)}
                                >
                                  거부
                                </button>
                              ) : null}
                            </>
                          );
                        })()}
                        {dashTab === "revise" && selected.sub.finalApprovedAt ? (
                          <button type="button" className={styles.smallBtn}
                            onClick={() => cancelFinalApproval(selected.sub.id)}>
                            최종 배포 취소
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* 학생 글 실시간 열람 */}
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>학생 글 (실시간, 드래그하여 피드백)</div>
                    <div
                      id="select-box"
                      className={styles.selectBox}
                      style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}
                      onDragStart={onDragStartSelect}
                    >
                      {textForStage(selected.sub, dashTab as Stage) || "(아직 작성된 내용이 없습니다)"}
                    </div>
                    {(() => {
                      const text = textForStage(selected.sub, dashTab as Stage);
                      const charsWithSpaces = text.length;
                      const charsNoSpaces = text.replace(/\s/g, "").length;
                      const paragraphs = text.trim() ? text.trim().split(/\n+/).length : 0;
                      return (
                        <div className={styles.statsBar}>
                          <span>글자수(공백포함): <b>{charsWithSpaces}</b></span>
                          <span>글자수(공백제외): <b>{charsNoSpaces}</b></span>
                          <span>문단: <b>{paragraphs}</b></span>
                        </div>
                      );
                    })()}
                    <div className={styles.dim}>
                      글에서 드래그한 뒤 아래 점선 영역에 놓으면 인용 박스로 고정됩니다.
                    </div>
                  </div>

                  {/* 피드백(메모) 영역 */}
                  <div className={styles.feedbackDropZone} onDragOver={(e) => e.preventDefault()} onDrop={onDropFeedback}>
                    <div className={styles.blockTitle}>피드백(메모)</div>
                    {dropQuote ? (
                      <div className={styles.quoteBox}>
                        <div className={styles.quoteBoxLabel}>인용 구간</div>
                        <div className={styles.quoteBoxText}>{dropQuote}</div>
                      </div>
                    ) : (
                      <div className={styles.dropHint}>여기로 글을 드래그하면 인용 박스가 표시됩니다.</div>
                    )}

                    {/* 피드백 템플릿 */}
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", marginBottom: 4 }}>템플릿</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {FEEDBACK_TEMPLATES.map((t, i) => (
                          <button key={i} type="button" className={styles.smallBtn}
                            style={{ height: 26, fontSize: 10, padding: "0 8px" }}
                            onClick={() => setNoteText((prev) => prev ? `${prev}\n${t}` : t)}>
                            {t.slice(0, 25)}...
                          </button>
                        ))}
                      </div>
                    </div>

                    <textarea className={styles.textarea} value={noteText} onChange={(e) => setNoteText(e.target.value)}
                      placeholder="피드백 내용만 입력하세요." />
                    <button type="button" className={styles.smallBtn} onClick={addNote}>메모 저장</button>
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

                  {/* 교사 실시간 코멘트 */}
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>실시간 코멘트 전송</div>
                    <div className={styles.dim} style={{ marginBottom: 6 }}>
                      학생 화면에 실시간 알림으로 전달됩니다.
                    </div>
                    <textarea className={styles.textarea} value={commentText} onChange={(e) => setCommentText(e.target.value)}
                      placeholder="학생에게 전달할 코멘트를 입력하세요..." style={{ minHeight: 60 }} />
                    <button type="button" className={styles.smallBtn} onClick={sendComment} disabled={!commentText.trim()}>
                      코멘트 전송
                    </button>
                    {selected.comments.length > 0 ? (
                      <div className={styles.noteList}>
                        {selected.comments.slice(0, 5).map((c) => (
                          <div key={c.id} className={styles.noteItem}>
                            <div style={{ fontSize: 10, color: "#64748b" }}>
                              [{stageText(c.stage as Stage)}] {new Date(c.createdAt).toLocaleString("ko-KR")}
                              {c.readAt ? " (읽음)" : ""}
                            </div>
                            <div className={styles.noteText}>{c.text}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* AI 활용 이력 */}
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>AI 활용 이력</div>
                    {selected.aiInteractions.length > 0 ? (
                      <div className={styles.log}>
                        {selected.aiInteractions.slice(-15).map((i) => (
                          <div key={i.id} className={styles.logRow}>
                            <span className={styles.role}>{i.type}</span>
                            <span className={styles.logText}>
                              {i.action === "accepted" ? "[수용]" : i.action === "modified" ? "[수정]" : "[거부]"} {i.response.slice(0, 100)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.dim}>AI 협력 활용 기록이 없습니다.</div>
                    )}
                  </div>

                  {/* AI 대화 로그 */}
                  <div className={styles.block}>
                    <div className={styles.blockTitle}>AI 튜터 대화 로그</div>
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
                      <div className={styles.dim}>AI 튜터 사용 기록이 없습니다.</div>
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
    grasp: Grasp | null;
    comments: TeacherComment[];
    transitions: StepTransition[];
    aiInteractions: AiInteraction[];
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
          <input type="number" className={styles.scoreInput} value={outlinePart}
            onChange={(e) => setOutlinePart(e.target.value === "" ? "" : Number(e.target.value))} />
        </label>
        <label>
          초고 점수
          <input type="number" className={styles.scoreInput} value={draftPart}
            onChange={(e) => setDraftPart(e.target.value === "" ? "" : Number(e.target.value))} />
        </label>
        <label>
          고쳐쓰기 점수
          <input type="number" className={styles.scoreInput} value={revisePart}
            onChange={(e) => setRevisePart(e.target.value === "" ? "" : Number(e.target.value))} />
        </label>
      </div>
      <div className={styles.totalLine}>부분 합계: <b>{total}</b></div>

      <textarea className={styles.textarea} value={generalFeedback} onChange={(e) => setGeneralFeedback(e.target.value)} placeholder="총평" />
      <div className={styles.scoreRow}>
        <label className={styles.scoreLabel}>
          통합 점수(표시용)
          <input className={styles.scoreInput} type="number" value={score}
            onChange={(e) => setScore(e.target.value === "" ? "" : Number(e.target.value))} />
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
        <button type="button" className={styles.smallBtn} onClick={saveScore}>저장하기</button>
        <button type="button" className={styles.publishBtn} onClick={publishFinalReport}>저장 후 배포하기</button>
      </div>
    </div>
  );
}
