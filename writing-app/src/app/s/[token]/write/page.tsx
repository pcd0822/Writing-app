"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import styles from "./write.module.css";
import { Button } from "@/components/ui/Button";
import { AiTutor } from "@/components/student/AiTutor";
import { AttachmentDrawer } from "@/components/student/AttachmentDrawer";
import {
  findShare,
  getCurrentStage,
  getOrCreateSubmission,
  isShareActive,
  loadTeacherDb,
  resolveFeedbackNote,
  updateSubmission,
  saveTeacherDb,
} from "@/lib/localDb";
import type { Stage } from "@/lib/types";
import { pullDbFromSheet, setActiveSpreadsheetId } from "@/lib/spreadsheetSync";

function stageLabel(stage: Stage) {
  if (stage === "outline") return "1단계: 개요쓰기";
  if (stage === "draft") return "2단계: 초고쓰기";
  return "3단계: 고쳐쓰기";
}

export default function WritePage() {
  const params = useParams<{ token: string }>();
  const sp = useSearchParams();
  const token = params?.token;
  const studentNo = sp.get("studentNo") || "";
  const sid = sp.get("sid") || "";

  const [tab, setTab] = useState<Stage>("outline");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
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
      const currentStage = getCurrentStage(submission);
      const score = db.scores.find((s) => s.submissionId === submission.id) || null;
      return { ok: true as const, db, share, assignment, cls, submission, notes, currentStage, score };
    } catch {
      return { ok: false as const, reason: "error" };
    }
  }, [token, studentNo]);

  // sid가 있으면 최신 DB pull (최초 렌더 시만). saveTeacherDb가 push를 담당.
  useEffect(() => {
    if (!sid) return;
    setActiveSpreadsheetId(sid);
    void pullDbFromSheet(sid)
      .then((remote) => {
        if (remote) saveTeacherDb(remote as any);
      })
      .catch(() => {});
  }, [sid]);

  const canOpenDraft = state.ok && !!state.submission.outlineApprovedAt;
  const canOpenRevise = state.ok && !!state.submission.draftApprovedAt;

  // submission 로드 시 로컬 편집 상태 동기화
  useEffect(() => {
    if (!state.ok) return;
    setOutlineText(state.submission.outlineText || "");
    setDraftText(state.submission.draftText || "");
    setReviseText(state.submission.reviseText || "");
  }, [state.ok, state.ok ? state.submission.id : null]);

  function persist(stage: Stage, text: string) {
    if (!state.ok) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (stage === "outline") updateSubmission(state.submission.id, { outlineText: text });
      else if (stage === "draft") updateSubmission(state.submission.id, { draftText: text });
      else updateSubmission(state.submission.id, { reviseText: text });
    }, 120);
  }

  function approvalPill(stage: Stage) {
    if (!state.ok) return "";
    const s = state.submission;
    if (stage === "outline") {
      if (s.outlineApprovedAt) return "승인 완료";
      if (s.outlineSubmittedAt) return "승인 대기중";
      return "작성 중";
    }
    if (stage === "draft") {
      if (s.draftApprovedAt) return "승인 완료";
      if (s.draftSubmittedAt) return "승인 대기중";
      return "작성 중";
    }
    if (s.reviseApprovedAt) return "승인 완료";
    if (s.reviseSubmittedAt) return "승인 대기중";
    return "작성 중";
  }

  function currentText(stage: Stage) {
    if (!state.ok) return "";
    if (stage === "outline") return outlineText;
    if (stage === "draft") return draftText;
    return reviseText;
  }

  function renderHighlights(text: string, noteStage: Stage) {
    if (!state.ok) return text;
    const notes = state.notes
      .filter((n) => n.stage === noteStage && !n.resolvedAt)
      .slice()
      .sort((a, b) => a.start - b.start);
    if (notes.length === 0) return text;

    const nodes: any[] = [];
    let cursor = 0;
    for (const n of notes) {
      const start = Math.max(0, Math.min(text.length, n.start));
      const end = Math.max(start, Math.min(text.length, n.end));
      if (start > cursor) nodes.push(<span key={`t-${cursor}`}>{text.slice(cursor, start)}</span>);
      nodes.push(
        <mark
          key={`m-${n.id}`}
          id={`note-${n.id}`}
          style={{
            background: "rgba(250, 204, 21, 0.22)",
            borderRadius: 6,
            padding: "0 2px",
            border: "1px solid rgba(250, 204, 21, 0.25)",
          }}
          title={n.teacherText}
        >
          {text.slice(start, end)}
        </mark>,
      );
      cursor = end;
    }
    if (cursor < text.length) nodes.push(<span key={`t-end`}>{text.slice(cursor)}</span>);
    return nodes;
  }

  function setText(stage: Stage, text: string) {
    if (!state.ok) return;
    if (stage === "outline") setOutlineText(text);
    else if (stage === "draft") setDraftText(text);
    else setReviseText(text);
    persist(stage, text);
  }

  async function onSubmit(stage: Stage) {
    setError(null);
    if (!state.ok) return;
    const text = currentText(stage).trim();
    if (!text) {
      setError("내용을 작성한 뒤 제출해주세요.");
      return;
    }
    setIsSubmitting(true);
    try {
      if (stage === "outline") updateSubmission(state.submission.id, { outlineSubmittedAt: Date.now() });
      else if (stage === "draft") updateSubmission(state.submission.id, { draftSubmittedAt: Date.now() });
      else updateSubmission(state.submission.id, { reviseSubmittedAt: Date.now() });
    } finally {
      setIsSubmitting(false);
    }
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

  const lockedByApproval =
    (tab === "outline" && !!state.submission.outlineSubmittedAt && !state.submission.outlineApprovedAt) ||
    (tab === "draft" && !!state.submission.draftSubmittedAt && !state.submission.draftApprovedAt) ||
    (tab === "revise" && !!state.submission.reviseSubmittedAt && !state.submission.reviseApprovedAt);

  const contextHint = `${state.assignment.title} / ${stageLabel(tab)} / 학생 ${studentNo}`;
  const editorDisabled = lockedByApproval;
  const currentStageForSelection = tab;

  const attachments = state.assignment.attachments || [];

  function onEditorMouseUp(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (editorDisabled) return;
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
    // 드래그한 “옆” 느낌으로: mouseup 지점 근처에 버튼 표시
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
    // AI로 보낸 뒤 선택 UI는 정리(원하면 유지 가능)
    setSelection(null);
  }

  return (
    <div className={styles.page}>
      <AttachmentDrawer
        attachments={attachments}
        isOpen={attachmentOpen}
        onClose={() => setAttachmentOpen(false)}
      />
      <div className={styles.shell}>
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
              disabled={attachments.length === 0}
              onClick={() => setAttachmentOpen(true)}
            >
              {attachments.length === 0 ? "등록된 첨부 없음" : "첨부파일 보기"}
            </button>
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

          <div className={styles.body}>
            <div className={styles.statusRow}>
              <div className={styles.pill}>{stageLabel(tab)}</div>
              <div className={styles.pill}>{approvalPill(tab)}</div>
            </div>

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
              disabled={lockedByApproval}
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
                <ReactMarkdown>{currentText("outline")}</ReactMarkdown>
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
                      {renderHighlights(draftText || "", "draft")}
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
                        onClick={() => resolveFeedbackNote(n.id)}
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

            <Button
              onClick={() => onSubmit(tab)}
              isLoading={isSubmitting}
              disabled={lockedByApproval}
            >
              제출하기
            </Button>
          </div>
        </div>

        <div className={styles.tutorCol}>
          <AiTutor
            submissionId={state.submission.id}
            stage={tab}
            contextHint={contextHint}
            referenceText={aiReference}
          />
        </div>
      </div>

      {selection ? (
        <button
          type="button"
          className={styles.questionFloat}
          style={{ left: Math.min(selection.x + 10, window.innerWidth - 50), top: Math.min(selection.y + 10, window.innerHeight - 50) }}
          onClick={sendSelectionToAi}
          title="선택 구간을 AI 튜터에 참고로 보내기"
        >
          ?
        </button>
      ) : null}
    </div>
  );
}

