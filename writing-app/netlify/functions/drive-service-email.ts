import type { Handler } from "@netlify/functions";
import { getServiceAccount } from "./_googleAuth";
import { handleOptions, json } from "./_utils";

/** 클라이언트에 서비스 계정 이메일만 노출(교사가 폴더 공유 시 사용) */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const { clientEmail } = getServiceAccount();
    return json(200, { ok: true as const, clientEmail });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-service-email failed" });
  }
};
