import type { Handler } from "@netlify/functions";
import { Readable } from "node:stream";
import { z } from "zod";
import { getDriveClientFromRefreshToken } from "./_driveOAuthClient";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  folderId: z.string().min(10),
  refreshToken: z.string().min(1),
});

/**
 * 교사 OAuth 계정으로 폴더에 접근·쓰기 가능한지 확인합니다.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { folderId, refreshToken } = parsed.data;

  try {
    const drive = getDriveClientFromRefreshToken(refreshToken);
    const r = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType,capabilities",
      supportsAllDrives: true,
    });
    const data = r.data;
    if (!data.id) {
      return json(400, { error: "폴더 정보를 받지 못했습니다." });
    }
    if (data.mimeType !== "application/vnd.google-apps.folder") {
      return json(400, {
        error: "폴더 ID가 아닙니다. Google Drive에서 ‘폴더’를 만든 뒤 해당 폴더의 ID를 입력하세요.",
      });
    }
    const canEdit = data.capabilities?.canEdit;
    if (canEdit === false) {
      return json(403, {
        error: "이 폴더에 편집할 수 없습니다. 같은 Google 계정으로 만든 폴더인지 확인하세요.",
      });
    }

    const probeName = `.writing-app-write-test-${Date.now()}.txt`;
    let probeId: string | null = null;
    try {
      const probe = await drive.files.create({
        requestBody: {
          name: probeName,
          parents: [folderId],
        },
        media: {
          mimeType: "text/plain",
          body: Readable.from(Buffer.from("ok", "utf8")),
        },
        fields: "id",
        supportsAllDrives: true,
      });
      probeId = probe.data.id || null;
    } catch (writeErr) {
      const raw = String((writeErr as Error).message || writeErr);
      return json(403, {
        error: `이 폴더에 파일을 만들 수 없습니다. ${raw.slice(0, 240)}`,
      });
    }

    if (probeId) {
      try {
        await drive.files.delete({ fileId: probeId, supportsAllDrives: true });
      } catch {
        /* ignore */
      }
    }

    return json(200, {
      ok: true as const,
      folderId: data.id,
      folderName: data.name || "폴더",
    });
  } catch (e) {
    const msg = (e as Error).message || "";
    const hint =
      msg.includes("404") || msg.includes("not found")
        ? " 폴더 ID가 잘못되었거나, OAuth로 로그인한 계정과 폴더 소유 계정이 다를 수 있습니다."
        : "";
    return json(500, {
      error: `폴더를 확인할 수 없습니다.${hint} ${msg.slice(0, 200)}`,
    });
  }
};
