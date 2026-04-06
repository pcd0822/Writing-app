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

export function getGoogleJwt() {
  const { clientEmail, privateKey } = getServiceAccount();
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: SCOPES,
  });
}

export function getSheetsClient() {
  const auth = getGoogleJwt();
  return google.sheets({ version: "v4", auth });
}

export function getDriveClient() {
  const auth = getGoogleJwt();
  return google.drive({ version: "v3", auth });
}
