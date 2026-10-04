/**
 * Curator-level contact context. Several playlists can share one curator (same email,
 * same submission form, same IG account). The EXISTING contact rule — one pitch per song
 * per curator target within artist_config.cooldown_days (default 90) — is applied at the
 * curator identity, so the same song is not re-pitched to the same curator through a
 * sibling playlist. Contacts for OTHER songs are reported for Grok's judgment; no new
 * cross-song cooldown is invented here.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type CuratorIdentity = {
  email: string | null;
  form: string | null;
  ig: string | null;
};

export type CuratorContact = {
  playlist_id: string | null;
  track_id: string | null;
  track_name: string | null;
  channel: string;
  contacted_at: string | null;
  cooldown_until: string | null;
};

export type CuratorContactContext = {
  identity: CuratorIdentity;
  sibling_playlist_ids: string[];
  same_song_block: CuratorContact | null;
  other_song_contacts: CuratorContact[];
  cooldown_days: number;
  error?: string;
};

function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

export function normalizeFormKey(url: string | null | undefined): string | null {
  const u = s(url);
  if (!u) return null;
  try {
    const p = new URL(u);
    return `${p.hostname.toLowerCase().replace(/^www\./, "")}${p.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return u.toLowerCase();
  }
}

export function curatorIdentity(target: Record<string, unknown> | null | undefined): CuratorIdentity {
  return {
    email: s(target?.curator_email).toLowerCase() || null,
    form: normalizeFormKey(s(target?.form_url)),
    ig: s(target?.ig_curator_account ?? target?.curator_instagram).replace(/^@/, "").toLowerCase() || null,
  };
}

async function cooldownDays(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "cooldown_days").maybeSingle();
  const n = Number((data as { value?: unknown } | null)?.value);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

/**
 * Build contact context for sending `track` to `target`. Query errors are returned in
 * `error` so callers fail closed.
 */
export async function curatorContactContext(
  sb: SupabaseClient,
  opts: {
    target: Record<string, unknown>;
    trackId: string | null;
    trackName: string | null;
    now?: Date;
  },
): Promise<CuratorContactContext> {
  const now = opts.now ?? new Date();
  const identity = curatorIdentity(opts.target);
  const selfId = s(opts.target.playlist_id);
  const empty: CuratorContactContext = {
    identity,
    sibling_playlist_ids: [],
    same_song_block: null,
    other_song_contacts: [],
    cooldown_days: 90,
  };
  if (!identity.email && !identity.form && !identity.ig) return empty;

  const days = await cooldownDays(sb);
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const siblings = new Set<string>();
  if (selfId) siblings.add(selfId);

  // Sibling playlists sharing the curator identity.
  const lookups: [string, string | null][] = [
    ["curator_email", identity.email],
    ["ig_curator_account", identity.ig],
  ];
  for (const [col, val] of lookups) {
    if (!val) continue;
    const { data, error } = await sb.from("playlist_targets").select("playlist_id").eq(col, val);
    if (error) return { ...empty, cooldown_days: days, error: error.message };
    for (const r of (data ?? []) as { playlist_id: string }[]) siblings.add(String(r.playlist_id));
  }
  if (identity.form) {
    const { data, error } = await sb.from("playlist_targets").select("playlist_id, form_url").not("form_url", "is", null);
    if (error) return { ...empty, cooldown_days: days, error: error.message };
    for (const r of (data ?? []) as { playlist_id: string; form_url: string }[]) {
      if (normalizeFormKey(r.form_url) === identity.form) siblings.add(String(r.playlist_id));
    }
  }

  const contacts: CuratorContact[] = [];
  // Email history is keyed by curator address in pitch_log.
  if (identity.email) {
    const { data, error } = await sb
      .from("pitch_log")
      .select("playlist_id, track_id, track_name, status, sent_at, pitched_at, cooldown_until, curator_email")
      .eq("curator_email", identity.email)
      .eq("status", "sent");
    if (error) return { ...empty, cooldown_days: days, error: error.message };
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      // A bounce is not a delivery. Do not start a cooldown from it.
      if (String(r.status).toLowerCase() === "bounced") continue;
      contacts.push({
        playlist_id: s(r.playlist_id) || null,
        track_id: s(r.track_id) || null,
        track_name: s(r.track_name) || null,
        channel: "email",
        contacted_at: s(r.sent_at ?? r.pitched_at) || null,
        cooldown_until: s(r.cooldown_until) || null,
      });
    }
  }
  // Manual form / IG submissions are stamped on handoff records.
  if (siblings.size) {
    const { data, error } = await sb
      .from("agh_handoff_records")
      .select("playlist_target_id, track_id, submitted_at, submission_channel")
      .in("playlist_target_id", [...siblings]);
    if (error) return { ...empty, cooldown_days: days, error: error.message };
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (!r.submitted_at) continue;
      contacts.push({
        playlist_id: s(r.playlist_target_id) || null,
        track_id: s(r.track_id) || null,
        track_name: null,
        channel: s(r.submission_channel) || "manual",
        contacted_at: s(r.submitted_at),
        cooldown_until: new Date(Date.parse(String(r.submitted_at)) + days * 86400000).toISOString(),
      });
    }
  }

  const sameSong = (c: CuratorContact) =>
    (opts.trackId && c.track_id === opts.trackId) ||
    (!!opts.trackName && !!c.track_name && c.track_name.toLowerCase() === opts.trackName.toLowerCase());
  const active = (c: CuratorContact) =>
    c.cooldown_until ? Date.parse(c.cooldown_until) > now.getTime() : (c.contacted_at ?? "") >= since;

  const block = contacts.find((c) => sameSong(c) && active(c)) ?? null;
  const others = contacts.filter((c) => !sameSong(c) && (c.contacted_at ?? "") >= since);

  return {
    identity,
    sibling_playlist_ids: [...siblings],
    same_song_block: block,
    other_song_contacts: others,
    cooldown_days: days,
  };
}
