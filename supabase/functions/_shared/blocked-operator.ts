/**
 * Blocked / inactive pay-to-play operator groups.
 *
 * Discovery must not create a new playlist target — including a route-only row
 * with no Spotify id — when the candidate's email domain, contact, curator
 * name, or URL matches an operator_group_id we already marked blocked or
 * pay-to-play (colonizemedia, lordvincent, livinginplaylists, and the rest of
 * that set). The group is the unit: one blocked or pay-to-play row disqualifies
 * every sibling that shares the id.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parseSpotifyPlaylistId } from "./discovery-utils.ts";
import { hostLabel, hostOf } from "./submission-route.ts";

export type OperatorMatchOn =
  | "existing_target"
  | "email_exact"
  | "email_domain"
  | "email_local"
  | "contact"
  | "curator_name"
  | "url";

export type OperatorMatch = {
  operator_group_id: string;
  matched_on: OperatorMatchOn;
};

export type OperatorCandidate = {
  playlistId?: string | null;
  curatorEmail?: string | null;
  curatorName?: string | null;
  playlistName?: string | null;
  formUrl?: string | null;
  submissionUrl?: string | null;
  playlistUrl?: string | null;
  sourceUrl?: string | null;
  website?: string | null;
  igAccount?: string | null;
};

const MIN_SLUG = 6;
const MIN_PREFIX_GROUP = 8;

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "pm.me",
]);

/** Trailing tokens on a mailbox local-part that still name the same operator. */
const LOCAL_TAILS = new Set([
  "business",
  "official",
  "music",
  "playlist",
  "playlists",
  "submit",
  "submissions",
  "promo",
  "agency",
  "media",
  "curator",
  "spotify",
  "booking",
  "management",
  "mgmt",
]);

/** Host labels that are platforms, not an operator's own site. */
const GENERIC_HOST_LABELS = new Set([
  "gmail",
  "google",
  "yahoo",
  "hotmail",
  "outlook",
  "live",
  "icloud",
  "proton",
  "protonmail",
  "spotify",
  "soundplate",
  "instagram",
  "facebook",
  "linktr",
  "youtube",
  "tiktok",
  "twitter",
  "forms",
  "docs",
  "sites",
  "wix",
  "carrd",
]);

const OPERATOR_COLUMNS =
  "playlist_id, operator_group_id, curator_email, curator_name, curator_website, form_url, submission_url, ig_curator_account, curator_instagram, pitch_status, fraud_verdict, is_active, submission_cost, verification_status, playlist_name";

export function operatorSlug(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A row anchors a blocked operator group when its pitch or verification status
 * is blocked, or when it is marked pay-to-play (pitch_status or fraud_verdict).
 * Live rows in this set are also inactive; the status is what disqualifies them.
 */
export function isBlockedOrInactivePayToPlay(row: Record<string, unknown>): boolean {
  if (!String(row.operator_group_id ?? "").trim()) return false;
  const status = String(row.pitch_status ?? "").trim().toLowerCase();
  const verdict = String(row.fraud_verdict ?? "").trim().toLowerCase();
  const verification = String(row.verification_status ?? "").trim().toLowerCase();
  if (status === "blocked" || verification === "blocked") return true;
  return status === "pay_to_play" || verdict === "pay_to_play";
}

export type BlockedOperatorIndex = {
  playlistIds: Map<string, string>;
  emails: Map<string, string>;
  igHandles: Map<string, string>;
  urls: Map<string, string>;
  nameSlugs: Map<string, string>;
  groupSlugs: Map<string, string>;
};

export function emptyBlockedOperatorIndex(): BlockedOperatorIndex {
  return {
    playlistIds: new Map(),
    emails: new Map(),
    igHandles: new Map(),
    urls: new Map(),
    nameSlugs: new Map(),
    groupSlugs: new Map(),
  };
}

function rememberPlaylistId(index: BlockedOperatorIndex, raw: unknown, group: string) {
  const id = String(raw ?? "").trim();
  if (!id) return;
  index.playlistIds.set(id, group);
  const parsed = parseSpotifyPlaylistId(id);
  if (parsed.ok) index.playlistIds.set(parsed.id, group);
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function igKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "");
}

function emailParts(email: string): { local: string; domain: string } | null {
  const norm = email.trim().toLowerCase();
  const at = norm.lastIndexOf("@");
  if (at <= 0 || at === norm.length - 1) return null;
  return { local: norm.slice(0, at), domain: norm.slice(at + 1) };
}

function localMatchesGroup(local: string, groupSlug: string): boolean {
  const slug = operatorSlug(local);
  if (slug.length < MIN_SLUG || groupSlug.length < MIN_SLUG) return false;
  if (slug === groupSlug) return true;
  if (groupSlug.length < MIN_PREFIX_GROUP || !slug.startsWith(groupSlug)) return false;
  return LOCAL_TAILS.has(slug.slice(groupSlug.length));
}

export function buildBlockedOperatorIndex(rows: Record<string, unknown>[]): BlockedOperatorIndex {
  const qualifying = new Set<string>();
  for (const row of rows) {
    if (!isBlockedOrInactivePayToPlay(row)) continue;
    qualifying.add(String(row.operator_group_id).trim().toLowerCase());
  }
  const index = emptyBlockedOperatorIndex();
  for (const row of rows) {
    const group = String(row.operator_group_id ?? "").trim().toLowerCase();
    if (!group || !qualifying.has(group)) continue;
    const slug = operatorSlug(group);
    if (slug.length >= MIN_SLUG) index.groupSlugs.set(slug, group);
    rememberPlaylistId(index, row.playlist_id, group);
    const email = String(row.curator_email ?? "").trim().toLowerCase();
    if (email.includes("@")) index.emails.set(email, group);
    for (const ig of [row.ig_curator_account, row.curator_instagram]) {
      const key = igKey(String(ig ?? ""));
      if (key.length >= 3) index.igHandles.set(key, group);
    }
    for (const url of [row.form_url, row.submission_url, row.curator_website]) {
      const norm = normalizeUrl(String(url ?? ""));
      if (norm.startsWith("http")) index.urls.set(norm, group);
    }
    const name = operatorSlug(row.curator_name);
    if (name.length >= MIN_SLUG) index.nameSlugs.set(name, group);
  }
  return index;
}

function groupForPlaylistId(index: BlockedOperatorIndex, raw: string | null | undefined): string | null {
  const id = String(raw ?? "").trim();
  if (!id) return null;
  const direct = index.playlistIds.get(id);
  if (direct) return direct;
  const parsed = parseSpotifyPlaylistId(id);
  if (parsed.ok) return index.playlistIds.get(parsed.id) ?? null;
  return null;
}

function matchUrl(index: BlockedOperatorIndex, raw: string): OperatorMatch | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parseSpotifyPlaylistId(trimmed);
  if (parsed.ok) {
    const group = index.playlistIds.get(parsed.id);
    if (group) return { operator_group_id: group, matched_on: "url" };
  }
  const norm = normalizeUrl(trimmed);
  const exact = norm ? index.urls.get(norm) : undefined;
  if (exact) return { operator_group_id: exact, matched_on: "url" };
  const host = hostOf(trimmed);
  if (!host) return null;
  const label = operatorSlug(hostLabel(host));
  if (label.length < MIN_SLUG || GENERIC_HOST_LABELS.has(label)) return null;
  const group = index.groupSlugs.get(label);
  if (!group) return null;
  return { operator_group_id: group, matched_on: "url" };
}

/** First matching signal wins. Null when the candidate is not in a blocked group. */
export function matchBlockedOperator(
  index: BlockedOperatorIndex,
  candidate: OperatorCandidate,
): OperatorMatch | null {
  const byId = groupForPlaylistId(index, candidate.playlistId);
  if (byId) return { operator_group_id: byId, matched_on: "existing_target" };

  const email = String(candidate.curatorEmail ?? "").trim().toLowerCase();
  if (email && index.emails.has(email)) {
    return { operator_group_id: index.emails.get(email)!, matched_on: "email_exact" };
  }
  const parts = email ? emailParts(email) : null;
  if (parts && !FREE_EMAIL_DOMAINS.has(parts.domain)) {
    const label = operatorSlug(hostLabel(parts.domain));
    const group = label.length >= MIN_SLUG ? index.groupSlugs.get(label) : undefined;
    if (group) return { operator_group_id: group, matched_on: "email_domain" };
  }
  if (parts) {
    for (const [slug, group] of index.groupSlugs) {
      if (localMatchesGroup(parts.local, slug)) {
        return { operator_group_id: group, matched_on: "email_local" };
      }
    }
  }

  const ig = igKey(String(candidate.igAccount ?? ""));
  if (ig.length >= 3) {
    const stored = index.igHandles.get(ig);
    if (stored) return { operator_group_id: stored, matched_on: "contact" };
    const group = ig.length >= MIN_SLUG ? index.groupSlugs.get(ig) : undefined;
    if (group) return { operator_group_id: group, matched_on: "contact" };
  }

  const name = operatorSlug(candidate.curatorName);
  if (name.length >= MIN_SLUG) {
    const stored = index.nameSlugs.get(name);
    if (stored) return { operator_group_id: stored, matched_on: "curator_name" };
    const group = index.groupSlugs.get(name);
    if (group) return { operator_group_id: group, matched_on: "curator_name" };
  }
  const playlistName = operatorSlug(candidate.playlistName);
  if (playlistName.length >= MIN_SLUG) {
    const group = index.groupSlugs.get(playlistName);
    if (group) return { operator_group_id: group, matched_on: "curator_name" };
  }

  for (const url of [
    candidate.formUrl,
    candidate.submissionUrl,
    candidate.playlistUrl,
    candidate.sourceUrl,
    candidate.website,
  ]) {
    const hit = matchUrl(index, String(url ?? ""));
    if (hit) return hit;
  }
  return null;
}

/** Every operator-grouped target, paged. Callers filter to the blocked set. */
export async function loadBlockedOperatorIndex(
  sb: SupabaseClient,
): Promise<{ index: BlockedOperatorIndex; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  const page = 1000;
  for (let from = 0; from < 20000; from += page) {
    const { data, error } = await sb
      .from("playlist_targets")
      .select(OPERATOR_COLUMNS)
      .not("operator_group_id", "is", null)
      .range(from, from + page - 1);
    if (error) return { index: emptyBlockedOperatorIndex(), error: error.message };
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return { index: buildBlockedOperatorIndex(rows), error: null };
}
