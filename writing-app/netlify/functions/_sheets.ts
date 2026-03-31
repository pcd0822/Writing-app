import { google } from "googleapis";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getServiceAccount() {
  // Netlify env vars: store as raw JSON in GOOGLE_SERVICE_ACCOUNT_JSON
  // Or split fields if preferred. Here we support both.
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

export function getSheetsClient() {
  const { clientEmail, privateKey } = getServiceAccount();
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function ensureWorkbookStructure(spreadsheetId: string) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set((meta.data.sheets || []).map((s) => s.properties?.title));

  const wanted = [
    "meta",
    "classes",
    "students",
    "assignments",
    "assignment_targets",
    "shares",
    "submissions",
    "feedback_notes",
    "ai_logs",
    "scores",
  ];

  const toAdd = wanted.filter((t) => !existing.has(t));
  if (toAdd.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: toAdd.map((title) => ({
        addSheet: { properties: { title } },
      })),
    },
  });
}

