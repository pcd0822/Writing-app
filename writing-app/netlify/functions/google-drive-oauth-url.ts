import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  redirectUri: z.string().url(),
});

/**
 * 교사 브라우저 origin에 맞는 redirect_uri로 Google OAuth URL 생성
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { redirectUri } = parsed.data;
  if (!redirectUri.includes("/teacher/drive-callback")) {
    return json(400, { error: "redirectUri는 /teacher/drive-callback 로 끝나야 합니다." });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return json(500, { error: "GOOGLE_OAUTH_CLIENT_ID 미설정 (Netlify 환경 변수)" });
  }

  /* 폴더 ID로 업로드하려면 drive.file만으로는 부족한 경우가 있어 drive 권한 사용 */
  const scope = encodeURIComponent("https://www.googleapis.com/auth/drive");
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=consent`;

  return json(200, { ok: true as const, url });
};
