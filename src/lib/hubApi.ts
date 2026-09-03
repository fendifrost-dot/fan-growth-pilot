import { supabase } from "@/integrations/supabase/client";

const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function ccaUrl(): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/control-center-api`;
}

/**
 * Call a control-center-api action.
 * Forwards the signed-in admin JWT when present so Song DNA / discovery
 * approvals attribute to Fendi’s identity. Cron/Telegram callers still use
 * server-side x-api-key separately.
 */
export async function callHubFn<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ANON) headers["apikey"] = ANON;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const r = await fetch(ccaUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...body }),
  });
  const dataJson = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((dataJson as { error?: string }).error || `HTTP ${r.status}`);
  return dataJson as T;
}
