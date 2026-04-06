import type { Handler } from "@netlify/functions";
import { Readable } from "node:stream";
import { z } from "zod";
import { quotaHintFromGoogleError } from "./_driveQuotaMessage";
import { getDriveClient } from "./_googleAuth";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  folderId: z.string().min(10),
});

/**
 * 교사가 소유·공유한 폴더인지 확인하고, 서비스 계정으로 실제 파일 생성이 되는지 검사합니다.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { folderId } = parsed.data;

  try {
    const drive = getDriveClient();
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
        error:
          "이 폴더에 편집할 수 없습니다. 서비스 계정 이메일을 폴더에 ‘편집자’로 공유했는지 확인하세요.",
      });
    }

    const probeName = `.writing-app-write-test-${Date.now()}.txt`;
    let probeId: string | null = null;
    try {
      const probe = await drive.files.create(
        {
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
        },
      );
      probeId = probe.data.id || null;
    } catch (writeErr) {
      const raw = String((writeErr as Error).message || writeErr);
      return json(403, {
        error:
          `이 폴더에 파일을 만들 수 없습니다. ${raw.slice(0, 200)}` +
          quotaHintFromGoogleError(raw),
      });
    }

    if (probeId) {
      try {
        await drive.files.delete({ fileId: probeId, supportsAllDrives: true });
      } catch {
        /* 삭제 실패는 무시 — 테스트 파일이 남을 수 있음 */
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
        ? " 폴더 ID가 잘못되었거나, 서비스 계정에 폴더가 공유되지 않았을 수 있습니다."
        : "";
    return json(500, {
      error: `폴더를 확인할 수 없습니다.${hint} ${msg.slice(0, 200)}`,
    });
  }
};
