export async function callFunction<TResponse>(
  name: string,
  body: unknown,
): Promise<TResponse> {
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `요청 실패: ${res.status}`;
    throw new Error(msg);
  }
  return data as TResponse;
}

