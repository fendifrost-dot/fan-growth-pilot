import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sanitizeCuratorIgHandle } from "./contact-extract.ts";

export type IgRosterRow = {
  ig_handle: string;
  display_name: string | null;
  follows_me: boolean;
  i_follow: boolean;
  is_mutual: boolean;
  relationship_notes: string | null;
  last_verified_at: string | null;
};

export async function getRosterEntry(
  sb: SupabaseClient,
  handle: string,
): Promise<IgRosterRow | null> {
  const h = handle.replace(/^@/, "").toLowerCase().trim();
  const { data } = await sb.from("instagram_curator_roster").select("*").eq("ig_handle", h).maybeSingle();
  return data as IgRosterRow | null;
}

export async function requireMutualForQueue(
  sb: SupabaseClient,
  handle: string,
  requireMutual: boolean,
): Promise<{ ok: boolean; reason?: string; roster?: IgRosterRow | null }> {
  const h = sanitizeCuratorIgHandle(handle.replace(/^@/, ""));
  if (!h) return { ok: false, reason: "invalid_handle" };
  const roster = await getRosterEntry(sb, h);
  if (!requireMutual) return { ok: true, roster };
  if (!roster) {
    return { ok: false, reason: "not_on_roster", roster: null };
  }
  if (!roster.is_mutual) {
    const parts = [];
    if (!roster.i_follow) parts.push("you do not follow");
    if (!roster.follows_me) parts.push("they do not follow back");
    return { ok: false, reason: parts.join("; ") || "not_mutual", roster };
  }
  return { ok: true, roster };
}

export async function syncRosterFromPlaylistTargets(sb: SupabaseClient): Promise<number> {
  const { data: rows } = await sb.from("playlist_targets")
    .select("curator_instagram, curator_name, curator_submission_dm")
    .eq("is_active", true)
    .not("curator_instagram", "is", null);
  let n = 0;
  for (const r of rows ?? []) {
    const raw = (r.curator_submission_dm as string) || (r.curator_instagram as string) || "";
    const h = sanitizeCuratorIgHandle(raw.replace(/^@/, ""));
    if (!h) continue;
    const { error } = await sb.from("instagram_curator_roster").upsert({
      ig_handle: h,
      display_name: (r.curator_name as string) ?? null,
      source: "playlist_targets_sync",
      updated_at: new Date().toISOString(),
    }, { onConflict: "ig_handle", ignoreDuplicates: false });
    if (!error) n++;
  }
  return n;
}

export async function runIgRosterAdmin(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (action === "list_ig_roster") {
    const mutualOnly = Boolean(body.mutual_only);
    let q = sb.from("instagram_curator_roster").select("*").order("updated_at", { ascending: false }).limit(500);
    if (mutualOnly) q = q.eq("is_mutual", true);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { rows: data ?? [] } };
  }

  if (action === "patch_ig_roster") {
    const handle = sanitizeCuratorIgHandle(String(body.ig_handle ?? "").replace(/^@/, ""));
    if (!handle) return { status: 400, data: { error: "ig_handle required" } };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), last_verified_at: new Date().toISOString() };
    if (body.display_name !== undefined) patch.display_name = String(body.display_name ?? "").trim() || null;
    if (body.follows_me !== undefined) patch.follows_me = Boolean(body.follows_me);
    if (body.i_follow !== undefined) patch.i_follow = Boolean(body.i_follow);
    if (body.relationship_notes !== undefined) {
      patch.relationship_notes = String(body.relationship_notes ?? "").trim() || null;
    }
    const { data, error } = await sb.from("instagram_curator_roster")
      .upsert({ ig_handle: handle, ...patch }, { onConflict: "ig_handle" })
      .select("*")
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "import_ig_roster") {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    let upserted = 0;
    for (const e of entries) {
      const o = e as Record<string, unknown>;
      const handle = sanitizeCuratorIgHandle(String(o.ig_handle ?? o.handle ?? "").replace(/^@/, ""));
      if (!handle) continue;
      const { error } = await sb.from("instagram_curator_roster").upsert({
        ig_handle: handle,
        display_name: String(o.display_name ?? o.name ?? "").trim() || null,
        follows_me: Boolean(o.follows_me ?? o.follows_you ?? false),
        i_follow: Boolean(o.i_follow ?? o.you_follow ?? false),
        relationship_notes: String(o.notes ?? "").trim() || null,
        last_verified_at: new Date().toISOString(),
        source: "import",
      }, { onConflict: "ig_handle" });
      if (!error) upserted++;
    }
    return { status: 200, data: { ok: true, upserted } };
  }

  if (action === "sync_ig_roster_from_targets") {
    const n = await syncRosterFromPlaylistTargets(sb);
    return { status: 200, data: { ok: true, synced: n } };
  }

  return { status: 400, data: { error: `Unknown ig roster action: ${action}` } };
}
