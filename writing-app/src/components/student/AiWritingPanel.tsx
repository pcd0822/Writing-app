"use client";

import { useState } from "react";
import { nanoid } from "nanoid";
import styles from "./AiWritingPanel.module.css";
import { callFunction } from "@/lib/netlifyClient";
import { addAiInteraction, updateAiInteractionAction } from "@/lib/localDb";
import { AI_PROMPTS } from "@/lib/aiWritingPrompts";
import type { AiInteraction, Grasp, Stage } from "@/lib/types";

type ToolType = "continue" | "rephrase" | "argument" | "audience" | "structure";

const TOOL_LABELS: Record<ToolType, string> = {
  continue: "이어서 써줘",
  rephrase: "다른 표현으로",
  argument: "논거 보강해줘",
  audience: "독자 관점에서 봐줘",
  structure: "구조 점검",
};

type ResponseItem = {
  interactionId: string;
  type: ToolType;
  response: string;
  action: AiInteraction["action"];
};

type Props = {
  submissionId: string;
  stage: Stage;
  selectedText: string;
  currentText: string;
  outlineText: string;
  grasp: Grasp | null;
  spreadsheetId?: string;
  onBump: () => void;
};

export function AiWritingPanel({
  submissionId,
  stage,
  selectedText,
  currentText,
  outlineText,
  grasp,
  spreadsheetId,
  onBump,
}: Props) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responses, setResponses] = useState<ResponseItem[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType | null>(null);

  const sheetOpts = { spreadsheetId: spreadsheetId?.trim() || undefined };

  const stageToStep = (s: Stage): number => {
    if (s === "outline") return 1;
    if (s === "draft") return 2;
    return 3;
  };

  async function runTool(tool: ToolType) {
    setError(null);
    setActiveTool(tool);
    setIsLoading(true);

    let prompt = "";
    switch (tool) {
      case "continue":
        if (!selectedText.trim()) {
          setError("텍스트를 드래그로 선택한 후 사용하세요.");
          setIsLoading(false);
          return;
        }
        prompt = AI_PROMPTS.continueWriting(grasp, currentText, selectedText);
        break;
      case "rephrase":
        if (!selectedText.trim()) {
          setError("변환할 문장/문단을 먼저 선택하세요.");
          setIsLoading(false);
          return;
        }
        prompt = AI_PROMPTS.alternativeExpression(selectedText, grasp);
        break;
      case "argument":
        if (!selectedText.trim()) {
          setError("보강할 주장 부분을 먼저 선택하세요.");
          setIsLoading(false);
          return;
        }
        prompt = AI_PROMPTS.strengthenArgument(selectedText, grasp);
        break;
      case "audience":
        prompt = AI_PROMPTS.audiencePerspective(currentText, grasp);
        break;
      case "structure":
        prompt = AI_PROMPTS.structureCheck(currentText, grasp, outlineText);
        break;
    }

    try {
      const res = await callFunction<{ text: string }>("gemini-chat", { prompt });
      const responseText = (res.text || "").trim() || "응답을 생성하지 못했습니다.";

      const interactionId = nanoid(12);
      const interaction: AiInteraction = {
        id: interactionId,
        submissionId,
        timestamp: Date.now(),
        step: stageToStep(stage),
        type: tool,
        prompt: prompt.slice(0, 500),
        response: responseText.slice(0, 2000),
        action: "rejected",
      };
      addAiInteraction(interaction, sheetOpts);

      setResponses((prev) => [
        { interactionId, type: tool, response: responseText, action: "rejected" },
        ...prev,
      ]);
      onBump();
    } catch (e) {
      setError((e as Error).message || "AI 요청 실패");
    } finally {
      setIsLoading(false);
      setActiveTool(null);
    }
  }

  function handleAction(interactionId: string, action: AiInteraction["action"]) {
    updateAiInteractionAction(interactionId, action, sheetOpts);
    setResponses((prev) =>
      prev.map((r) =>
        r.interactionId === interactionId ? { ...r, action } : r,
      ),
    );
    onBump();
  }

  const needsSelection = (tool: ToolType) =>
    tool === "continue" || tool === "rephrase" || tool === "argument";

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.title}>AI 협력 글쓰기</div>
        <div className={styles.sub}>
          텍스트를 선택하거나 도구를 눌러 AI의 도움을 받으세요.
        </div>
      </div>

      <div className={styles.tools}>
        {(Object.keys(TOOL_LABELS) as ToolType[]).map((tool) => (
          <button
            key={tool}
            type="button"
            className={[
              styles.toolBtn,
              activeTool === tool ? styles.toolBtnActive : "",
            ].join(" ")}
            onClick={() => runTool(tool)}
            disabled={isLoading}
            title={
              needsSelection(tool) && !selectedText.trim()
                ? "먼저 텍스트를 선택하세요"
                : undefined
            }
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {selectedText.trim() ? (
          <div className={styles.selectedRef}>
            선택됨: {selectedText.length > 150 ? `${selectedText.slice(0, 150)}...` : selectedText}
          </div>
        ) : null}

        {isLoading ? (
          <div className={styles.loading}>AI가 분석하고 있습니다...</div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}

        {responses.length === 0 && !isLoading ? (
          <div className={styles.empty}>
            위 도구 버튼을 눌러 AI의 도움을 받아보세요.
            "이어서 써줘", "다른 표현으로", "논거 보강해줘"는 먼저 텍스트를 드래그로 선택해야 합니다.
          </div>
        ) : null}

        {responses.map((r) => (
          <div key={r.interactionId} className={styles.responseCard}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <span className={styles.historyType}>{TOOL_LABELS[r.type]}</span>
              {r.action !== "rejected" ? (
                <span
                  className={[
                    styles.historyAction,
                    r.action === "accepted" ? styles.actionAccepted : styles.actionModified,
                  ].join(" ")}
                >
                  {r.action === "accepted" ? "수용" : "수정 반영"}
                </span>
              ) : null}
            </div>
            <div className={styles.responseText}>{r.response}</div>
            {r.action === "rejected" ? (
              <div className={styles.responseActions}>
                <button
                  type="button"
                  className={styles.acceptBtn}
                  onClick={() => handleAction(r.interactionId, "accepted")}
                >
                  수용
                </button>
                <button
                  type="button"
                  className={styles.modifyBtn}
                  onClick={() => handleAction(r.interactionId, "modified")}
                >
                  수정 반영
                </button>
                <button
                  type="button"
                  className={styles.rejectBtn}
                  onClick={() => handleAction(r.interactionId, "rejected")}
                >
                  거부
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
