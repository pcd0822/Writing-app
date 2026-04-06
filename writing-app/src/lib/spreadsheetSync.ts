import { prepareDbForSheetPush } from "./attachments";
import { callFunction } from "./netlifyClient";
import type { TeacherDb } from "./types";

const ACTIVE_SID_KEY = "writing-app:activeSpreadsheetId";

export function setActiveSpreadsheetId(spreadsheetId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_SID_KEY, spreadsheetId);
}

export function getActiveSpreadsheetId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_SID_KEY);
}

export async function pullDbFromSheet(spreadsheetId: string) {
  const res = await callFunction<{ db: unknown | null }>("db-get", { spreadsheetId });
  return res.db;
}

export async function pushDbToSheet(spreadsheetId: string, db: unknown) {
  const payload = prepareDbForSheetPush(db as TeacherDb);
  await callFunction<{ ok: true }>("db-set", { spreadsheetId, db: payload });
}

