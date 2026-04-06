import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { driveStorageFileName } from "./_driveUploadNames";
import { getAccessTokenFromRefresh } from "./_driveOAuthClient";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  driveRootFolderId: z.string().min(10),
  assignmentId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  totalSize: z.number().int().positive(),
  refreshToken: z.string().min(1),
});

const MAX_TOTAL = 10 * 1024 * 1024;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { driveRootFolderId, assignmentId, fileName, mimeType, totalSize, refreshToken } =
    parsed.data;
  if (totalSize > MAX_TOTAL) {
    return json(400, { error: `파일은 최대 ${MAX_TOTAL / 1024 / 1024}MB까지 업로드할 수 있습니다.` });
  }

  try {
    const token = await getAccessTokenFromRefresh(refreshToken);
    const mime = mimeType || "application/octet-stream";
    const storageName = driveStorageFileName(assignmentId, fileName);

    const initRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(totalSize),
          "X-Upload-Content-Type": mime,
        },
        body: JSON.stringify({
          name: storageName,
          parents: [driveRootFolderId],
        }),
      },
    );

    if (!initRes.ok) {
      const errText = await initRes.text();
      return json(502, {
        error: `드라이브 업로드 세션 실패: ${initRes.status} ${errText.slice(0, 400)}`,
      });
    }

    const sessionUrl =
      initRes.headers.get("location") || initRes.headers.get("Location");
    if (!sessionUrl) {
      return json(502, { error: "드라이브가 업로드 URL(Location)을 반환하지 않았습니다." });
    }

    return json(200, { ok: true as const, sessionUrl });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-resumable-init failed" });
  }
};
