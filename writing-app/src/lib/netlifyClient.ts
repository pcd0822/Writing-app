function errorMessageFromPayload(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const err = o.error ?? o.message;
  if (typeof err === "string") return err;
  if (err != null && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return null;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function backoffDelayMs(attempt: number, status?: number, retryAfterHeader?: string | null) {
  // Retry-After (초 단위 또는 HTTP-date) 가 있으면 그 값을 우선 사용한다.
  if (retryAfterHeader) {
    const asNum = Number(retryAfterHeader);
    if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 10_000);
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      const diff = asDate - Date.now();
      if (diff > 0) return Math.min(diff, 10_000);
    }
  }
  // 429(쿼터 초과)는 더 긴 지수 백오프, 그 외 재시도 가능 상태는 짧게.
  // 30명 동시 접속 시 모든 클라이언트가 같은 시점에 재시도하지 않도록 jitter 필수.
  const base = status === 429 ? 1000 : 600;
  const expo = base * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(expo, 8_000);
  const jitter = Math.random() * 400; // 0~400ms 분산
  return capped + jitter;
}

export async function callFunction<TResponse>(
  name: string,
  body: unknown,
  options?: { retries?: number },
): Promise<TResponse> {
  /**
   * 콜드 스타트·게이트웨이 오류(502/503/504)·쿼터 초과(429)·네트워크 단절은 재시도.
   * db-set은 전체 덮어쓰기라 재시도해도 안전(멱등). db-get/sheets-init도 멱등.
   * 30명 동시 로그인 시 Sheets API 분당 한도에 잠시 걸려 429가 떨어져도
   * 지수 백오프 + jitter 로 분산 재시도해 일부 학생만 실패하는 현상을 막는다.
   */
  const maxRetries = options?.retries ?? 3;
  const url = `/.netlify/functions/${name}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = new Error(
        `${msg.includes("Failed to fetch") ? "서버 함수에 연결할 수 없습니다. " : ""}` +
          `로컬에서는 \`netlify dev\`로 실행해야 합니다(또는 배포된 사이트에서 시도). (${msg})`,
      );
      if (attempt < maxRetries) {
        await sleep(backoffDelayMs(attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      lastError = new Error(`요청 실패: ${res.status}`);
      const retryAfter = res.headers.get("retry-after");
      await sleep(backoffDelayMs(attempt + 1, res.status, retryAfter));
      continue;
    }

    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { error: text.slice(0, 400) };
      }
    }

    if (!res.ok) {
      const msg =
        errorMessageFromPayload(data) ||
        (res.status === 404
          ? "함수를 찾을 수 없습니다. 로컬에서는 netlify dev로 실행하세요."
          : `요청 실패: ${res.status}`);
      throw new Error(msg);
    }
    return data as TResponse;
  }

  throw lastError ?? new Error("요청 실패");
}

