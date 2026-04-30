import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";

/**
 * 502를 좁히기 위한 가벼운 진단 함수.
 *  - 환경변수 존재/길이 (값은 노출하지 않음)
 *  - googleapis 동적 import 성공 여부 (패키지 번들 문제 격리)
 *  - 서비스 계정 토큰 발급 여부 (auth 문제 격리)
 *  - (선택) 입력된 spreadsheetId에 대한 spreadsheets.get 성공 여부
 *
 * 각 단계마다 실패하면 즉시 결과를 200으로 반환해서 사용자가 어디까지 동작하는지
 * 한눈에 볼 수 있게 한다. 함수 자체가 죽어 502가 나면 그 자리에서 끊어지므로
 * "이 함수 호출 자체가 502인지" vs "step N에서 실패하는지"를 구분할 수 있다.
 */

const BodySchema = z.object({
  spreadsheetId: z.string().optional(),
});

type Step = { name: string; ok: boolean; ms: number; detail?: string };

function envSummary() {
  const keys = [
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SA_CLIENT_EMAIL",
    "GOOGLE_SA_PRIVATE_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ];
  const out: Record<string, { present: boolean; length: number }> = {};
  for (const k of keys) {
    const v = process.env[k];
    out[k] = { present: !!v, length: v ? v.length : 0 };
  }
  return out;
}

async function timeStep<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ step: Step; value?: T }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { step: { name, ok: true, ms: Date.now() - t0 }, value };
  } catch (e) {
    const err = e as Error;
    return {
      step: {
        name,
        ok: false,
        ms: Date.now() - t0,
        detail: err.message || String(e),
      },
    };
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const body =
    event.httpMethod === "POST"
      ? parseJsonBody(event, BodySchema)
      : ({ ok: true as const, data: {} as z.infer<typeof BodySchema> });
  if (!("ok" in body) || !body.ok) {
    return json(400, { error: "JSON 파싱 실패" });
  }
  const spreadsheetId = body.data.spreadsheetId;

  const env = envSummary();
  const steps: Step[] = [];

  // Step 1: googleapis import
  const importRes = await timeStep("import googleapis", async () => {
    const mod = await import("googleapis");
    return { ok: !!mod.google };
  });
  steps.push(importRes.step);
  if (!importRes.step.ok) {
    return json(200, { env, steps, conclusion: "googleapis 모듈 로드 실패" });
  }

  // Step 2: service account credentials parse
  const credRes = await timeStep("read service account env", async () => {
    const j = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (j) {
      const parsed = JSON.parse(j);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error("JSON에 client_email/private_key 없음");
      }
      return { source: "JSON", clientEmailSuffix: String(parsed.client_email).slice(-20) };
    }
    const email = process.env.GOOGLE_SA_CLIENT_EMAIL;
    const key = process.env.GOOGLE_SA_PRIVATE_KEY;
    if (!email || !key) throw new Error("환경변수 미설정");
    return { source: "split", clientEmailSuffix: email.slice(-20) };
  });
  steps.push(credRes.step);
  if (!credRes.step.ok) {
    return json(200, { env, steps, conclusion: "서비스 계정 환경변수 문제" });
  }

  // Step 3: JWT 토큰 발급
  const tokenRes = await timeStep("get access token", async () => {
    const { getGoogleAccessToken } = await import("./_googleAuth");
    const t = await getGoogleAccessToken();
    return { hasToken: !!t, length: t.length };
  });
  steps.push(tokenRes.step);
  if (!tokenRes.step.ok) {
    return json(200, { env, steps, conclusion: "Google 액세스 토큰 발급 실패" });
  }

  // Step 4: (옵션) 시트 메타 접근
  if (spreadsheetId) {
    const metaRes = await timeStep("spreadsheets.get", async () => {
      const { getSheetsClient } = await import("./_sheets");
      const sheets = getSheetsClient();
      const meta = await sheets.spreadsheets.get(
        { spreadsheetId, fields: "properties.title,sheets.properties.title" },
        { timeout: 8000 },
      );
      const titles = (meta.data.sheets || [])
        .map((s) => s.properties?.title)
        .filter(Boolean) as string[];
      return {
        title: meta.data.properties?.title,
        sheetCount: titles.length,
        sampleTitles: titles.slice(0, 6),
      };
    });
    steps.push(metaRes.step);
    if (!metaRes.step.ok) {
      return json(200, {
        env,
        steps,
        conclusion:
          "시트 접근 실패 — 서비스 계정 이메일에 시트가 공유되지 않았거나 ID가 잘못됨.",
      });
    }
  }

  return json(200, {
    env,
    steps,
    conclusion: "모든 단계 정상. 502가 계속 난다면 다른 함수의 cold-start/timeout을 의심.",
  });
};
