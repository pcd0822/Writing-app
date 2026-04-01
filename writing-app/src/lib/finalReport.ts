import type { AiLog, FeedbackNote, Score, Submission } from "./types";

export type FinalReportSnapshotV1 = {
  version: 1;
  generatedAt: number;
  totalScore: number;
  partialScores: { outline: number | null; draft: number | null; revise: number | null };
  questionStats: {
    /** 키워드 빈도(간단) */
    wordFrequency: { word: string; count: number }[];
    /** 질문 문장 수(학생 로그) */
    studentQuestionCount: number;
    /** 수준 추정 (짧음/중간/김) */
    levelBuckets: { low: number; mid: number; high: number };
  };
  narrativeSummary: string;
  teacherSummary: string;
  feedbackMemos: {
    id: string;
    stage: string;
    anchorText: string;
    teacherText: string;
    resolvedAt: number | null;
  }[];
};

function tokenizeQuestions(logs: AiLog[]): string[] {
  const out: string[] = [];
  for (const l of logs) {
    if (l.role !== "student") continue;
    const t = l.text.trim();
    if (t.length < 2) continue;
    const parts = t.split(/[?\n]/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (p.length < 4) continue;
      out.push(p.slice(0, 80));
    }
  }
  return out;
}

function wordFreq(texts: string[], top = 8) {
  const m = new Map<string, number>();
  const stop = new Set(["이", "가", "을", "를", "은", "는", "에", "의", "와", "과", "도", "로", "으로", "그", "것", "수", "할", "해", "요", "까요"]);
  for (const t of texts) {
    for (const w of t.split(/\s+/)) {
      const k = w.replace(/[^0-9a-zA-Z가-힣]/g, "");
      if (k.length < 2 || stop.has(k)) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([word, count]) => ({ word, count }));
}

function lengthBuckets(logs: AiLog[]) {
  let low = 0,
    mid = 0,
    high = 0;
  for (const l of logs) {
    if (l.role !== "student") continue;
    const n = l.text.length;
    if (n < 40) low += 1;
    else if (n < 120) mid += 1;
    else high += 1;
  }
  return { low, mid, high };
}

export function buildFinalReportSnapshot(params: {
  submission: Submission;
  aiLogs: AiLog[];
  notes: FeedbackNote[];
  score: Score | null;
  partial: { outline: number | null; draft: number | null; revise: number | null };
}): FinalReportSnapshotV1 {
  const logs = params.aiLogs.filter((l) => l.submissionId === params.submission.id);
  const studentQs = tokenizeQuestions(logs);
  const wf = wordFreq(studentQs);
  const buckets = lengthBuckets(logs);
  const o = params.partial.outline ?? 0;
  const d = params.partial.draft ?? 0;
  const r = params.partial.revise ?? 0;
  const sumPart = o + d + r;
  const total = sumPart > 0 ? sumPart : (params.score?.score ?? 0);

  const memoLines = params.notes
    .filter((n) => !n.resolvedAt)
    .map((n) => `- [${n.stage}] ${n.teacherText.slice(0, 120)}${n.teacherText.length > 120 ? "…" : ""}`);

  const narrativeSummary = [
    `학생 질문 로그 기준 키워드 상위: ${wf.slice(0, 5).map((x) => `${x.word}(${x.count})`).join(", ") || "—"}.`,
    `질문 길이 분포(짧음/중간/김): ${buckets.low} / ${buckets.mid} / ${buckets.high}.`,
    memoLines.length ? `미해결 피드백 요약:\n${memoLines.slice(0, 6).join("\n")}` : "미해결 피드백 없음.",
  ].join("\n");

  return {
    version: 1,
    generatedAt: Date.now(),
    totalScore: total,
    partialScores: params.partial,
    questionStats: {
      wordFrequency: wf,
      studentQuestionCount: logs.filter((l) => l.role === "student").length,
      levelBuckets: buckets,
    },
    narrativeSummary,
    teacherSummary: params.score?.teacherSummary || "",
    feedbackMemos: params.notes.map((n) => ({
      id: n.id,
      stage: n.stage,
      anchorText: n.anchorText,
      teacherText: n.teacherText,
      resolvedAt: n.resolvedAt,
    })),
  };
}

export function parseFinalReportSnapshot(raw: string | undefined | null): FinalReportSnapshotV1 | null {
  if (!raw || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as FinalReportSnapshotV1;
    if (j && j.version === 1) return j;
    return null;
  } catch {
    return null;
  }
}
