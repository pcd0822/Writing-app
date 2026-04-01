"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import styles from "./write.module.css";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { AiTutor } from "@/components/student/AiTutor";
import { downloadAssignmentZip } from "@/lib/downloadAssignmentPackage";
import {
  findShare,
  getOrCreateSubmission,
  isShareActive,
  loadTeacherDb,
  resolveFeedbackNote,
  updateSubmission,
  saveTeacherDb,
} from "@/lib/localDb";
import type { Stage, TeacherDb } from "@/lib/types";
import { parseFinalReportSnapshot, type FinalReportSnapshotV1 } from "@/lib/finalReport";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";

type FeedbackPanelTab = "outline" | "draft" | "revise" | "final";

const TUTOR_W_KEY = "writing-app:tutorWidthPx";
const TUTOR_H_KEY = "writing-app:tutorHeightPx";

function stageLabel(stage: Stage) {
  if (stage === "outline") return "1단계: 개요쓰기";
  if (stage === "draft") return "2단계: 초고쓰기";
  return "3단계: 고쳐쓰기";
}

function stageSubmitted(s: { outlineSubmittedAt: number | null; draftSubmittedAt: number | null; reviseSubmittedAt: number | null }, stage: Stage) {
  if (stage === "outline") return s.outlineSubmittedAt != null;
  if (stage === "draft") return s.draftSubmittedAt != null;
  return s.reviseSubmittedAt != null;
}

function stageApproved(s: { outlineApprovedAt: number | null; draftApprovedAt: number | null; reviseApprovedAt: number | null }, stage: Stage) {
  if (stage === "outline") return s.outlineApprovedAt != null;
  if (stage === "draft") return s.draftApprovedAt != null;
  return s.reviseApprovedAt != null;
}

type EditUnlock = Record<Stage, boolean>;

export default function WritePage() {
  const params = useParams<{ token: string }>();
  const sp = useSearchParams();
  const token = params?.token;
  const studentNo = sp.get("studentNo") || "";
  const sid = sp.get("sid") || "";

  const [tab, setTab] = useState<Stage>("outline");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAssignmentDownload, setIsAssignmentDownload] = useState(false);
  const [outlineText, setOutlineText] = useState("");
  const [draftText, setDraftText] = useState("");
  const [reviseText, setReviseText] = useState("");
  const saveTimer = useRef<number | null>(null);
  const [selection, setSelection] = useState<{
    stage: Stage;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [aiReference, setAiReference] = useState<string | null>(null);
  const [dbBump, setDbBump] = useState(0);
  const [stageEditUnlocked, setStageEditUnlocked] = useState<EditUnlock>({
    outline: false,
    draft: false,
    revise: false,
  });
  const [showSubmitSuccess, setShowSubmitSuccess] = useState(false);
  const [feedbackPanelTab, setFeedbackPanelTab] = useState<FeedbackPanelTab>("outline");
  const [feedbackNoteModalId, setFeedbackNoteModalId] = useState<string | null>(null);
  const [tutorWidth, setTutorWidth] = useState(320);
  const [tutorHeight, setTutorHeight] = useState(520);

  const state = useMemo(() => {
    if (!token || !studentNo) return { ok: false as const, reason: "missing" };
    try {
      const db = loadTeacherDb();
      const share = findShare(db, token);
      if (!share || !isShareActive(share)) return { ok: false as const, reason: "share" };
      const assignment = db.assignments.find((a) => a.id === share.assignmentId) || null;
      if (!assignment) return { ok: false as const, reason: "assignment" };
      const cls =
        db.classes.find((c) => c.students.some((s) => s.studentNo === studentNo)) || null;
      if (!cls) return { ok: false as const, reason: "student" };
      const { submission } = getOrCreateSubmission({
        assignmentId: assignment.id,
        classId: cls.id,
        studentNo,
      });
      const notes = db.feedbackNotes
        .filter((n) => n.submissionId === submission.id && !n.resolvedAt)
        .sort((a, b) => a.createdAt - b.createdAt);
      const score = db.scores.find((s) => s.submissionId === submission.id) || null;
      return { ok: true as const, db, share, assignment, cls, submission, notes, score };
    } catch {
      return { ok: false as const, reason: "error" };
    }
  }, [token, studentNo, dbBump]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const w = localStorage.getItem(TUTOR_W_KEY);
      const h = localStorage.getItem(TUTOR_H_KEY);
      if (w) {
        const n = parseInt(w, 10);
        if (Number.isFinite(n)) setTutorWidth(Math.min(560, Math.max(240, n)));
      }
      if (h) {
        const n = parseInt(h, 10);
        if (Number.isFinite(n)) setTutorHeight(Math.min(window.innerHeight - 32, Math.max(280, n)));
      } else {
        setTutorHeight(Math.min(560, window.innerHeight - 32));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TUTOR_W_KEY, String(tutorWidth));
    } catch {
      /* ignore */
    }
  }, [tutorWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(TUTOR_H_KEY, String(tutorHeight));
    } catch {
      /* ignore */
    }
  }, [tutorHeight]);

  useEffect(() => {
    if (!sid) return;
    setActiveSpreadsheetId(sid);
    void pullDbFromSheet(sid)
      .then((remote) => {
        if (remote) saveTeacherDb(remote as TeacherDb);
        setDbBump((v) => v + 1);
      })
      .catch(() => {});
  }, [sid]);

  const onResizeWidthStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = tutorWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        setTutorWidth(Math.min(560, Math.max(240, startW + delta)));
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [tutorWidth],
  );

  const onResizeHeightStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = tutorHeight;
      const onMove = (ev: MouseEvent) => {
        const maxH = typeof window !== "undefined" ? window.innerHeight - 32 : 900;
        const delta = ev.clientY - startY;
        setTutorHeight(Math.min(maxH, Math.max(280, startH + delta)));
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [tutorHeight],
  );

  const canOpenDraft = state.ok && !!state.submission.outlineApprovedAt;
  const canOpenRevise = state.ok && !!state.submission.draftApprovedAt;

  useEffect(() => {
    if (!state.ok) return;
    setOutlineText(state.submission.outlineText || "");
    setDraftText(state.submission.draftText || "");
    setReviseText(state.submission.reviseText || "");
  }, [state.ok, state.ok ? state.submission.id : null]);

  useEffect(() => {
    if (!state.ok) return;
    setStageEditUnlocked({ outline: false, draft: false, revise: false });
  }, [state.ok, state.ok ? state.submission.id : null]);

  function bumpDb() {
    setDbBump((v) => v + 1);
  }

  function persist(stage: Stage, text: string) {
    if (!state.ok) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (stage === "outline") updateSubmission(state.submission.id, { outlineText: text });
      else if (stage === "draft") updateSubmission(state.submission.id, { draftText: text });
      else updateSubmission(state.submission.id, { reviseText: text });
      bumpDb();
    }, 120);
  }

  function flushSaveToDb() {
    if (!state.ok) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    updateSubmission(state.submission.id, {
      outlineText,
      draftText,
      reviseText,
    });
    bumpDb();
  }

  async function onSaveClick() {
    if (!state.ok) return;
    setError(null);
    setIsSaving(true);
    try {
      flushSaveToDb();
    } finally {
      setIsSaving(false);
    }
  }

  function stageStatusPill(stage: Stage) {
    if (!state.ok) return { label: "", className: styles.statusPillWriting };
    const s = state.submission;
    const sub = stageSubmitted(s, stage);
    const ap = stageApproved(s, stage);
    if (ap) return { label: "작성완료", className: styles.statusPillDone };
    if (sub && stageEditUnlocked[stage]) return { label: "수정중", className: styles.statusPillEditing };
    if (sub) return { label: "작성완료", className: styles.statusPillDone };
    return { label: "작성중", className: styles.statusPillWriting };
  }

  function currentText(stage: Stage) {
    if (!state.ok) return "";
    if (stage === "outline") return outlineText;
    if (stage === "draft") return draftText;
    return reviseText;
  }

  function renderFeedbackInText(text: string, noteStage: Stage) {
    if (!state.ok) return text;
    const notes = state.notes
      .filter((n) => n.stage === noteStage && !n.resolvedAt)
      .slice()
      .sort((a, b) => a.start - b.start);
    if (notes.length === 0) return text;

    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const n of notes) {
      const start = Math.max(0, Math.min(text.length, n.start));
      const end = Math.max(start, Math.min(text.length, n.end));
      if (start > cursor) nodes.push(<span key={`t-${cursor}`}>{text.slice(cursor, start)}</span>);
      nodes.push(
        <span key={`m-${n.id}`} className={styles.hlGroup}>
          <mark
            id={`note-${n.id}`}
            className={styles.feedbackMark}
            title="피드백이 연결된 구간"
          >
            {text.slice(start, end)}
          </mark>
          <button
            type="button"
            className={styles.feedbackIconBtn}
            aria-label="피드백 보기"
            title="피드백 보기"
            onClick={() => setFeedbackNoteModalId(n.id)}
          >
            💬
          </button>
        </span>,
      );
      cursor = end;
    }
    if (cursor < text.length) nodes.push(<span key="t-end">{text.slice(cursor)}</span>);
    return nodes;
  }

  function setText(stage: Stage, text: string) {
    if (!state.ok) return;
    if (stage === "outline") setOutlineText(text);
    else if (stage === "draft") setDraftText(text);
    else setReviseText(text);
    persist(stage, text);
  }

  function editorLocked(stage: Stage) {
    if (!state.ok) return true;
    const s = state.submission;
    if (stageApproved(s, stage)) return true;
    const sub = stageSubmitted(s, stage);
    if (!sub) return false;
    return !stageEditUnlocked[stage];
  }

  async function onSubmitStage(stage: Stage) {
    setError(null);
    if (!state.ok) return;
    const text = currentText(stage).trim();
    if (!text) {
      setError("내용을 작성한 뒤 제출해주세요.");
      return;
    }
    flushSaveToDb();
    setIsSubmitting(true);
    try {
      if (stage === "outline") updateSubmission(state.submission.id, { outlineSubmittedAt: Date.now() });
      else if (stage === "draft") updateSubmission(state.submission.id, { draftSubmittedAt: Date.now() });
      else updateSubmission(state.submission.id, { reviseSubmittedAt: Date.now() });
      setStageEditUnlocked((prev) => ({ ...prev, [stage]: false }));
      bumpDb();
      setShowSubmitSuccess(true);
    } finally {
      setIsSubmitting(false);
    }
  }

  function onEditStage(stage: Stage) {
    setStageEditUnlocked((prev) => ({ ...prev, [stage]: true }));
  }

  function canShowSubmit(stage: Stage) {
    if (!state.ok) return false;
    const s = state.submission;
    if (stageApproved(s, stage)) return false;
    const sub = stageSubmitted(s, stage);
    if (!sub) return true;
    return stageEditUnlocked[stage];
  }

  function canShowEdit(stage: Stage) {
    if (!state.ok) return false;
    const s = state.submission;
    if (stageApproved(s, stage)) return false;
    const sub = stageSubmitted(s, stage);
    return sub && !stageEditUnlocked[stage];
  }

  if (!state.ok) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          접근 정보가 올바르지 않습니다. 교사에게 공유 링크를 다시 요청하세요.
        </div>
      </div>
    );
  }

  const contextHint = `${state.assignment.title} / ${stageLabel(tab)} / 학생 ${studentNo}`;
  const currentStageForSelection = tab;
  const locked = editorLocked(tab);

  function onEditorMouseUp(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (locked) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end <= start) {
      setSelection(null);
      return;
    }
    const text = el.value.slice(start, end).trim();
    if (!text) {
      setSelection(null);
      return;
    }
    setSelection({
      stage: currentStageForSelection,
      text,
      x: e.clientX,
      y: e.clientY,
    });
  }

  function sendSelectionToAi() {
    if (!selection) return;
    setAiReference(selection.text);
    setSelection(null);
  }

  async function onDownloadAssignment() {
    if (!state.ok) return;
    setError(null);
    setIsAssignmentDownload(true);
    try {
      await downloadAssignmentZip(state.assignment);
    } catch {
      setError("과제 자료를 내려받지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setIsAssignmentDownload(false);
    }
  }

  function onResolveNote(noteId: string) {
    resolveFeedbackNote(noteId);
    bumpDb();
  }

  const spStatus = stageStatusPill(tab);
  const approvedNow = stageApproved(state.submission, tab);
  const submitDisabled =
    !currentText(tab).trim() ||
    isSubmitting ||
    !canShowSubmit(tab);

  return (
    <div className={styles.page}>
      <Modal
        isOpen={showSubmitSuccess}
        onClose={() => setShowSubmitSuccess(false)}
        title="완료되었습니다!"
        description="제출이 반영되었습니다."
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setShowSubmitSuccess(false)}>
            확인
          </Button>
        }
      >
        <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.55 }}>
          교사 검토 후 다음 단계로 진행할 수 있습니다.
        </div>
      </Modal>

      <Modal
        isOpen={!!feedbackNoteModalId}
        onClose={() => setFeedbackNoteModalId(null)}
        title="교사 피드백"
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setFeedbackNoteModalId(null)}>
            닫기
          </Button>
        }
      >
        <div style={{ fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
          {feedbackNoteModalId
            ? state.notes.find((n) => n.id === feedbackNoteModalId)?.teacherText || ""
            : ""}
        </div>
      </Modal>

      <div
        className={styles.shell}
        style={{
          gridTemplateColumns: `minmax(286px, 390px) minmax(0, 1fr) ${tutorWidth}px`,
        }}
      >
        <aside className={styles.assignmentPanel}>
          <div className={styles.assignmentScroll}>
            <div className={styles.assignmentTitle}>{state.assignment.title}</div>
            <div className={styles.assignmentMeta}>
              학생 {studentNo} · {state.cls.name}
            </div>
            <div>
              <div className={styles.sectionLabel}>제시문</div>
              <div className={styles.assignmentPrompt}>
                <ReactMarkdown>{state.assignment.prompt}</ReactMarkdown>
              </div>
            </div>
            <div>
              <div className={styles.sectionLabel}>과제</div>
              <div className={styles.assignmentTask}>{state.assignment.task}</div>
            </div>
            <button
              type="button"
              className={styles.attachBtn}
              disabled={isAssignmentDownload}
              onClick={() => void onDownloadAssignment()}
            >
              {isAssignmentDownload ? "준비 중…" : "과제 다운로드"}
            </button>

            <div className={styles.sectionLabel} style={{ marginTop: 12 }}>
              교사 피드백 보기
            </div>
            <div className={styles.feedbackPanelTabs}>
              {(["outline", "draft", "revise", "final"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={[
                    styles.feedbackTabBtn,
                    feedbackPanelTab === t ? styles.feedbackTabBtnOn : "",
                  ].join(" ")}
                  onClick={() => setFeedbackPanelTab(t)}
                >
                  {t === "outline"
                    ? "개요"
                    : t === "draft"
                      ? "초고"
                      : t === "revise"
                        ? "고쳐쓰기"
                        : "최종"}
                </button>
              ))}
            </div>
            <div className={styles.feedbackPanelBody}>
              {feedbackPanelTab === "final" ? (
                state.submission.finalReportPublishedAt && state.submission.finalReportSnapshot ? (
                  <FinalStudentReport snap={parseFinalReportSnapshot(state.submission.finalReportSnapshot || "")} />
                ) : (
                  <div className={styles.dim}>교사가 최종 대시보드를 배포하면 여기에 표시됩니다.</div>
                )
              ) : (
                <div className={styles.feedbackReadonly}>
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                    {feedbackPanelTab === "outline"
                      ? "개요 글 중 피드백 구간"
                      : feedbackPanelTab === "draft"
                        ? "초고 글 중 피드백 구간"
                        : "고쳐쓰기 글 중 피드백 구간"}
                  </div>
                  <div className={styles.quote} style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                    {renderFeedbackInText(
                      feedbackPanelTab === "outline"
                        ? outlineText
                        : feedbackPanelTab === "draft"
                          ? draftText
                          : reviseText,
                      feedbackPanelTab,
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        <div className={styles.panel}>
          <div className={styles.head}>
            <div className={styles.title}>작문</div>
            <div className={styles.sub}>단계별로 작성하고 제출하세요.</div>
          </div>

          <div className={styles.tabs}>
            <button
              className={[styles.tab, tab === "outline" ? styles.tabActive : ""].join(" ")}
              onClick={() => setTab("outline")}
            >
              개요
            </button>
            <button
              className={[
                styles.tab,
                tab === "draft" ? styles.tabActive : "",
                !canOpenDraft ? styles.tabDisabled : "",
              ].join(" ")}
              onClick={() => canOpenDraft && setTab("draft")}
              disabled={!canOpenDraft}
            >
              초고
            </button>
            <button
              className={[
                styles.tab,
                tab === "revise" ? styles.tabActive : "",
                !canOpenRevise ? styles.tabDisabled : "",
              ].join(" ")}
              onClick={() => canOpenRevise && setTab("revise")}
              disabled={!canOpenRevise}
            >
              고쳐쓰기
            </button>
          </div>

          <div className={styles.stageToolbar}>
            <div className={styles.stageToolbarLeft}>
              <span className={styles.stageTitle}>{stageLabel(tab)}</span>
              <span className={[styles.statusPill, spStatus.className].join(" ")}>{spStatus.label}</span>
            </div>
            <div className={styles.stageToolbarRight}>
              {!approvedNow ? (
                <button
                  type="button"
                  className={styles.stepBtnPrimary}
                  disabled={submitDisabled}
                  onClick={() => void onSubmitStage(tab)}
                >
                  {isSubmitting ? "제출 중…" : "제출하기"}
                </button>
              ) : null}
              {canShowEdit(tab) ? (
                <button type="button" className={styles.stepBtnSecondary} onClick={() => onEditStage(tab)}>
                  수정하기
                </button>
              ) : null}
            </div>
          </div>

          <div className={styles.body}>
            <div className={styles.editorLabel}>
              {tab === "outline"
                ? "개요는 Markdown으로 작성할 수 있어요."
                : "줄글 형식(워드 느낌)으로 작성하세요. 문단 구분은 줄바꿈을 사용하세요."}
            </div>

            <textarea
              className={[styles.editor, tab === "outline" ? styles.mono : ""].join(" ")}
              value={currentText(tab)}
              onChange={(e) => setText(tab, e.target.value)}
              onMouseUp={onEditorMouseUp}
              placeholder={
                tab === "outline"
                  ? "- 주장\n  - 근거 1\n  - 근거 2\n- 예상 반론과 재반박\n"
                  : "여기에 글을 작성하세요…"
              }
              disabled={locked}
            />

            {selection ? (
              <div className={styles.selectionBar}>
                <div className={styles.selectionText}>
                  선택됨: {selection.text.length > 220 ? `${selection.text.slice(0, 220)}…` : selection.text}
                </div>
                <button
                  type="button"
                  className={styles.questionBtn}
                  onClick={sendSelectionToAi}
                  title="이 구간을 AI 튜터에 참고로 보내기"
                >
                  ?
                </button>
              </div>
            ) : null}

            {tab === "outline" && currentText("outline").trim() ? (
              <div className={styles.noteBox}>
                <div className={styles.noteTitle}>개요 미리보기</div>
                <div className={styles.markdownPreview}>
                  <ReactMarkdown>{currentText("outline")}</ReactMarkdown>
                </div>
              </div>
            ) : null}

            {tab === "revise" && state.notes.length ? (
              <div className={styles.noteBox}>
                <div className={styles.noteTitle}>교사 메모(첨삭)</div>
                <div className={styles.quote} style={{ marginBottom: 10 }}>
                  아래 “초고 하이라이트”에서 메모가 달린 구간이 표시됩니다. 해당 구간을 수정한 뒤
                  “첨삭 완료”를 누르면 하이라이트가 사라집니다.
                </div>
                <div className={styles.noteBox} style={{ marginBottom: 10 }}>
                  <div className={styles.noteTitle}>초고 하이라이트</div>
                  <div className={styles.quote}>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                      {renderFeedbackInText(draftText || "", "draft")}
                    </div>
                  </div>
                </div>
                {state.notes
                  .filter((n) => n.stage === "draft" || n.stage === "revise")
                  .map((n) => (
                    <div key={n.id} className={styles.noteItem}>
                      <div className={styles.quote}>{n.anchorText}</div>
                      <div className={styles.teacherText}>{n.teacherText}</div>
                      <button
                        className={styles.smallBtn}
                        onClick={() => onResolveNote(n.id)}
                        title="이 메모에 대한 첨삭을 완료했으면 완료 처리하세요."
                      >
                        첨삭 완료
                      </button>
                    </div>
                  ))}
              </div>
            ) : null}

            {state.score?.teacherSummary ? (
              <div className={styles.noteBox}>
                <div className={styles.noteTitle}>총평/점수</div>
                <div className={styles.teacherText}>{state.score.teacherSummary}</div>
                <div className={styles.quote}>
                  점수: <b>{state.score.score ?? "미입력"}</b>
                </div>
              </div>
            ) : null}

            {error ? <div className={styles.error}>{error}</div> : null}

            <Button onClick={() => void onSaveClick()} isLoading={isSaving} variant="secondary">
              저장하기
            </Button>
          </div>
        </div>

        <div className={styles.tutorCol} style={{ height: tutorHeight }}>
          <div className={styles.tutorResizeWidth} onMouseDown={onResizeWidthStart} title="너비 조절" />
          <div className={styles.tutorInner}>
            <AiTutor
              submissionId={state.submission.id}
              stage={tab}
              contextHint={contextHint}
              referenceText={aiReference}
            />
          </div>
          <div className={styles.tutorResizeHeight} onMouseDown={onResizeHeightStart} title="높이 조절" />
        </div>
      </div>

      {selection ? (
        <button
          type="button"
          className={styles.questionFloat}
          style={{
            left: Math.min(selection.x + 10, typeof window !== "undefined" ? window.innerWidth - 50 : 400),
            top: Math.min(selection.y + 10, typeof window !== "undefined" ? window.innerHeight - 50 : 400),
          }}
          onClick={sendSelectionToAi}
          title="선택 구간을 AI 튜터에 참고로 보내기"
        >
          ?
        </button>
      ) : null}
    </div>
  );
}

function FinalStudentReport({ snap }: { snap: FinalReportSnapshotV1 | null }) {
  if (!snap) {
    return <div style={{ fontSize: 12, opacity: 0.75 }}>표시할 데이터가 없습니다.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800 }}>최종 점수: {snap.totalScore}</div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        부분 점수 — 개요: {snap.partialScores.outline ?? "—"} / 초고: {snap.partialScores.draft ?? "—"} / 고쳐쓰기:{" "}
        {snap.partialScores.revise ?? "—"}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{snap.teacherSummary}</div>
      <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" }}>{snap.narrativeSummary}</div>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>질문 키워드</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {snap.questionStats.wordFrequency.slice(0, 8).map((w) => (
          <li key={w.word}>
            {w.word} — {w.count}회
          </li>
        ))}
      </ul>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>교사 메모 요약</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {snap.feedbackMemos.slice(0, 12).map((m) => (
          <li key={m.id} style={{ marginBottom: 6 }}>
            <b>[{m.stage}]</b> {m.teacherText}
          </li>
        ))}
      </ul>
    </div>
  );
}
