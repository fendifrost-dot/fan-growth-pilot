import { supabase } from "@/integrations/supabase/client";

const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function ccaUrl(): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/control-center-api`;
}

/**
 * Call a control-center-api action with the signed-in user's JWT.
 * Campaign writes (create/update/activate) require admin role server-side;
 * Fendi approver identity is derived from the JWT, never from request body.
 * Server-to-server callers (Telegram / crons) use x-api-key on other routes.
 */
export async function callHubFn<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ANON) headers["apikey"] = ANON;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const r = await fetch(ccaUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}
