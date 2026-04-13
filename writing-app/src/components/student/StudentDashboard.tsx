"use client";

import { useMemo, useState } from "react";
import styles from "./StudentDashboard.module.css";
import { callFunction } from "@/lib/netlifyClient";
import type {
  AiInteraction,
  Grasp,
  StepTransition,
  Submission,
} from "@/lib/types";

const STEP_LABELS: Record<number, string> = {
  1: "개요",
  2: "초고",
  3: "고쳐쓰기",
};

const AI_TYPE_LABELS: Record<string, string> = {
  continue: "이어서 쓰기",
  rephrase: "다른 표현",
  argument: "논거 보강",
  audience: "독자 관점",
  structure: "구조 점검",
  tutor: "AI 튜터",
};

type Props = {
  submission: Submission;
  transitions: StepTransition[];
  aiInteractions: AiInteraction[];
  grasp: Grasp | null;
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  return text.split(/[.!?。]\s*/g).filter((s) => s.trim().length > 0).length;
}

function vocabularyDiversity(text: string): number {
  const words = text
    .replace(/[^가-힣a-zA-Z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return Math.round((unique.size / words.length) * 100);
}

export function StudentDashboard({
  submission,
  transitions,
  aiInteractions,
  grasp,
}: Props) {
  const [diffView, setDiffView] = useState<"outline-draft" | "draft-revise">(
    "outline-draft",
  );
  const [growthSummary, setGrowthSummary] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // ── Flow Chart data ───────────────────────────────────────────
  const edgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of transitions) {
      const key = `${t.fromStep}-${t.toStep}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [transitions]);

  const stepStatus = useMemo(() => {
    const s = submission;
    return {
      1: s.outlineApprovedAt ? "done" : s.outlineSubmittedAt ? "active" : "pending",
      2: s.draftApprovedAt ? "done" : s.draftSubmittedAt ? "active" : "pending",
      3: s.reviseApprovedAt ? "done" : s.reviseSubmittedAt ? "active" : "pending",
    } as Record<number, string>;
  }, [submission]);

  // ── Complexity metrics ────────────────────────────────────────
  const metrics = useMemo(() => {
    const texts = {
      outline: submission.outlineText || "",
      draft: submission.draftText || "",
      revise: submission.reviseText || "",
    };
    return {
      sentenceCount: {
        outline: countSentences(texts.outline),
        draft: countSentences(texts.draft),
        revise: countSentences(texts.revise),
      },
      vocabularyDiversity: {
        outline: vocabularyDiversity(texts.outline),
        draft: vocabularyDiversity(texts.draft),
        revise: vocabularyDiversity(texts.revise),
      },
      wordCount: {
        outline: countWords(texts.outline),
        draft: countWords(texts.draft),
        revise: countWords(texts.revise),
      },
    };
  }, [submission]);

  // ── AI usage stats ────────────────────────────────────────────
  const aiStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of aiInteractions) {
      counts[i.type] = (counts[i.type] || 0) + 1;
    }
    return counts;
  }, [aiInteractions]);

  // ── Timeline ──────────────────────────────────────────────────
  const timeline = useMemo(() => {
    const events: { timestamp: number; event: string }[] = [];
    for (const t of transitions) {
      const from = STEP_LABELS[t.fromStep] || `${t.fromStep}`;
      const to = STEP_LABELS[t.toStep] || `${t.toStep}`;
      const reason =
        t.reason === "initial_progress" ? "첫 진행" :
        t.reason === "revision_back" ? "되돌아감" : "재진행";
      events.push({ timestamp: t.timestamp, event: `${from} → ${to} (${reason})` });
    }
    for (const i of aiInteractions) {
      events.push({
        timestamp: i.timestamp,
        event: `AI 활용: ${AI_TYPE_LABELS[i.type] || i.type}`,
      });
    }
    return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  }, [transitions, aiInteractions]);

  async function generateGrowthSummary() {
    setIsGenerating(true);
    try {
      const prompt = [
        "학생의 작문 과정을 분석하여 사고 성장 요약을 한국어 3~4문장으로 작성해주세요.",
        "",
        `[GRASP 맥락] 목표: ${grasp?.goal || "없음"}, 독자: ${grasp?.audience || "없음"}`,
        `[개요] ${(submission.outlineText || "").slice(0, 500)}`,
        `[초고] ${(submission.draftText || "").slice(0, 500)}`,
        `[고쳐쓰기] ${(submission.reviseText || "").slice(0, 500)}`,
        `[단계 이동 횟수] ${transitions.length}회`,
        `[AI 활용 횟수] ${aiInteractions.length}회`,
        "",
        "학생의 사고가 어떻게 변화·발전했는지, 어떤 점이 강화되었는지 서술하세요.",
      ].join("\n");

      const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
      setGrowthSummary(res.text || "요약을 생성하지 못했습니다.");
    } catch {
      setGrowthSummary("성장 요약 생성 중 오류가 발생했습니다.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {/* ── 단계 이동 흐름도 ─────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>단계 이동 흐름도</div>
        <div className={styles.flowChart}>
          {[1, 2, 3].map((step, idx) => (
            <span key={step} style={{ display: "contents" }}>
              {idx > 0 ? (
                <div className={styles.flowEdge}>
                  <span className={styles.flowArrow}>→</span>
                  {edgeCounts.get(`${step - 1}-${step}`) ? (
                    <span className={styles.flowEdgeCount}>
                      {edgeCounts.get(`${step - 1}-${step}`)}회
                    </span>
                  ) : null}
                  {edgeCounts.get(`${step}-${step - 1}`) ? (
                    <>
                      <span className={styles.flowArrow}>←</span>
                      <span className={styles.flowEdgeCount}>
                        {edgeCounts.get(`${step}-${step - 1}`)}회
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
              <div
                className={[
                  styles.flowNode,
                  stepStatus[step] === "done" ? styles.flowNodeDone : "",
                  stepStatus[step] === "active" ? styles.flowNodeActive : "",
                ].join(" ")}
              >
                {STEP_LABELS[step]}
              </div>
            </span>
          ))}
        </div>
      </div>

      {/* ── 버전 비교 (Diff View) ──────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>버전 비교</div>
        <div className={styles.diffTabs}>
          <button
            type="button"
            className={[
              styles.diffTab,
              diffView === "outline-draft" ? styles.diffTabOn : "",
            ].join(" ")}
            onClick={() => setDiffView("outline-draft")}
          >
            개요 vs 초고
          </button>
          <button
            type="button"
            className={[
              styles.diffTab,
              diffView === "draft-revise" ? styles.diffTabOn : "",
            ].join(" ")}
            onClick={() => setDiffView("draft-revise")}
          >
            초고 vs 고쳐쓰기
          </button>
        </div>
        <div className={styles.diffContainer}>
          <div className={styles.diffCol}>
            <div className={styles.diffLabel}>
              {diffView === "outline-draft" ? "개요" : "초고"}
            </div>
            <div className={styles.diffText}>
              {diffView === "outline-draft"
                ? submission.outlineText || "(작성 전)"
                : submission.draftText || "(작성 전)"}
            </div>
          </div>
          <div className={styles.diffCol}>
            <div className={styles.diffLabel}>
              {diffView === "outline-draft" ? "초고" : "고쳐쓰기"}
            </div>
            <div className={styles.diffText}>
              {diffView === "outline-draft"
                ? submission.draftText || "(작성 전)"
                : submission.reviseText || "(작성 전)"}
            </div>
          </div>
        </div>
      </div>

      {/* ── 성장 지표 ────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>작문 복잡도 변화</div>
        <div className={styles.metricsGrid}>
          <div className={styles.metricCard}>
            <div className={styles.metricLabel}>문장 수</div>
            <div className={styles.metricValues}>
              {(["outline", "draft", "revise"] as const).map((s) => (
                <div key={s} className={styles.metricItem}>
                  <span className={styles.metricNum}>
                    {metrics.sentenceCount[s]}
                  </span>
                  <span className={styles.metricSub}>
                    {s === "outline" ? "개요" : s === "draft" ? "초고" : "수정"}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.metricCard}>
            <div className={styles.metricLabel}>어휘 다양성(%)</div>
            <div className={styles.metricValues}>
              {(["outline", "draft", "revise"] as const).map((s) => (
                <div key={s} className={styles.metricItem}>
                  <span className={styles.metricNum}>
                    {metrics.vocabularyDiversity[s]}
                  </span>
                  <span className={styles.metricSub}>
                    {s === "outline" ? "개요" : s === "draft" ? "초고" : "수정"}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.metricCard}>
            <div className={styles.metricLabel}>단어 수</div>
            <div className={styles.metricValues}>
              {(["outline", "draft", "revise"] as const).map((s) => (
                <div key={s} className={styles.metricItem}>
                  <span className={styles.metricNum}>
                    {metrics.wordCount[s]}
                  </span>
                  <span className={styles.metricSub}>
                    {s === "outline" ? "개요" : s === "draft" ? "초고" : "수정"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── AI 활용 패턴 ─────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>AI 활용 패턴</div>
        {Object.keys(aiStats).length === 0 ? (
          <div className={styles.dim}>AI 활용 이력이 없습니다.</div>
        ) : (
          <div className={styles.aiUsageGrid}>
            {Object.entries(aiStats).map(([type, count]) => (
              <div key={type} className={styles.aiUsageItem}>
                <span className={styles.aiUsageLabel}>
                  {AI_TYPE_LABELS[type] || type}
                </span>
                <span className={styles.aiUsageCount}>{count}회</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 사고 성장 요약 ───────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>사고 성장 요약</div>
        {growthSummary ? (
          <div className={styles.growthCard}>
            <div className={styles.growthText}>{growthSummary}</div>
          </div>
        ) : (
          <>
            <div className={styles.dim}>
              AI가 작문 과정을 분석하여 사고 성장 서사를 생성합니다.
            </div>
            <button
              type="button"
              className={styles.generateBtn}
              onClick={generateGrowthSummary}
              disabled={isGenerating}
              style={{ marginTop: 8 }}
            >
              {isGenerating ? "생성 중..." : "성장 요약 생성"}
            </button>
          </>
        )}
      </div>

      {/* ── 타임라인 ─────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>활동 타임라인</div>
        {timeline.length === 0 ? (
          <div className={styles.dim}>아직 활동 기록이 없습니다.</div>
        ) : (
          <div className={styles.timeline}>
            {timeline.map((t, i) => (
              <div key={i} className={styles.timelineItem}>
                <span className={styles.timelineTime}>
                  {new Date(t.timestamp).toLocaleString("ko-KR", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className={styles.timelineEvent}>{t.event}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
