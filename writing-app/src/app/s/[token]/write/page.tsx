"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import styles from "./write.module.css";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { AiCollaborationPanel } from "@/components/student/AiCollaborationPanel";
import { RevisionGuide } from "@/components/student/RevisionGuide";
import { GraspForm } from "@/components/student/GraspForm";
import { GraspSummary } from "@/components/student/GraspSummary";
import { StudentDashboard } from "@/components/student/StudentDashboard";
import { downloadAssignmentZip } from "@/lib/downloadAssignmentPackage";
import { AI_PROMPTS } from "@/lib/aiWritingPrompts";
import { callFunction } from "@/lib/netlifyClient";
import { nanoid } from "nanoid";
import {
  addStepTransition,
  findShare,
  getGraspData,
  getOrCreateSubmission,
  isShareActive,
  loadTeacherDb,
  markCommentRead,
  mergeStudentViewFromRemote,
  resolveFeedbackNote,
  stageToStep,
  stepToStage,
  updateSubmissionAndPushPartial,
  updateSubmissionAndPushStudent,
  updateSubmissionLocalOnly,
} from "@/lib/localDb";
import type {
  AiInteraction,
  Assignment,
  ClassRoom,
  FeedbackNote,
  Grasp,
  Score,
  ShareLink,
  Stage,
  StepTransition,
  Submission,
  TeacherComment,
  TeacherDb,
} from "@/lib/types";
import { parseFinalReportSnapshot, type FinalReportSnapshotV1 } from "@/lib/finalReport";
import {
  flushPendingPartialPush,
  flushPendingPush,
  setActiveSpreadsheetId,
} from "@/lib/spreadsheetSync";

type FeedbackPanelTab = "outline" | "draft" | "revise" | "final";
type ViewMode = "write" | "dashboard";

const TUTOR_W_KEY = "writing-app:tutorWidthPx";
const TUTOR_H_KEY = "writing-app:tutorHeightPx";
const GRASP_COLLAPSED_KEY = "writing-app:graspCollapsed";

/**
 * Markdown은 단일 \n을 줄바꿈으로 인식하지 않으므로(같은 단락으로 합침),
 * 학생이 엔터 한 번으로 줄을 내렸을 때 그대로 보이게 하기 위해
 * 모든 \n 앞에 trailing two-space(soft break)를 강제로 붙여 렌더링한다.
 * ※ 이미 두 칸이 있는 줄에도 영향이 없으며 fenced code block은 보존됨.
 */
function applySoftBreaks(md: string): string {
  return md.replace(/(^|[^ \t])([ \t]?)\n/g, (_m, lead, sp) => `${lead}${sp}  \n`);
}

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

type WriteState =
  | { ok: false; reason: "loading" | "missing" | "share" | "assignment" | "student" | "error" }
  | {
      ok: true;
      db: TeacherDb;
      share: ShareLink;
      assignment: Assignment;
      cls: ClassRoom;
      submission: Submission;
      notes: FeedbackNote[];
      score: Score | null;
      comments: TeacherComment[];
      transitions: StepTransition[];
      aiInteractions: AiInteraction[];
    };

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
  const reviseSeededRef = useRef<string | null>(null);
  const [selection, setSelection] = useState<{
    stage: Stage;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [aiSelectedText, setAiSelectedText] = useState("");
  const [dbBump, setDbBump] = useState(0);
  const initialLoadDone = useRef(false);
  const [stageEditUnlocked, setStageEditUnlocked] = useState<EditUnlock>({
    outline: false,
    draft: false,
    revise: false,
  });
  const [showSubmitSuccess, setShowSubmitSuccess] = useState(false);
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);
  const [feedbackPanelTab, setFeedbackPanelTab] = useState<FeedbackPanelTab>("outline");
  const [feedbackNoteModalId, setFeedbackNoteModalId] = useState<string | null>(null);
  const [tutorWidth, setTutorWidth] = useState(420);
  const [tutorHeight, setTutorHeight] = useState(900);
  const [graspCollapsed, setGraspCollapsed] = useState(false);

  // 새 상태들
  const [viewMode, setViewMode] = useState<ViewMode>("write");
  const [showGraspForm, setShowGraspForm] = useState(false);
  const [graspData, setGraspData] = useState<Grasp | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [tutorTriggerLoading, setTutorTriggerLoading] = useState(false);
  const [tutorTriggerResponse, setTutorTriggerResponse] = useState<string | null>(null);

  const [state, setState] = useState<WriteState>({ ok: false, reason: "loading" });

  // 읽지 않은 교사 코멘트 수
  const unreadCommentCount = useMemo(() => {
    if (!state.ok) return 0;
    return state.comments.filter((c) => !c.readAt).length;
  }, [state]);

  useEffect(() => {
    if (!token || !studentNo) {
      setState({ ok: false, reason: "missing" });
      return;
    }
    try {
      const db = loadTeacherDb();
      const share = findShare(db, token);
      if (!share || !isShareActive(share)) {
        setState({ ok: false, reason: "share" });
        return;
      }
      const assignment = db.assignments.find((a) => a.id === share.assignmentId) || null;
      if (!assignment) {
        setState({ ok: false, reason: "assignment" });
        return;
      }
      const cls =
        db.classes.find((c) => c.students.some((s) => s.studentNo === studentNo)) || null;
      if (!cls) {
        setState({ ok: false, reason: "student" });
        return;
      }
      const { submission } = getOrCreateSubmission({
        assignmentId: assignment.id,
        classId: cls.id,
        studentNo,
      });
      const notes = db.feedbackNotes
        .filter((n) => n.submissionId === submission.id && !n.resolvedAt)
        .sort((a, b) => a.createdAt - b.createdAt);
      const score = db.scores.find((s) => s.submissionId === submission.id) || null;
      const comments = (db.teacherComments || [])
        .filter((c) => c.submissionId === submission.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      const transitions = (db.stepTransitions || [])
        .filter((t) => t.submissionId === submission.id)
        .sort((a, b) => a.timestamp - b.timestamp);
      const aiInteractions = (db.aiInteractions || [])
        .filter((i) => i.submissionId === submission.id)
        .sort((a, b) => a.timestamp - b.timestamp);

      // GRASP 데이터 로드
      // - DB에 값이 있으면 React 상태에도 반영
      // - DB에 값이 없을 때 React 상태(graspData)를 null로 덮어쓰지 않음
      //   (저장 직후 polling 동기화에서 잠깐 비어 보일 수 있음)
      // - 모달 자동 열기는 "최초 진입에 GRASPS 미작성"인 경우로만 제한
      //   → 한 번 닫힌 뒤 polling으로 모달이 자동 재오픈되는 버그 방지
      const g = getGraspData(submission);
      if (g) setGraspData(g);
      if (!g && !initialLoadDone.current) setShowGraspForm(true);
      initialLoadDone.current = true;

      setState({
        ok: true,
        db,
        share,
        assignment,
        cls,
        submission,
        notes,
        score,
        comments,
        transitions,
        aiInteractions,
      });
    } catch {
      setState({ ok: false, reason: "error" });
    }
  }, [token, studentNo, dbBump]);

  const effectiveSheetId =
    sid.trim() ||
    (state.ok && state.share.spreadsheetId ? state.share.spreadsheetId.trim() : "") ||
    "";

  const sheetSaveOpts = useMemo(
    () => ({ spreadsheetId: effectiveSheetId || undefined }),
    [effectiveSheetId],
  );

  /**
   * partial update endpoint(`db-set-submission`)에 필요한 인증 정보. share landing의
   * `onEnter` 단계에서 sessionStorage에 보관한 값을 읽는다. 코드가 없거나 sessionStorage
   * 사용 불가(시크릿 모드 등)면 partial path 비활성화 → 풀-DB push로 자연 fallback.
   */
  const studentAuth = useMemo<
    | {
        spreadsheetId: string;
        shareToken: string;
        studentNo: string;
        studentCode: string;
      }
    | null
  >(() => {
    if (typeof window === "undefined" || !token || !effectiveSheetId) return null;
    try {
      const raw = window.sessionStorage.getItem(`writing-app:studentAuth:${token}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        shareToken?: string;
        studentNo?: string;
        studentCode?: string;
      };
      if (
        !parsed.shareToken ||
        !parsed.studentNo ||
        !parsed.studentCode ||
        parsed.studentNo !== studentNo
      ) {
        return null;
      }
      return {
        spreadsheetId: effectiveSheetId,
        shareToken: parsed.shareToken,
        studentNo: parsed.studentNo,
        studentCode: parsed.studentCode,
      };
    } catch {
      return null;
    }
  }, [token, studentNo, effectiveSheetId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const w = localStorage.getItem(TUTOR_W_KEY);
      const h = localStorage.getItem(TUTOR_H_KEY);
      const gc = localStorage.getItem(GRASP_COLLAPSED_KEY);
      if (w) {
        const n = parseInt(w, 10);
        if (Number.isFinite(n)) setTutorWidth(Math.min(700, Math.max(300, n)));
      }
      if (h) {
        const n = parseInt(h, 10);
        if (Number.isFinite(n)) setTutorHeight(Math.min(window.innerHeight - 32, Math.max(280, n)));
      } else {
        setTutorHeight(Math.max(720, window.innerHeight - 32));
      }
      if (gc != null) setGraspCollapsed(gc === "1");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(GRASP_COLLAPSED_KEY, graspCollapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [graspCollapsed]);

  useEffect(() => {
    try { localStorage.setItem(TUTOR_W_KEY, String(tutorWidth)); } catch { /* ignore */ }
  }, [tutorWidth]);

  useEffect(() => {
    try { localStorage.setItem(TUTOR_H_KEY, String(tutorHeight)); } catch { /* ignore */ }
  }, [tutorHeight]);

  /**
   * 교사 코멘트·승인 등을 학생 화면으로 가져오기 위한 polling.
   * - 10초 → 60초로 완화: 학생 30명 동시 접속 기준 read 호출량을 1/6로 줄여 quota 보호.
   * - document.hidden일 때는 polling을 건너뛰어 백그라운드 탭에서 무의미한 호출을 차단.
   * - 화면이 다시 보이는 시점에 즉시 1회 refresh해 실시간성을 일부 회복.
   */
  useEffect(() => {
    if (!effectiveSheetId) return;
    setActiveSpreadsheetId(effectiveSheetId);
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      void mergeStudentViewFromRemote(effectiveSheetId).then(() => {
        if (!cancelled) setDbBump((v) => v + 1);
      });
    };
    tick();
    const id = window.setInterval(tick, 60000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      cancelled = true;
      window.clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [effectiveSheetId]);

  const onResizeWidthStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = tutorWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        setTutorWidth(Math.min(700, Math.max(300, startW + delta)));
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

  // 단계 이동 가능 여부: 뒤로 이동은 항상 가능, 앞으로 이동은 승인 후
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

  // 고쳐쓰기 단계 자동 인계: 교사가 초고를 승인했고 학생이 아직 고쳐쓰기를 시작하지 않았다면
  // 초고 텍스트(draftText)를 reviseText의 시작점으로 자동 복사한다.
  // submission.id 단위로 한 번만 트리거 — 학생이 의도적으로 비우면 다시 채우지 않는다.
  useEffect(() => {
    if (!state.ok) return;
    const subId = state.submission.id;
    if (reviseSeededRef.current === subId) return;
    if (!state.submission.draftApprovedAt) return;
    if ((state.submission.reviseText || "").length > 0) {
      reviseSeededRef.current = subId;
      return;
    }
    const seed = state.submission.draftText || "";
    if (!seed.trim()) {
      reviseSeededRef.current = subId;
      return;
    }
    reviseSeededRef.current = subId;
    setReviseText(seed);
    persist("revise", seed);
  }, [
    state.ok,
    state.ok ? state.submission.id : null,
    state.ok ? state.submission.draftApprovedAt : null,
  ]);

  function bumpDb() {
    setDbBump((v) => v + 1);
  }

  // 탭 전환 시 stepTransition 기록
  function handleTabChange(newStage: Stage) {
    if (!state.ok || newStage === tab) return;

    const fromStep = stageToStep(tab);
    const toStep = stageToStep(newStage);
    const isForward = toStep > fromStep;
    const isFirstTimeForward = isForward && !stageApproved(state.submission, tab);

    // 앞으로 이동인데 승인 안 된 경우 차단
    if (newStage === "draft" && !canOpenDraft) return;
    if (newStage === "revise" && !canOpenRevise) return;

    let reason: "initial_progress" | "revision_back" | "revision_forward" = "revision_forward";
    if (isForward && isFirstTimeForward) {
      reason = "initial_progress";
    } else if (!isForward) {
      reason = "revision_back";
    }

    addStepTransition(
      {
        id: nanoid(10),
        submissionId: state.submission.id,
        studentNo,
        fromStep,
        toStep,
        timestamp: Date.now(),
        reason,
      },
      sheetSaveOpts,
    );

    setTab(newStage);
    bumpDb();
  }

  /**
   * 키 입력 자동저장 — localStorage만 갱신하고 시트 push는 하지 않는다.
   * 시트 push는 명시적 "저장하기/제출하기" 또는 단계 전환·GRASP 저장 등에서만 발생.
   * 학생당 시트 read/write 호출량을 90% 이상 줄여 quota 폭주를 막는 핵심 변경.
   */
  function persist(stage: Stage, text: string) {
    if (!state.ok) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!state.ok) return;
      try {
        const patch =
          stage === "outline" ? { outlineText: text } :
          stage === "draft" ? { draftText: text } :
          { reviseText: text };
        updateSubmissionLocalOnly(state.submission.id, patch);
        bumpDb();
      } catch { /* ignore */ }
    }, 120);
  }

  /**
   * localStorage 갱신 후 시트 push가 실제로 끝날 때까지 대기. push 실패 시 throw하여
   * 호출자가 "제출 완료" 모달을 띄우지 않도록 한다.
   *
   * studentAuth가 확보된 경우 partial endpoint를 사용 — 시트 페이로드가 학생 1명분으로
   * 줄어 9초 timeout 위험 사실상 0. 인증 정보가 없으면(레거시 세션 등) 풀-DB push로 fallback.
   */
  async function flushSaveToDb() {
    if (!state.ok) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const patch = { outlineText, draftText, reviseText };
    if (studentAuth) {
      updateSubmissionAndPushPartial(state.submission.id, patch, studentAuth);
      await flushPendingPartialPush(studentAuth.spreadsheetId, state.submission.id);
    } else {
      updateSubmissionAndPushStudent(state.submission.id, patch, sheetSaveOpts);
      if (effectiveSheetId) {
        await flushPendingPush(effectiveSheetId);
      }
    }
    bumpDb();
  }

  async function onSaveClick() {
    if (!state.ok) return;
    setError(null);
    setIsSaving(true);
    try {
      await flushSaveToDb();
      setShowSaveSuccess(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg.trim()
          ? `저장에 실패했습니다: ${msg}. 잠시 후 다시 시도해주세요.`
          : "저장에 실패했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  // GRASP 저장
  async function onGraspSave(grasp: Grasp) {
    if (!state.ok) return;
    setGraspData(grasp);
    setShowGraspForm(false);
    const patch = { graspData: JSON.stringify(grasp) };
    if (studentAuth) {
      updateSubmissionAndPushPartial(state.submission.id, patch, studentAuth);
    } else {
      updateSubmissionAndPushStudent(state.submission.id, patch, sheetSaveOpts);
    }
    bumpDb();
  }

  function stageStatusPill(stage: Stage) {
    if (!state.ok) return { label: "", className: styles.statusPillWriting };
    const s = state.submission;
    const sub = stageSubmitted(s, stage);
    const ap = stageApproved(s, stage);
    if (ap && stageEditUnlocked[stage]) return { label: "승인 후 수정중", className: styles.statusPillEditing };
    if (ap) return { label: "승인완료", className: styles.statusPillDone };
    if (sub && stageEditUnlocked[stage]) return { label: "수정중", className: styles.statusPillEditing };
    if (sub) return { label: "제출완료", className: styles.statusPillDone };
    return { label: "작성중", className: styles.statusPillWriting };
  }

  function currentText(stage: Stage) {
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
          <mark id={`note-${n.id}`} className={styles.feedbackMark} title="피드백이 연결된 구간">
            {text.slice(start, end)}
          </mark>
          <button
            type="button"
            className={styles.feedbackIconBtn}
            aria-label="피드백 보기"
            onClick={() => setFeedbackNoteModalId(n.id)}
          >
            [F]
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
    // 승인된 단계라도 수정하기를 누르면 편집 가능
    if (stageApproved(s, stage)) return !stageEditUnlocked[stage];
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
    // GRASP 필수 체크 (개요 제출 시)
    if (stage === "outline" && !graspData) {
      setError("개요 제출 전에 GRASPS 맥락 설계를 먼저 완료해주세요.");
      setShowGraspForm(true);
      return;
    }
    setIsSubmitting(true);
    try {
      // 자동저장 타이머가 떠 있으면 취소(아래에서 본문 + submit 시각을 한 번에 push)
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const submitAt = Date.now();
      const patch: Partial<Submission> = (() => {
        if (stage === "outline") {
          return {
            outlineText,
            draftText,
            reviseText,
            outlineSubmittedAt: submitAt,
            outlineApprovedAt: null,
          };
        }
        if (stage === "draft") {
          return {
            outlineText,
            draftText,
            reviseText,
            draftSubmittedAt: submitAt,
            draftApprovedAt: null,
          };
        }
        return {
          outlineText,
          draftText,
          reviseText,
          reviseSubmittedAt: submitAt,
          reviseApprovedAt: null,
        };
      })();
      // 본문 + 제출 시각을 단일 push에 묶고, 시트 반영이 끝날 때까지 대기.
      // 실패 시 throw → "제출 완료" 모달이 뜨지 않으므로 데이터 손실 인지 가능.
      if (studentAuth) {
        updateSubmissionAndPushPartial(state.submission.id, patch, studentAuth);
        await flushPendingPartialPush(studentAuth.spreadsheetId, state.submission.id);
      } else {
        updateSubmissionAndPushStudent(state.submission.id, patch, sheetSaveOpts);
        if (effectiveSheetId) {
          await flushPendingPush(effectiveSheetId);
        }
      }
      setStageEditUnlocked((prev) => ({ ...prev, [stage]: false }));
      bumpDb();
      setShowSubmitSuccess(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg.trim()
          ? `제출에 실패했습니다: ${msg}. 작성 내용은 기기에 저장되어 있으니 잠시 후 다시 시도해주세요.`
          : "제출에 실패했습니다. 네트워크 상태를 확인하고 잠시 후 다시 시도해주세요. 작성 내용은 기기에 보관됩니다.",
      );
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
    // 승인된 단계에서 수정 중이면 재제출 가능
    if (stageApproved(s, stage)) return stageEditUnlocked[stage];
    const sub = stageSubmitted(s, stage);
    if (!sub) return true;
    return stageEditUnlocked[stage];
  }

  function canShowEdit(stage: Stage) {
    if (!state.ok) return false;
    const s = state.submission;
    const sub = stageSubmitted(s, stage) || stageApproved(s, stage);
    return sub && !stageEditUnlocked[stage];
  }

  // AI 튜터 트리거 버튼
  async function onTutorTrigger() {
    if (!state.ok || !graspData) return;
    setTutorTriggerLoading(true);
    setTutorTriggerResponse(null);
    try {
      const stageLabels: Record<Stage, string> = { outline: "개요", draft: "초고", revise: "고쳐쓰기" };
      let prevContent = "";
      if (tab === "draft") prevContent = outlineText;
      else if (tab === "revise") prevContent = draftText;

      const prompt = AI_PROMPTS.tutorFeedback(
        stageLabels[tab],
        prevContent,
        currentText(tab),
        graspData,
      );
      const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
      setTutorTriggerResponse(res.text || "피드백을 생성하지 못했습니다.");
    } catch {
      setTutorTriggerResponse("AI 튜터 피드백 생성 중 오류가 발생했습니다.");
    } finally {
      setTutorTriggerLoading(false);
    }
  }

  // 교사 코멘트 읽음 처리
  function onReadComment(commentId: string) {
    markCommentRead(commentId, sheetSaveOpts);
    bumpDb();
  }

  if (!state.ok) {
    if (state.reason === "loading") {
      return (
        <div className={styles.page}>
          <div className={styles.loading}>불러오는 중...</div>
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          접근 정보가 올바르지 않습니다. 교사에게 공유 링크를 다시 요청하세요.
        </div>
      </div>
    );
  }

  // 거부 사유 확인
  const rejectReason =
    tab === "outline" ? state.submission.outlineRejectReason :
    tab === "draft" ? state.submission.draftRejectReason :
    state.submission.reviseRejectReason;

  const locked = editorLocked(tab);

  function onEditorMouseUp(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (locked) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end <= start) { setSelection(null); return; }
    const text = el.value.slice(start, end).trim();
    if (!text) { setSelection(null); return; }
    setSelection({ stage: tab, text, x: e.clientX, y: e.clientY });
  }

  function sendSelectionToAi() {
    if (!selection) return;
    setAiSelectedText(selection.text);
    if (!showAiPanel) setShowAiPanel(true);
    setSelection(null);
  }

  async function onDownloadAssignment() {
    if (!state.ok) return;
    setError(null);
    setIsAssignmentDownload(true);
    try {
      await downloadAssignmentZip(state.assignment);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(msg.trim() ? msg : "첨부를 내려받지 못했습니다.");
    } finally {
      setIsAssignmentDownload(false);
    }
  }

  async function onResolveNote(noteId: string) {
    await mergeStudentViewFromRemote(effectiveSheetId);
    resolveFeedbackNote(noteId, sheetSaveOpts);
    bumpDb();
  }

  const spStatus = stageStatusPill(tab);
  const approvedNow = stageApproved(state.submission, tab);
  const submitDisabled = !currentText(tab).trim() || isSubmitting || !canShowSubmit(tab);

  return (
    <div className={styles.page}>
      <Modal isOpen={showSubmitSuccess} onClose={() => setShowSubmitSuccess(false)} title="완료되었습니다!" description="제출이 반영되었습니다." size="lg"
        footer={<Button variant="secondary" onClick={() => setShowSubmitSuccess(false)}>확인</Button>}>
        <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.55 }}>
          교사 검토 후 다음 단계로 진행할 수 있습니다.
        </div>
      </Modal>

      <Modal isOpen={showSaveSuccess} onClose={() => setShowSaveSuccess(false)} title="저장 완료" description="작성 내용이 저장되었습니다." size="lg"
        footer={<Button variant="secondary" onClick={() => setShowSaveSuccess(false)}>확인</Button>}>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: "#0f172a" }}>
          저장이 완료되었습니다! 구글 스프레드시트에 연결된 경우 잠시 후 시트에도 반영됩니다.
        </div>
      </Modal>

      <Modal isOpen={!!feedbackNoteModalId} onClose={() => setFeedbackNoteModalId(null)} title="교사 피드백" size="lg"
        footer={<Button variant="secondary" onClick={() => setFeedbackNoteModalId(null)}>닫기</Button>}>
        <div style={{ fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
          {feedbackNoteModalId ? state.notes.find((n) => n.id === feedbackNoteModalId)?.teacherText || "" : ""}
        </div>
      </Modal>

      {/* GRASP 폼 모달 */}
      <Modal isOpen={showGraspForm} onClose={() => { if (graspData) setShowGraspForm(false); }} title="GRASPS 맥락 설계" size="xl">
        <GraspForm initial={graspData} onSave={onGraspSave} />
      </Modal>

      {/* 대시보드 모달 */}
      <Modal isOpen={viewMode === "dashboard"} onClose={() => setViewMode("write")} title="사고 성장 대시보드" size="xl"
        footer={<Button variant="secondary" onClick={() => setViewMode("write")}>닫기</Button>}>
        <StudentDashboard
          submission={state.submission}
          transitions={state.transitions}
          aiInteractions={state.aiInteractions}
          grasp={graspData}
        />
      </Modal>

      {/* AI 튜터 트리거 응답 모달 */}
      <Modal isOpen={!!tutorTriggerResponse} onClose={() => setTutorTriggerResponse(null)} title="AI 튜터 피드백" size="lg"
        footer={<Button variant="secondary" onClick={() => setTutorTriggerResponse(null)}>닫기</Button>}>
        <div style={{ fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap", color: "#0f172a" }}>
          {tutorTriggerResponse}
        </div>
      </Modal>

      <div
        className={styles.shell}
        style={{
          gridTemplateColumns: showAiPanel
            ? `minmax(260px, 340px) minmax(0, 1fr) ${tutorWidth}px`
            : `minmax(286px, 390px) minmax(0, 1fr)`,
        }}
      >
        {/* ── 좌측 패널: 과제 정보 + GRASP + 피드백 ── */}
        <aside className={styles.assignmentPanel}>
          <div className={styles.assignmentScroll}>
            <div className={styles.assignmentTitle}>{state.assignment.title}</div>
            <div className={styles.assignmentMeta}>
              학생 {studentNo} · {state.cls.name}
            </div>

            {/* GRASPS 요약 */}
            {graspData ? (
              <GraspSummary
                grasp={graspData}
                onEdit={() => setShowGraspForm(true)}
                collapsed={graspCollapsed}
                onToggleCollapsed={() => setGraspCollapsed((v) => !v)}
              />
            ) : (
              <button
                type="button"
                className={styles.attachBtn}
                onClick={() => setShowGraspForm(true)}
              >
                GRASPS 맥락 설계하기
              </button>
            )}

            <div>
              <div className={styles.sectionLabel}>제시문</div>
              <div className={styles.assignmentPrompt}>
                <ReactMarkdown>{applySoftBreaks(state.assignment.prompt)}</ReactMarkdown>
              </div>
            </div>
            <div>
              <div className={styles.sectionLabel}>과제</div>
              <div className={styles.assignmentTask}>{state.assignment.task}</div>
            </div>
            <button type="button" className={styles.attachBtn} disabled={isAssignmentDownload} onClick={() => void onDownloadAssignment()}>
              {isAssignmentDownload ? "준비 중..." : "첨부 다운로드"}
            </button>

            {/* 교사 코멘트 알림 */}
            {state.comments.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div className={styles.sectionLabel}>
                  교사 코멘트 {unreadCommentCount > 0 ? (
                    <span className={styles.statusPill} style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b", fontSize: 10, padding: "2px 8px", marginLeft: 4 }}>
                      {unreadCommentCount}개 새 코멘트
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                  {state.comments.slice(0, 5).map((c) => (
                    <div key={c.id} className={styles.noteBox} style={{ padding: "8px 10px" }}>
                      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>
                        [{c.stage === "outline" ? "개요" : c.stage === "draft" ? "초고" : "고쳐쓰기"}]
                        {" "}{new Date(c.createdAt).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {!c.readAt ? <span style={{ color: "#ef4444", fontWeight: 800, marginLeft: 4 }}>NEW</span> : null}
                      </div>
                      <div style={{ fontSize: 12, lineHeight: 1.55, color: "#0f172a" }}>{c.text}</div>
                      {!c.readAt ? (
                        <button type="button" className={styles.smallBtn} style={{ marginTop: 4, height: 26, fontSize: 10 }} onClick={() => onReadComment(c.id)}>
                          읽음 처리
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={styles.feedbackCard}>
              <div className={styles.feedbackCardHeader}>교사 피드백 보기</div>
              <div className={styles.feedbackPanelTabs}>
                {(["outline", "draft", "revise", "final"] as const).map((t) => (
                  <button key={t} type="button"
                    className={[styles.feedbackTabBtn, feedbackPanelTab === t ? styles.feedbackTabBtnOn : ""].join(" ")}
                    onClick={() => setFeedbackPanelTab(t)}>
                    {t === "outline" ? "개요" : t === "draft" ? "초고" : t === "revise" ? "고쳐쓰기" : "최종"}
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
                    {feedbackPanelTab === "outline" ? "개요" : feedbackPanelTab === "draft" ? "초고" : "고쳐쓰기"} 글 중 피드백 구간
                  </div>
                  <div className={styles.quote} style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                    {renderFeedbackInText(
                      feedbackPanelTab === "outline" ? outlineText : feedbackPanelTab === "draft" ? draftText : reviseText,
                      feedbackPanelTab,
                    )}
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
        </aside>

        {/* ── 중앙: 에디터 ── */}
        <div className={styles.panel}>
          <div className={styles.head}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className={styles.title}>작문</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className={styles.stepBtnSecondary} style={{ height: 30, fontSize: 11 }}
                  onClick={() => setShowAiPanel(!showAiPanel)}>
                  {showAiPanel ? "AI 패널 접기" : "AI 협력 글쓰기"}
                </button>
                <button type="button" className={styles.stepBtnSecondary} style={{ height: 30, fontSize: 11 }}
                  onClick={() => setViewMode("dashboard")}>
                  성장 대시보드
                </button>
              </div>
            </div>
            <div className={styles.sub}>단계별로 작성하고 제출하세요. 이전 단계로 자유롭게 돌아갈 수 있습니다.</div>
          </div>

          <div className={styles.tabs}>
            <button
              className={[styles.tab, tab === "outline" ? styles.tabActive : ""].join(" ")}
              onClick={() => handleTabChange("outline")}
            >
              개요
            </button>
            <button
              className={[
                styles.tab,
                tab === "draft" ? styles.tabActive : "",
                !canOpenDraft ? styles.tabDisabled : "",
              ].join(" ")}
              onClick={() => canOpenDraft && handleTabChange("draft")}
              disabled={!canOpenDraft}
            >
              초고 {!canOpenDraft ? "(승인 대기)" : ""}
            </button>
            <button
              className={[
                styles.tab,
                tab === "revise" ? styles.tabActive : "",
                !canOpenRevise ? styles.tabDisabled : "",
              ].join(" ")}
              onClick={() => canOpenRevise && handleTabChange("revise")}
              disabled={!canOpenRevise}
            >
              고쳐쓰기 {!canOpenRevise ? "(승인 대기)" : ""}
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
                  data-loading={isSubmitting ? "true" : undefined}
                  onClick={() => void onSubmitStage(tab)}
                >
                  {isSubmitting ? (
                    <span className={styles.btnInline}>
                      <span className={styles.btnSpinner} aria-hidden="true" />
                      <span>제출 중…</span>
                    </span>
                  ) : (
                    "제출하기"
                  )}
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
            {/* 거부 사유 표시 */}
            {rejectReason ? (
              <div className={styles.error} style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#713f12" }}>
                교사 피드백: {rejectReason}
              </div>
            ) : null}

            <div className={styles.editorLabel}>
              {tab === "outline"
                ? "개요는 Markdown으로 작성할 수 있어요."
                : "줄글 형식(워드 느낌)으로 작성하세요. 문단 구분은 줄바꿈을 사용하세요."}
            </div>

            <textarea
              className={[styles.editor, tab === "outline" ? styles.mono : ""].join(" ")}
              value={currentText(tab)}
              onChange={(e) => {
                setText(tab, e.target.value);
                if (selection) setSelection(null);
              }}
              onMouseDown={() => {
                if (selection) setSelection(null);
              }}
              onKeyDown={() => {
                if (selection) setSelection(null);
              }}
              onMouseUp={onEditorMouseUp}
              placeholder={
                tab === "outline"
                  ? "- 주장\n  - 근거 1\n  - 근거 2\n- 예상 반론과 재반박\n"
                  : "여기에 글을 작성하세요..."
              }
              disabled={locked}
            />

            {/* 정량적 지표 */}
            {(() => {
              const text = currentText(tab);
              const charsWithSpaces = text.length;
              const paragraphs = text.trim() ? text.trim().split(/\n+/).length : 0;
              const stageCriteria = state.assignment.criteria?.[tab];
              const minChars = stageCriteria?.minChars;
              const minParagraphs = stageCriteria?.minParagraphs;
              const charsMet = minChars != null ? charsWithSpaces >= minChars : null;
              const paragraphsMet = minParagraphs != null ? paragraphs >= minParagraphs : null;
              return (
                <div className={styles.statsBar}>
                  <span
                    className={
                      charsMet == null
                        ? undefined
                        : charsMet
                          ? styles.statMet
                          : styles.statUnmet
                    }
                  >
                    {charsMet != null ? (
                      <span
                        className={charsMet ? styles.statCheck : styles.statCheckOff}
                        aria-label={charsMet ? "기준 충족" : "기준 미충족"}
                      >
                        {charsMet ? "✓" : "○"}
                      </span>
                    ) : null}
                    글자수(띄어쓰기 포함): <b>{charsWithSpaces}</b>
                    {minChars != null ? (
                      <>
                        {" "}/ <b>{minChars}</b>
                      </>
                    ) : null}
                  </span>
                  <span
                    className={
                      paragraphsMet == null
                        ? undefined
                        : paragraphsMet
                          ? styles.statMet
                          : styles.statUnmet
                    }
                  >
                    {paragraphsMet != null ? (
                      <span
                        className={paragraphsMet ? styles.statCheck : styles.statCheckOff}
                        aria-label={paragraphsMet ? "기준 충족" : "기준 미충족"}
                      >
                        {paragraphsMet ? "✓" : "○"}
                      </span>
                    ) : null}
                    문단 수: <b>{paragraphs}</b>
                    {minParagraphs != null ? (
                      <>
                        {" "}/ <b>{minParagraphs}</b>
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })()}

            {selection ? (
              <div className={styles.selectionBar}>
                <div className={styles.selectionText}>
                  선택됨: {selection.text.length > 220 ? `${selection.text.slice(0, 220)}...` : selection.text}
                </div>
                <button type="button" className={styles.questionBtn} onClick={sendSelectionToAi} title="이 구간을 AI 튜터에 참고로 보내기">
                  ?
                </button>
              </div>
            ) : null}

            {tab === "outline" && currentText("outline").trim() ? (
              <div className={styles.noteBox}>
                <div className={styles.noteTitle}>개요 미리보기</div>
                <div className={styles.markdownPreview}>
                  <ReactMarkdown>{applySoftBreaks(currentText("outline"))}</ReactMarkdown>
                </div>
              </div>
            ) : null}

            {tab === "revise" ? (
              <>
                {/* 초고 하이라이트 (피드백 구간 표시) */}
                {state.notes.length > 0 ? (
                  <div className={styles.noteBox} style={{ marginBottom: 10 }}>
                    <div className={styles.noteTitle}>초고 하이라이트</div>
                    <div className={styles.quote}>
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.75 }}>
                        {renderFeedbackInText(draftText || "", "draft")}
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* 고쳐쓰기 가이드: 체크박스 피드백 + AI 수정 전략 + 비교 점검 */}
                <RevisionGuide
                  submissionId={state.submission.id}
                  notes={state.notes}
                  draftText={draftText}
                  reviseText={reviseText}
                  grasp={graspData}
                  spreadsheetId={effectiveSheetId || undefined}
                  onResolveNote={onResolveNote}
                  onBump={bumpDb}
                />
              </>
            ) : null}

            {state.score?.teacherSummary ? (
              <div className={styles.noteBox}>
                <div className={styles.noteTitle}>총평/점수</div>
                <div className={styles.teacherText}>{state.score.teacherSummary}</div>
                <div className={styles.quote}>
                  점수: <b>{state.score.score ?? "미입력"}</b>
                  {state.score.isFinalized ? " (최종 확정)" : " (임시)"}
                </div>
              </div>
            ) : null}

            {error ? <div className={styles.error}>{error}</div> : null}

            <Button onClick={() => void onSaveClick()} isLoading={isSaving} variant="secondary">
              저장하기
            </Button>
          </div>
        </div>

        {/* ── 우측: AI 협력 글쓰기 (통합) ── */}
        {showAiPanel ? (
          <div className={styles.tutorCol} style={{ height: tutorHeight }}>
            <div className={styles.tutorResizeWidth} onMouseDown={onResizeWidthStart} title="너비 조절" />
            <div className={styles.tutorInner}>
              <AiCollaborationPanel
                submissionId={state.submission.id}
                stage={tab}
                selectedText={aiSelectedText || selection?.text || ""}
                currentText={currentText(tab)}
                outlineText={outlineText}
                grasp={graspData}
                spreadsheetId={effectiveSheetId || undefined}
                submission={state.submission}
                assignment={state.assignment}
                feedbackNotes={state.notes}
                onBump={bumpDb}
              />
            </div>
            <div className={styles.tutorResizeHeight} onMouseDown={onResizeHeightStart} title="높이 조절" />
          </div>
        ) : null}
      </div>

      {/* AI 튜터 트리거 플로팅 버튼 */}
      <button
        type="button"
        className={styles.questionFloat}
        style={{ position: "fixed", bottom: 24, right: 24, width: "auto", height: "auto", padding: "10px 16px", fontSize: 12, fontWeight: 800, zIndex: 90, borderRadius: 14 }}
        onClick={onTutorTrigger}
        disabled={tutorTriggerLoading || !graspData}
        title="현재 단계와 이전 단계를 비교하여 AI 튜터 피드백을 받습니다"
      >
        {tutorTriggerLoading ? "분석 중..." : "AI 튜터에게 물어보기"}
      </button>

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
        부분 점수 -- 개요: {snap.partialScores.outline ?? "--"} / 초고: {snap.partialScores.draft ?? "--"} / 고쳐쓰기:{" "}
        {snap.partialScores.revise ?? "--"}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{snap.teacherSummary}</div>
      <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" }}>{snap.narrativeSummary}</div>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>질문 키워드</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {snap.questionStats.wordFrequency.slice(0, 8).map((w) => (
          <li key={w.word}>{w.word} -- {w.count}회</li>
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
