import type { Handler } from "@netlify/functions";
import { Readable } from "node:stream";
import { z } from "zod";
import { getDriveClient } from "./_googleAuth";
import { ensureAssignmentFolder } from "./_driveFolder";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  driveRootFolderId: z.string().min(10),
  assignmentId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  dataBase64: z.string().min(1),
});

/** 단일 요청 업로드 — Netlify 본문 한도 내(재개 업로드는 drive-resumable-*) */
const MAX_BYTES = 4 * 1024 * 1024;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { driveRootFolderId, assignmentId, fileName, mimeType, dataBase64 } = parsed.data;

  try {
    const buf = Buffer.from(dataBase64, "base64");
    if (buf.length > MAX_BYTES) {
      return json(400, { error: `파일 한도 ${MAX_BYTES / 1024 / 1024}MB 이하만 업로드할 수 있습니다.` });
    }

    const drive = getDriveClient();
    const assignmentFolderId = await ensureAssignmentFolder(drive, driveRootFolderId, assignmentId);

    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [assignmentFolderId],
      },
      media: {
        mimeType: mimeType || "application/octet-stream",
        body: Readable.from(buf),
      },
      fields: "id,name,size,mimeType",
    });

    const fileId = created.data.id;
    if (!fileId) return json(500, { error: "파일 업로드 후 ID를 받지 못했습니다." });

    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    const driveDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    return json(200, {
      ok: true as const,
      attachment: {
        name: fileName,
        type: mimeType || created.data.mimeType || undefined,
        size: buf.length,
        driveFileId: fileId,
        driveDownloadUrl,
      },
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-upload-file failed" });
  }
};
