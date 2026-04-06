import type { Handler } from "@netlify/functions";
import { getDriveClient } from "./_googleAuth";
import { handleOptions, json } from "./_utils";

const ROOT_FOLDER_NAME = "Writing App 과제 첨부";

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const drive = getDriveClient();
    const folder = await drive.files.create({
      requestBody: {
        name: ROOT_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id,name",
    });
    const folderId = folder.data.id;
    if (!folderId) return json(500, { error: "폴더 ID를 받지 못했습니다." });
    return json(200, { ok: true as const, folderId });
  } catch (e) {
    return json(500, { error: (e as Error).message || "drive-init failed" });
  }
};
