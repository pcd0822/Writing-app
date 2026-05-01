import { google } from "googleapis";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getServiceAccount() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const parsed = JSON.parse(json);
    return {
      clientEmail: parsed.client_email as string,
      privateKey: (parsed.private_key as string).replace(/\\n/g, "\n"),
    };
  }

  const clientEmail = requireEnv("GOOGLE_SA_CLIENT_EMAIL");
  const privateKey = requireEnv("GOOGLE_SA_PRIVATE_KEY").replace(/\\n/g, "\n");
  return { clientEmail, privateKey };
}

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

/**
 * Warm Lambda 한 인스턴스가 처리하는 동시 호출들이 같은 JWT 객체와 access token 을
 * 공유하도록 module-level 에서 캐싱한다. googleapis 의 JWT 클라이언트는 내부적으로
 * 토큰 만료 직전까지 access token 을 재사용하므로, 한 번만 만들어두면 30명이 동시에
 * 들어와도 OAuth round-trip 이 1회로 줄어든다 (cold start 한정).
 */
let cachedJwt: InstanceType<typeof google.auth.JWT> | null = null;
let cachedSheetsClient: ReturnType<typeof google.sheets> | null = null;
let cachedDriveClient: ReturnType<typeof google.drive> | null = null;

export function getGoogleJwt() {
  if (cachedJwt) return cachedJwt;
  const { clientEmail, privateKey } = getServiceAccount();
  cachedJwt = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: SCOPES,
  });
  return cachedJwt;
}

export function getSheetsClient() {
  if (cachedSheetsClient) return cachedSheetsClient;
  cachedSheetsClient = google.sheets({ version: "v4", auth: getGoogleJwt() });
  return cachedSheetsClient;
}

export function getDriveClient() {
  if (cachedDriveClient) return cachedDriveClient;
  cachedDriveClient = google.drive({ version: "v3", auth: getGoogleJwt() });
  return cachedDriveClient;
}

export async function getGoogleAccessToken(): Promise<string> {
  const auth = getGoogleJwt();
  const t = await auth.getAccessToken();
  if (!t.token) throw new Error("Google 액세스 토큰을 받지 못했습니다.");
  return t.token;
}
