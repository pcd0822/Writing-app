import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { GoogleGenerativeAI } from "@google/generative-ai";

const HistoryItemSchema = z.object({
  role: z.string(),
  parts: z.array(z.object({ text: z.string() })),
});

const BodySchema = z.object({
  prompt: z.string().min(1),
  /** 시스템 인스트럭션 (writingTutorPrompt에서 생성) */
  systemInstruction: z.string().optional(),
  /** 대화 이력 (Gemini 형식) */
  history: z.array(HistoryItemSchema).optional(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(500, { error: "Missing env: GEMINI_API_KEY" });

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName =
      process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";

    const { prompt, systemInstruction, history } = parsed.data;

    if (systemInstruction && history) {
      // 채팅 모드: systemInstruction + history + currentMessage
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
      });
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(prompt);
      const text = result.response.text();
      return json(200, { text });
    }

    // 단순 프롬프트 모드 (기존 호환)
    const modelOpts: { model: string; systemInstruction?: string } = { model: modelName };
    if (systemInstruction) {
      modelOpts.systemInstruction = systemInstruction;
    }
    const model = genAI.getGenerativeModel(modelOpts);
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return json(200, { text });
  } catch (e) {
    return json(500, { error: (e as Error).message || "gemini error" });
  }
};
