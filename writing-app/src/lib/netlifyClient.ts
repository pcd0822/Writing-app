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

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function callFunction<TResponse>(
  name: string,
  body: unknown,
  options?: { retries?: number },
): Promise<TResponse> {
  /**
   * 콜드 스타트나 일시적 게이트웨이 오류(502/503/504)·네트워크 단절은 한 번 재시도.
   * db-set은 전체 덮어쓰기라 재시도해도 안전(멱등). db-get/sheets-init도 멱등.
   */
  const maxRetries = options?.retries ?? 1;
  const url = `/.netlify/functions/${name}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);

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
      if (attempt < maxRetries) continue;
      throw lastError;
    }

    if (!res.ok && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      lastError = new Error(`요청 실패: ${res.status}`);
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

