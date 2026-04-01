import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";
import { GoogleGenerativeAI } from "@google/generative-ai";

const BodySchema = z.object({
  prompt: z.string().min(1),
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
      process.env.GEMINI_MODEL?.trim() || "gemini-3.1-pro-preview";
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(parsed.data.prompt);
    const text = result.response.text();
    return json(200, { text });
  } catch (e) {
    return json(500, { error: (e as Error).message || "gemini error" });
  }
};

