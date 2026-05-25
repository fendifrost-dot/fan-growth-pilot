const HUB_KEY = import.meta.env.VITE_FANFUEL_HUB_KEY as string | undefined;
const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;

export function hubFnUrl(name: string): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/${name}`;
}

export async function callHubFn<T = unknown>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!HUB_KEY) throw new Error("VITE_FANFUEL_HUB_KEY missing — set in Lovable env / .env");
  const r = await fetch(hubFnUrl(name), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": HUB_KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}
