"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";
import styles from "./RevisionGuide.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { AI_PROMPTS } from "@/lib/aiWritingPrompts";
import { addAiLog } from "@/lib/localDb";
import type { FeedbackNote, Grasp, Stage } from "@/lib/types";

type CheckedMap = Record<string, boolean>;

type GuideQuestion = {
  id: string;
  noteId: string;
  text: string;
  resolved: boolean;
};

type Props = {
  submissionId: string;
  notes: FeedbackNote[];
  draftText: string;
  reviseText: string;
  grasp: Grasp | null;
  spreadsheetId?: string;
  onResolveNote: (noteId: string) => void;
  onBump: () => void;
};

export function RevisionGuide({
  submissionId,
  notes,
  draftText,
  reviseText,
  grasp,
  spreadsheetId,
  onResolveNote,
  onBump,
}: Props) {
  const sheetOpts = useMemo(
    () => ({ spreadsheetId: spreadsheetId?.trim() || undefined }),
    [spreadsheetId],
  );

  const relevantNotes = useMemo(
    () => notes.filter((n) => (n.stage === "draft" || n.stage === "revise") && !n.resolvedAt),
    [notes],
  );

  const [checkedNotes, setCheckedNotes] = useState<CheckedMap>({});
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [questions, setQuestions] = useState<GuideQuestion[]>([]);
  const [compareLoading, setCompareLoading] = useState<string | null>(null);
  const [compareResults, setCompareResults] = useState<Record<string, string>>({});

  // 미해결 피드백 요약 자동 생성 (notes 변경 시)
  useEffect(() => {
    if (relevantNotes.length === 0) {
      setSummaryText(null);
      return;
    }
    let cancelled = false;
    setSummaryLoading(true);
    const items = relevantNotes.map((n) => ({
      anchorText: n.anchorText,
      teacherText: n.teacherText,
    }));
    const prompt = AI_PROMPTS.revisionFeedbackSummary(items, grasp);
    callFunction<{ text: string }>("gemini-chat", { prompt })
      .then((res) => {
        if (cancelled) return;
        const text = (res.text || "").trim() || "요약을 생성하지 못했습니다.";
        setSummaryText(text);
        addAiLog(
          {
            id: nanoid(12),
            submissionId,
            stage: "revise" as Stage,
            createdAt: Date.now(),
            role: "assistant",
            text: `[피드백 요약] ${text.slice(0, 500)}`,
          },
          sheetOpts,
        );
      })
      .catch(() => {
        if (!cancelled) setSummaryText("피드백 요약 생성 중 오류가 발생했습니다.");
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => { cancelled = true; };
  }, [relevantNotes.map((n) => n.id).join(",")]);

  // 체크박스 토글 → 비교 점검 질문 생성
  const onCheck = useCallback(
    async (noteId: string) => {
      const note = relevantNotes.find((n) => n.id === noteId);
      if (!note) return;

      setCheckedNotes((prev) => ({ ...prev, [noteId]: true }));
      setCompareLoading(noteId);

      try {
        const prompt = AI_PROMPTS.revisionCompare(
          note.teacherText,
          note.anchorText,
          draftText,
          reviseText,
          grasp,
        );
        const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
        const text = (res.text || "").trim() || "비교 질문을 생성하지 못했습니다.";

        setCompareResults((prev) => ({ ...prev, [noteId]: text }));

        const q: GuideQuestion = {
          id: nanoid(10),
          noteId,
          text,
          resolved: false,
        };
        setQuestions((prev) => [...prev, q]);

        await addAiLog(
          {
            id: nanoid(12),
            submissionId,
            stage: "revise" as Stage,
            createdAt: Date.now(),
            role: "assistant",
            text: `[비교 점검] ${text.slice(0, 500)}`,
          },
          sheetOpts,
        );
      } catch {
        setCompareResults((prev) => ({ ...prev, [noteId]: "비교 질문 생성 중 오류가 발생했습니다." }));
      } finally {
        setCompareLoading(null);
      }
    },
    [relevantNotes, draftText, reviseText, grasp, submissionId, sheetOpts],
  );

  // 질문 해결 → 피드백 노트도 완료 처리 → 다음 미해결 피드백 자동 진행
  const onResolveQuestion = useCallback(
    (questionId: string) => {
      setQuestions((prev) =>
        prev.map((q) => (q.id === questionId ? { ...q, resolved: true } : q)),
      );

      const q = questions.find((q) => q.id === questionId);
      if (q) {
        onResolveNote(q.noteId);
      }

      // 다음 미해결 피드백 자동 체크
      const nextUnresolved = relevantNotes.find(
        (n) => !checkedNotes[n.id] && (!q || n.id !== q.noteId),
      );
      if (nextUnresolved) {
        onCheck(nextUnresolved.id);
      }

      onBump();
    },
    [questions, relevantNotes, checkedNotes, onResolveNote, onCheck, onBump],
  );

  if (relevantNotes.length === 0) {
    return (
      <div className={styles.wrap}>
        <div className={styles.emptyState}>
          교사 피드백이 모두 해결되었습니다. 고쳐쓰기를 마무리하세요!
        </div>
      </div>
    );
  }

  const unresolvedCount = relevantNotes.filter((n) => !checkedNotes[n.id]).length;
  const resolvedCount = relevantNotes.length - unresolvedCount;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>고쳐쓰기 가이드</div>
        <div className={styles.progress}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${(resolvedCount / relevantNotes.length) * 100}%` }}
            />
          </div>
          <span className={styles.progressText}>
            {resolvedCount}/{relevantNotes.length} 해결
          </span>
        </div>
      </div>

      {/* 미해결 피드백 요약 */}
      {summaryLoading ? (
        <div className={styles.summaryBox}>
          <div className={styles.loadingText}>미해결 피드백을 분석하고 있습니다...</div>
        </div>
      ) : summaryText ? (
        <div className={styles.summaryBox}>
          <div className={styles.summaryLabel}>AI 수정 전략 안내</div>
          <div className={styles.summaryContent}>{summaryText}</div>
        </div>
      ) : null}

      {/* 교사 피드백 체크리스트 */}
      <div className={styles.checklistSection}>
        <div className={styles.sectionLabel}>교사 피드백 체크리스트</div>
        {relevantNotes.map((note) => {
          const isChecked = !!checkedNotes[note.id];
          const isCompareLoading = compareLoading === note.id;
          const compareResult = compareResults[note.id];
          const relatedQuestion = questions.find((q) => q.noteId === note.id && !q.resolved);

          return (
            <div key={note.id} className={styles.checkItem}>
              <div className={styles.checkRow}>
                <button
                  type="button"
                  className={[styles.checkbox, isChecked ? styles.checkboxChecked : ""].join(" ")}
                  onClick={() => !isChecked && onCheck(note.id)}
                  disabled={isChecked || !!compareLoading}
                  title={isChecked ? "반영 완료" : "이 피드백을 반영했으면 체크하세요"}
                >
                  {isChecked ? "✓" : ""}
                </button>
                <div className={styles.checkContent}>
                  <div className={styles.anchorQuote}>{note.anchorText}</div>
                  <div className={styles.teacherFeedback}>{note.teacherText}</div>
                </div>
              </div>

              {/* 비교 점검 질문 표시 */}
              {isCompareLoading ? (
                <div className={styles.compareBox}>
                  <div className={styles.loadingText}>수정 전후 비교 질문을 생성하고 있습니다...</div>
                </div>
              ) : null}

              {relatedQuestion ? (
                <div className={styles.compareBox}>
                  <div className={styles.compareLabel}>수정 비교 점검</div>
                  <div className={styles.compareContent}>{relatedQuestion.text}</div>
                  <button
                    type="button"
                    className={styles.resolveBtn}
                    onClick={() => onResolveQuestion(relatedQuestion.id)}
                  >
                    해결 완료 — 다음으로
                  </button>
                </div>
              ) : compareResult && !relatedQuestion ? (
                <div className={styles.compareBox}>
                  <div className={styles.resolvedBadge}>해결됨</div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
