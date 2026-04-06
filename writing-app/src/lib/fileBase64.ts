/** Uint8Array → base64 (대용량 분할) */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

/** FileReader 없이 ArrayBuffer → base64 (대용량 분할) */
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return uint8ArrayToBase64(new Uint8Array(buf));
}
