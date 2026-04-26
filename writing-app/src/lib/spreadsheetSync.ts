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

export type PullDiag = {
  metaCellLen: number;
  metaParsed: boolean;
  tabularRowCounts: {
    classes: number;
    students: number;
    assignments: number;
    submissions: number;
  };
};

export type PullResult = {
  db: unknown | null;
  diag?: PullDiag | null;
};

export async function pullDbFromSheet(spreadsheetId: string): Promise<unknown | null> {
  const res = await callFunction<PullResult>("db-get", { spreadsheetId });
  return res.db;
}

export async function pullDbFromSheetWithDiag(spreadsheetId: string): Promise<PullResult> {
  return await callFunction<PullResult>("db-get", { spreadsheetId });
}

export async function pushDbToSheet(spreadsheetId: string, db: unknown) {
  const payload = prepareDbForSheetPush(db as TeacherDb);
  await callFunction<{ ok: true }>("db-set", { spreadsheetId, db: payload });
}

