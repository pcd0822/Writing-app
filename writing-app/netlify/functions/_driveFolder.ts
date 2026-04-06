import { getDriveClient } from "./_googleAuth";

type DriveClient = ReturnType<typeof getDriveClient>;

export async function ensureAssignmentFolder(
  drive: DriveClient,
  rootId: string,
  assignmentId: string,
): Promise<string> {
  const escaped = assignmentId.replace(/'/g, "\\'");
  const q = `name='${escaped}' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = res.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: {
      name: assignmentId,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("과제 폴더를 만들지 못했습니다.");
  return id;
}
