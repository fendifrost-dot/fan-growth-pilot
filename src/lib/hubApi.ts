const HUB_KEY = import.meta.env.VITE_FANFUEL_HUB_KEY as string | undefined;
const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/** Standalone edge fn name → control-center-api action (works when new fn names 404 on Lovable). */
const CC_ACTION: Record<string, string> = {
  "draft-pitch": "draft_pitch",
  "approve-draft": "approve_draft",
  "enrich-curator-contacts": "enrich_curator_contacts",
  "schedule-follow-up": "schedule_follow_up",
  "playlist-admin-api": "__passthrough__",
};

export function hubFnUrl(name: string): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/${name}`;
}

export async function callHubFn<T = unknown>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!HUB_KEY) throw new Error("VITE_FANFUEL_HUB_KEY missing — set in Lovable env / .env");
  const ccAction = CC_ACTION[name];
  const url = ccAction ? hubFnUrl("control-center-api") : hubFnUrl(name);
  const payload = ccAction
    ? ccAction === "__passthrough__"
      ? body
      : { action: ccAction, ...body }
    : body;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": HUB_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}
