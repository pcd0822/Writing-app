import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url(),
});

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { code, redirectUri } = parsed.data;
  if (!redirectUri.includes("/teacher/drive-callback")) {
    return json(400, { error: "redirectUri가 올바르지 않습니다." });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json(500, { error: "GOOGLE_OAUTH_CLIENT_ID / SECRET 미설정" });
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const data = (await tokenRes.json()) as {
      refresh_token?: string;
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok) {
      return json(400, {
        error: data.error_description || data.error || `토큰 교환 실패: ${tokenRes.status}`,
      });
    }

    if (!data.refresh_token) {
      return json(400, {
        error:
          "refresh_token이 없습니다. Google 계정에서 앱 접근을 한 번 허용(동의 화면)했는지 확인하고, 다시 연결해 보세요. (이미 허용한 경우 계정의 ‘앱에 연결된 Google 계정’에서 앱을 제거한 뒤 재시도)",
      });
    }

    return json(200, {
      ok: true as const,
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "google-drive-oauth-token failed" });
  }
};
