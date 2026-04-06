const KEY = "writing-app:teacherSettings:v1";

export type TeacherSettings = {
  spreadsheetId: string;
  /** 교사 드라이브 폴더 ID(서비스 계정에 편집자 공유됨) */
  driveFolderId?: string;
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

