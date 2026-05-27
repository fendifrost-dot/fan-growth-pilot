import { supabase } from "@/integrations/supabase/client";

const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;

function ccaUrl(): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/control-center-api`;
}

/**
 * Call a control-center-api action with the current Supabase session JWT.
 * Throws if the user isn't logged in (AdminGuard should prevent that).
 */
export async function callHubFn<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Not signed in — refresh the page and log in again.");
  }
  const r = await fetch(ccaUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}
