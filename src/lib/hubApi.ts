const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;

function ccaUrl(): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/control-center-api`;
}

/**
 * Call a control-center-api action.
 * No auth header — Fan Fuel Hub is a single-operator internal tool.
 * Trust model: URL secrecy. Telegram CC + crons authenticate server-side via x-api-key.
 */
export async function callHubFn<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const r = await fetch(ccaUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}
