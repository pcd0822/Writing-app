import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role client. RLS-bypassing, server-only — never reuse this
// module in client code. Netlify Functions run with the secrets in
// process.env so this is safe inside `netlify/functions/`.

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify env"
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application": "writing-app/netlify-functions" } },
  });
  return cached;
}
