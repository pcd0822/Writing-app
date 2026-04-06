import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { getDriveClient } from "./_googleAuth";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  driveFileId: z.string().min(10),
});

const MAX_BYTES = 5 * 1024 * 1024;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { driveFileId } = parsed.data;

  try {
    const drive = getDriveClient();
    const meta = await drive.files.get({
      fileId: driveFileId,
      fields: "mimeType,size",
    });
    const size = Number(meta.data.size || 0);
    if (size > MAX_BYTES) {
      return json(400, { error: "파일이 너무 커서 이 경로로 내려받을 수 없습니다. 교사에게 문의하세요." });
    }

    const res = await drive.files.get(
      { fileId: driveFileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const ab = res.data as ArrayBuffer;
    if (ab.byteLength > MAX_BYTES) {
      return json(400, { error: "파일이 너무 커서 이 경로로 내려받을 수 없습니다." });
    }

    const dataBase64 = Buffer.from(ab).toString("base64");
    const mimeType =
      (typeof res.headers["content-type"] === "string" && res.headers["content-type"]) ||
      meta.data.mimeType ||
      "application/octet-stream";

    return json(200, {
      ok: true as const,
      mimeType,
      dataBase64,
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-file-download failed" });
  }
};
