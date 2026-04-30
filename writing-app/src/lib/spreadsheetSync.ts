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

/**
 * 빠르게 연속되는 저장(키 입력, 자동 저장 등)을 묶어 한 번만 푸시한다.
 * - 같은 spreadsheetId 안의 여러 호출은 마지막 db만 살아남는다(latest-wins).
 * - 진행 중인 push가 있으면 그것이 끝난 뒤에 다음 push가 시작되어 동시 호출을 막는다.
 *   → 502 빈도와 두 디바이스 간 race 조건을 동시에 줄여준다.
 */
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushPending = new Map<string, unknown>();
const pushInflight = new Map<string, Promise<void>>();

const COALESCE_DELAY_MS = 800;

export function pushDbToSheetCoalesced(spreadsheetId: string, db: unknown) {
  pushPending.set(spreadsheetId, db);
  const existing = pushTimers.get(spreadsheetId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pushTimers.delete(spreadsheetId);
    void runPendingPush(spreadsheetId);
  }, COALESCE_DELAY_MS);
  pushTimers.set(spreadsheetId, timer);
}

async function runPendingPush(spreadsheetId: string) {
  const inflight = pushInflight.get(spreadsheetId);
  if (inflight) {
    // 이미 진행 중인 push가 있다면, 그것이 끝난 뒤에 다시 한 번 시도해서
    // 그 사이 누적된 최신 db를 보낸다.
    try {
      await inflight;
    } catch {
      /* ignore — 이전 실패와 별개로 최신 데이터로 재시도 */
    }
  }
  const latest = pushPending.get(spreadsheetId);
  if (latest === undefined) return;
  pushPending.delete(spreadsheetId);

  const promise = pushDbToSheet(spreadsheetId, latest)
    .catch((err) => {
      console.error("[Writing app] coalesced pushDbToSheet failed:", err);
    })
    .finally(() => {
      if (pushInflight.get(spreadsheetId) === promise) {
        pushInflight.delete(spreadsheetId);
      }
      // 푸시 도중 새 변경이 또 들어왔다면 다시 한 번 흘려보낸다.
      if (pushPending.has(spreadsheetId)) {
        void runPendingPush(spreadsheetId);
      }
    });
  pushInflight.set(spreadsheetId, promise);
  await promise;
}

/**
 * 진행 중이거나 대기 중인 push를 즉시 끝낸 뒤 resolve. 공유 링크 생성처럼
 * "원격에 반드시 반영된 다음에 다음 단계로 가야 하는" 흐름에서 사용.
 */
export async function flushPendingPush(spreadsheetId: string): Promise<void> {
  const timer = pushTimers.get(spreadsheetId);
  if (timer) {
    clearTimeout(timer);
    pushTimers.delete(spreadsheetId);
  }
  if (pushPending.has(spreadsheetId)) {
    await runPendingPush(spreadsheetId);
  } else {
    const inflight = pushInflight.get(spreadsheetId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* 이미 로깅됨 */
      }
    }
  }
}

