const KEY = "writing-app:teacherSettings:v1";

export type TeacherSettings = {
  spreadsheetId: string;
  /** 과제 첨부를 올릴 Google Drive 폴더 ID(교사 본인 계정의 폴더) */
  driveFolderId?: string;
  /** Google OAuth — Drive API 업로드용(교사 계정 용량으로 저장) */
  driveOAuthRefreshToken?: string;
};

export function loadTeacherSettings(): TeacherSettings | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TeacherSettings;
    if (!parsed?.spreadsheetId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTeacherSettings(s: TeacherSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
}

