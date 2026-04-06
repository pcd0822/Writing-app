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

export async function callFunction<TResponse>(
  name: string,
  body: unknown,
): Promise<TResponse> {
  let res: Response;
  try {
    res = await fetch(`/.netlify/functions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg.includes("Failed to fetch") ? "서버 함수에 연결할 수 없습니다. " : ""}` +
        `로컬에서는 \`netlify dev\`로 실행해야 합니다(또는 배포된 사이트에서 시도). (${msg})`,
    );
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

