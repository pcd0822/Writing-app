import { callFunction } from "./netlifyClient";
import type { Attachment } from "./types";

export async function uploadFileToDriveAssignment(input: {
  driveRootFolderId: string;
  assignmentId: string;
  fileName: string;
  mimeType?: string;
  dataBase64: string;
}): Promise<Attachment> {
  const res = await callFunction<{
    ok: true;
    attachment: Attachment;
  }>("drive-upload-file", input);
  return res.attachment;
}
