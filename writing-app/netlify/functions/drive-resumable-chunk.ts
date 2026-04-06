import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { getDriveClient } from "./_googleAuth";
import { handleOptions, json, parseJsonBody } from "./_utils";

const BodySchema = z.object({
  sessionUrl: z.string().min(20),
  base64Chunk: z.string().min(1),
  rangeStart: z.number().int().nonnegative(),
  rangeEnd: z.number().int().nonnegative(),
  totalSize: z.number().int().positive(),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
});

/** Netlify 요청 한도 안에서 한 번에 보낼 디코드 크기 상한 */
const MAX_CHUNK_DECODED = 4 * 1024 * 1024;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { sessionUrl, base64Chunk, rangeStart, rangeEnd, totalSize, fileName, mimeType } =
    parsed.data;

  if (rangeEnd < rangeStart || rangeStart >= totalSize) {
    return json(400, { error: "잘못된 Content-Range입니다." });
  }
  if (rangeEnd >= totalSize) {
    return json(400, { error: "rangeEnd는 totalSize 미만이어야 합니다." });
  }

  try {
    const buf = Buffer.from(base64Chunk, "base64");
    if (buf.length > MAX_CHUNK_DECODED) {
      return json(400, { error: `청크는 디코드 기준 ${MAX_CHUNK_DECODED / 1024 / 1024}MB 이하로 나눠 주세요.` });
    }
    const expectedLen = rangeEnd - rangeStart + 1;
    if (buf.length !== expectedLen) {
      return json(400, {
        error: `청크 바이트 길이 불일치: 기대 ${expectedLen}, 실제 ${buf.length}`,
      });
    }

    const putRes = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(buf.length),
        "Content-Range": `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
      },
      body: buf,
    });

    if (putRes.status === 308) {
      return json(200, { ok: true as const, done: false as const });
    }

    if (!putRes.ok) {
      const errText = await putRes.text();
      return json(502, {
        error: `청크 업로드 실패: ${putRes.status} ${errText.slice(0, 400)}`,
      });
    }

    const text = await putRes.text();
    let fileJson: { id?: string; name?: string; mimeType?: string; size?: string };
    try {
      fileJson = text ? (JSON.parse(text) as typeof fileJson) : {};
    } catch {
      return json(502, { error: "드라이브 응답 JSON 파싱 실패" });
    }

    const fileId = fileJson.id;
    if (!fileId) {
      return json(502, { error: "업로드 완료 응답에 파일 ID가 없습니다." });
    }

    const drive = getDriveClient();
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });

    const driveDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    return json(200, {
      ok: true as const,
      done: true as const,
      attachment: {
        name: fileJson.name || fileName,
        type: mimeType || fileJson.mimeType || undefined,
        size: Number(fileJson.size || totalSize),
        driveFileId: fileId,
        driveDownloadUrl,
      },
    });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-resumable-chunk failed" });
  }
};
