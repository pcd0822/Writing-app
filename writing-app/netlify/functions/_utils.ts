import type { HandlerEvent } from "@netlify/functions";
import { z } from "zod";

export function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export function handleOptions() {
  return {
    statusCode: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
    body: "",
  };
}

export function parseJsonBody<T extends z.ZodTypeAny>(event: HandlerEvent, schema: T) {
  const raw = event.body || "";
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false as const, error: "JSON 파싱 실패" };
  }
  const v = schema.safeParse(parsed);
  if (!v.success) return { ok: false as const, error: v.error.flatten() };
  return { ok: true as const, data: v.data as z.infer<T> };
}

