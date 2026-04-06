import type { Attachment, TeacherDb } from "./types";

/** 드라이브에 올린 첨부는 파일 본문(dataUrl)을 DB에 두지 않음 — 주소만 유지 */
export function stripDataUrlIfDriveAttachment(att: Attachment): Attachment {
  if (!att.driveFileId) return att;
  const { dataUrl: _, ...rest } = att;
  return rest;
}

export function normalizeDriveAttachmentsInDb(db: TeacherDb): TeacherDb {
  return {
    ...db,
    assignments: db.assignments.map((a) => ({
      ...a,
      attachments: (a.attachments ?? []).map(stripDataUrlIfDriveAttachment),
    })),
  };
}

/**
 * 시트(meta 셀)에 쓰는 DB: 드라이브 첨부는 주소 필드만, 그 외는 dataUrl 제외(셀 한도)
 */
export function prepareDbForSheetPush(db: TeacherDb): TeacherDb {
  return {
    ...db,
    assignments: db.assignments.map((a) => ({
      ...a,
      attachments: (a.attachments ?? []).map((att) => {
        if (att.driveFileId) {
          return {
            name: att.name,
            type: att.type,
            size: att.size,
            driveFileId: att.driveFileId,
            driveDownloadUrl: att.driveDownloadUrl,
          };
        }
        const { dataUrl: _d, ...rest } = att;
        return rest;
      }),
    })),
  };
}
