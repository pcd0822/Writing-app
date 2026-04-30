import { prepareDbForSheetPush } from "./attachments";
import { callFunction } from "./netlifyClient";
import type { Submission, TeacherDb } from "./types";

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

/**
 * 시트가 막 push된 직후 또는 다른 디바이스의 push가 propagate되는 동안 batchGet
 * 응답이 일시적으로 빈 결과(meta+tabular 모두 비어있음)를 반환할 수 있다. 이를
 * "시트가 비어있다"고 단정하지 않도록 짧은 백오프로 재시도한다. 빈 결과 한 번을
 * 신호로 자동 업로드 같은 데이터 손실 path로 가지 않게 막는 것이 핵심.
 *
 * 여러 번 시도해도 빈 결과면 정말 빈 시트로 확정. 그때는 호출자가 사용자 확인
 * 없이는 시트를 덮어쓰지 않도록 처리한다.
 */
export async function pullDbFromSheetWithRetry(
  spreadsheetId: string,
  options?: {
    attempts?: number;
    delayMs?: number;
    onAttempt?: (attempt: number, total: number) => void;
  },
): Promise<PullResult> {
  const attempts = options?.attempts ?? 3;
  const delayMs = options?.delayMs ?? 900;
  let last: PullResult = { db: null };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs * i));
    options?.onAttempt?.(i + 1, attempts);
    last = await callFunction<PullResult>("db-get", { spreadsheetId });
    if (last.db) return last;
  }
  return last;
}

export async function pushDbToSheet(
  spreadsheetId: string,
  db: unknown,
  options?: { skipPullMerge?: boolean },
): Promise<TeacherDb> {
  /**
   * 같은 시트를 두 교사가 공유 사용할 때, 한쪽의 push가 상대방의 변경을 통째로
   * 덮어쓰지 않도록 push 직전에 시트를 pull하여 union 머지한 결과를 push한다.
   *
   * pull 실패(네트워크 단절·시트 빈 상태) 시에는 머지 없이 로컬만 push하여
   * 한쪽 디바이스라도 동작하도록 fail-soft.
   *
   * 호출자가 이미 명시적으로 머지했다면 `skipPullMerge: true`로 중복 라운드트립
   * 을 줄일 수 있다.
   */
  let toPush = db as TeacherDb;
  if (!options?.skipPullMerge) {
    try {
      // pre-push pull도 재시도. 직전에 다른 교사가 push한 데이터가 lag로 빈
      // 결과로 보이면 우리가 그것을 union하지 못해 시트에서 사라뜨릴 수 있음.
      const remote = await pullDbFromSheetWithRetry(spreadsheetId, {
        attempts: 2,
        delayMs: 600,
      });
      if (remote.db) {
        const { mergeTeacherDbs } = await import("./localDb");
        toPush = mergeTeacherDbs(toPush, remote.db as TeacherDb);
      }
    } catch (err) {
      console.warn("[Writing app] pre-push pull failed; pushing local only:", err);
    }
  }
  const payload = prepareDbForSheetPush(toPush);
  await callFunction<{ ok: true }>("db-set", { spreadsheetId, db: payload });
  return toPush;
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
/**
 * 코얼레싱 창 동안의 옵션은 latest-wins. 학생 측에서 한 번이라도 studentPush:true로
 * 호출되면 그 창의 push는 pre-push pull을 생략한다(자기 submission만 건드리므로 안전).
 */
const pushOptions = new Map<string, { skipPullMerge?: boolean }>();

const COALESCE_DELAY_MS = 800;

export type PushCoalesceOptions = {
  /** true면 push 직전 pull-merge를 생략. 학생용 path에서 사용. */
  skipPullMerge?: boolean;
};

export function pushDbToSheetCoalesced(
  spreadsheetId: string,
  db: unknown,
  options?: PushCoalesceOptions,
) {
  pushPending.set(spreadsheetId, db);
  if (options) pushOptions.set(spreadsheetId, options);
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
  const opts = pushOptions.get(spreadsheetId);
  pushOptions.delete(spreadsheetId);

  const promise = pushDbToSheet(spreadsheetId, latest, opts)
    .then(async (merged) => {
      // 머지된 결과를 로컬에도 흡수해서 다른 교사가 추가한 항목이 다음 화면 갱신에
      // 보이도록 한다. 단, 코얼레싱 도중 사용자가 또 입력했을 수 있어 현재 로컬과
      // 다시 머지(updatedAt 큰 쪽 우선 규칙으로 사용자 입력 보존).
      if (typeof window === "undefined") return;
      try {
        const { loadTeacherDb, saveTeacherDb, mergeTeacherDbs } = await import(
          "./localDb"
        );
        const cur = loadTeacherDb();
        const final = mergeTeacherDbs(cur, merged);
        saveTeacherDb(final, { skipRemotePush: true });
      } catch (err) {
        console.warn("[Writing app] post-push local merge failed:", err);
      }
    })
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

// ── 학생 단위 부분 업데이트 ───────────────────────────────────
//
// 학생 자기 submission 데이터(본문·타임스탬프·GRASPS)만 시트에 부분적으로 쓴다.
// 시트 전체 16개를 wholesale rewrite하던 기존 db-set 대비:
//  - 페이로드: 학생 1명분 → 9초 timeout 위험 사실상 0
//  - 동시성: 다른 학생의 행은 절대 안 건드림 → 30명 동시 업데이트도 race-free
//
// 인증 데이터(shareToken, studentNo, studentCode)는 share landing 단계에서 학생이
// 직접 입력해 검증된 값을 sessionStorage로 보관 후 호출자가 전달한다. 서버에서도
// students/shares 시트와 다시 대조하므로 이중 검증.

export type PushSubmissionPartialPayload = {
  spreadsheetId: string;
  shareToken: string;
  studentNo: string;
  studentCode: string;
  submission: Submission;
  /** GRASPS 맥락 설계 JSON. 변경됐을 때만 전달. 없으면 청크 기존 값 유지. */
  graspData?: string;
};

/**
 * 학생용 partial push. 키 입력 자동저장이 아니라 명시적 저장/제출/GRASPS 저장 시에만
 * 호출되도록 한다. 자동저장은 localStorage만 쓰는 정책을 유지.
 */
export async function pushSubmissionPartial(
  payload: PushSubmissionPartialPayload,
): Promise<void> {
  await callFunction<{ ok: true }>("db-set-submission", payload);
}

/**
 * 같은 submission에 대해 빠르게 연속되는 partial push를 묶는다. coalesce 창 동안 마지막
 * payload만 살아남고, 진행 중 push가 있으면 끝난 뒤에 다음을 보낸다(latest-wins).
 */
const partialPending = new Map<string, PushSubmissionPartialPayload>();
const partialTimers = new Map<string, ReturnType<typeof setTimeout>>();
const partialInflight = new Map<string, Promise<void>>();
const PARTIAL_COALESCE_DELAY_MS = 600;

function partialKey(p: PushSubmissionPartialPayload) {
  return `${p.spreadsheetId}::${p.submission.id}`;
}

export function pushSubmissionPartialCoalesced(payload: PushSubmissionPartialPayload) {
  const key = partialKey(payload);
  partialPending.set(key, payload);
  const existing = partialTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    partialTimers.delete(key);
    void runPendingPartialPush(key);
  }, PARTIAL_COALESCE_DELAY_MS);
  partialTimers.set(key, timer);
}

async function runPendingPartialPush(key: string) {
  const inflight = partialInflight.get(key);
  if (inflight) {
    try {
      await inflight;
    } catch {
      /* 이전 실패는 캐치해서 다음 시도가 막히지 않게 함 */
    }
  }
  const latest = partialPending.get(key);
  if (!latest) return;
  partialPending.delete(key);

  const promise = pushSubmissionPartial(latest)
    .catch((err) => {
      console.error("[Writing app] pushSubmissionPartial failed:", err);
      throw err;
    })
    .finally(() => {
      if (partialInflight.get(key) === promise) {
        partialInflight.delete(key);
      }
      if (partialPending.has(key)) {
        void runPendingPartialPush(key);
      }
    });
  partialInflight.set(key, promise);
  await promise;
}

/**
 * 학생 path에서 코얼레싱 중이거나 진행 중인 partial push가 모두 끝날 때까지 대기.
 * 제출 모달을 띄우기 전에 await해서, 시트 반영 전에 학생이 탭을 닫는 데이터 손실을 방지.
 */
export async function flushPendingPartialPush(
  spreadsheetId: string,
  submissionId: string,
): Promise<void> {
  const key = `${spreadsheetId}::${submissionId}`;
  const timer = partialTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    partialTimers.delete(key);
  }
  if (partialPending.has(key)) {
    await runPendingPartialPush(key);
  } else {
    const inflight = partialInflight.get(key);
    // 진행 중인 push가 있으면 그 결과를 그대로 전파(reject 시 호출자도 throw).
    if (inflight) await inflight;
  }
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

