/**
 * Song DNA — versioned music identity for campaign activation + outreach routing.
 *
 * Approval is Fendi-only (admin JWT). Migrations / agents never invent approvals
 * or music facts. Catalog-specific titles/UUIDs are NOT used for routing —
 * approved_lanes / primary_genre / short_pitch on the DNA row are the source of truth.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  denyUnlessCan,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";

export const SONG_DNA_ACTIONS = [
  "list_song_dna",
  "get_song_dna",
  "create_song_dna_draft",
  "update_song_dna_draft",
  "submit_song_dna_for_review",
  "approve_song_dna",
  "reject_song_dna",
  "list_song_dna_audit",
] as const;

export function isSongDnaAction(action: string): boolean {
  return (SONG_DNA_ACTIONS as readonly string[]).includes(action);
}

export type SongDnaApprovalState =
  | "draft"
  | "pending_fendi_review"
  | "approved"
  | "rejected";

type Result = { status: number; data: Record<string, unknown> };

const EDITABLE_STATES = new Set(["draft", "rejected"]);

/** Explicit FK alias — tracks has multiple FKs to song_dna_versions; bare tracks(name) is ambiguous. */
export const SONG_DNA_TRACKS_EMBED =
  "tracks:tracks!song_dna_versions_track_id_fkey(name)";

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function isMissingSchemaError(error: { code?: string; message?: string }): boolean {
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

/** Operator-facing DB error — only nudge migration when the schema object is actually missing. */
export function formatSongDnaQueryError(error: {
  code?: string;
  message?: string;
}): string {
  const code = error.code ? ` [${error.code}]` : "";
  const message = error.message || "unknown database error";
  if (isMissingSchemaError(error)) {
    return (
      `song_dna_versions unavailable${code}: ${message}. ` +
      `Apply 20260905000000_outreach_dna_discovery_identity.sql via Lovable SQL Editor.`
    );
  }
  return `Song DNA query failed${code}: ${message}`;
}

function requireAdminActor(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return {
      status: 401,
      data: {
        error:
          "Song DNA writes require an authenticated admin JWT. Caller-supplied identity is ignored.",
      },
    };
  }
  return null;
}

function requireFendiOps(opsActor: OpsActor | null, capability: "approve_song_dna" | "reject_song_dna" | "alter_approved_song_dna"): Result | null {
  if (!opsActor) {
    return { status: 403, data: { error: "Fendi identity required" } };
  }
  const denied = denyUnlessCan(opsActor, capability);
  if (denied) return denied;
  if (opsActor.kind !== "fendi") {
    return {
      status: 403,
      data: {
        error: `Only Fendi's exact ARTIST_USER_ID may ${capability} (got ${opsActor.label})`,
      },
    };
  }
  return null;
}

async function audit(
  sb: SupabaseClient,
  entry: {
    songDnaVersionId: string;
    trackId: string;
    eventType: string;
    actor: Actor | null;
    fromState?: string | null;
    toState?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await sb.from("song_dna_audit_events").insert({
    song_dna_version_id: entry.songDnaVersionId,
    track_id: entry.trackId,
    event_type: entry.eventType,
    actor_user_id: entry.actor?.kind === "user" ? entry.actor.userId : null,
    actor_kind: entry.actor?.kind === "user" ? "user" : "service",
    from_state: entry.fromState ?? null,
    to_state: entry.toState ?? null,
    detail: entry.detail ?? {},
  });
  if (error) console.error("song_dna audit failed:", error.message);
}

function validateMusicFields(body: Record<string, unknown>): string | null {
  const sample = String(body.sample_declaration ?? "unknown");
  if (!["yes", "no", "unknown"].includes(sample)) {
    return "sample_declaration must be yes|no|unknown";
  }

  const syncRec = String(body.sync_recommendation ?? "blocked");
  if (!["blocked", "candidate", "approved", "rejected"].includes(syncRec)) {
    return "sync_recommendation must be blocked|candidate|approved|rejected";
  }

  // Tracks that require private license evidence set this flag on DNA payload
  // (operator-configured — never inferred from catalog title/UUID in source).
  const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
  if (
    payload.requires_private_license === true &&
    (syncRec === "approved" || syncRec === "candidate")
  ) {
    const hasLicense = Boolean(
      payload.license_evidence_id || payload.private_license_uploaded,
    );
    if (!hasLicense) {
      return "This track stays sync-blocked until private license evidence is attached on the DNA payload. Do not invent licenses.";
    }
  }

  return null;
}

async function nextVersionNumber(sb: SupabaseClient, trackId: string): Promise<number> {
  const { data } = await sb
    .from("song_dna_versions")
    .select("version_number")
    .eq("track_id", trackId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.version_number ?? 0) + 1;
}

export function dnaSelectCols(): string {
  return (
    "id, track_id, version_number, approval_state, primary_genre, secondary_genres, approved_lanes, excluded_lanes, mood_tags, context_tags, reference_artists, short_pitch, bpm_hint, energy_hint, sample_declaration, sync_recommendation, notes, payload, created_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, created_at, updated_at, " +
    SONG_DNA_TRACKS_EMBED
  );
}

export function dnaGetSelectCols(): string {
  return `*, ${SONG_DNA_TRACKS_EMBED}`;
}

async function listSongDna(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const trackId = String(body.track_id ?? "").trim();
  let q = sb
    .from("song_dna_versions")
    .select(dnaSelectCols())
    .order("version_number", { ascending: false });
  if (trackId) q = q.eq("track_id", trackId);
  const { data, error } = await q.limit(200);
  if (error) {
    return {
      status: isMissingSchemaError(error) ? 503 : 500,
      data: { error: formatSongDnaQueryError(error) },
    };
  }
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    ...r,
    track_name: (r.tracks as { name?: string } | null)?.name ?? null,
    tracks: undefined,
  }));
  return { status: 200, data: { ok: true, rows } };
}

async function getSongDna(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const id = String(body.song_dna_version_id ?? body.id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };
  const { data, error } = await sb
    .from("song_dna_versions")
    .select(dnaGetSelectCols())
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return {
      status: isMissingSchemaError(error) ? 503 : 500,
      data: { error: formatSongDnaQueryError(error) },
    };
  }
  if (!data) return { status: 404, data: { error: "Song DNA version not found" } };
  const row = data as Record<string, unknown>;
  const tracks = row.tracks as { name?: string } | null | undefined;
  return {
    status: 200,
    data: {
      ok: true,
      version: {
        ...row,
        track_name: tracks?.name ?? null,
        tracks: undefined,
      },
    },
  };
}

function buildDnaRow(
  body: Record<string, unknown>,
  trackId: string,
  versionNumber: number,
  actor: Actor,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    track_id: trackId,
    version_number: versionNumber,
    approval_state: "draft",
    primary_genre: body.primary_genre == null ? null : String(body.primary_genre).trim() || null,
    secondary_genres: asStringArray(body.secondary_genres),
    approved_lanes: asStringArray(body.approved_lanes),
    excluded_lanes: asStringArray(body.excluded_lanes),
    mood_tags: asStringArray(body.mood_tags),
    context_tags: asStringArray(body.context_tags),
    reference_artists: asStringArray(body.reference_artists),
    short_pitch: body.short_pitch == null ? null : String(body.short_pitch).trim() || null,
    bpm_hint: body.bpm_hint == null || body.bpm_hint === "" ? null : Number(body.bpm_hint),
    energy_hint: body.energy_hint == null || body.energy_hint === "" ? null : Number(body.energy_hint),
    sample_declaration: String(body.sample_declaration ?? "unknown"),
    sync_recommendation: String(body.sync_recommendation ?? "blocked"),
    notes: body.notes == null ? null : String(body.notes),
    payload: (body.payload as Record<string, unknown> | undefined) ?? {},
    created_by: actor.kind === "user" ? actor.userId : null,
    updated_at: now,
  };
}

async function createDraft(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  opsActor: OpsActor | null = null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const capErr = denyUnlessCan(
    opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" },
    "draft_song_dna",
  );
  if (capErr) return capErr;
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  const { data: track } = await sb.from("tracks").select("id, name").eq("id", trackId).maybeSingle();
  if (!track) return { status: 404, data: { error: "Track not found" } };

  const fieldErr = validateMusicFields(body);
  if (fieldErr) return { status: 400, data: { error: fieldErr } };

  const versionNumber = await nextVersionNumber(sb, trackId);
  const row = buildDnaRow(body, trackId, versionNumber, actor!);

  const { data, error } = await sb.from("song_dna_versions").insert(row).select("*").single();
  if (error) throw error;

  await audit(sb, {
    songDnaVersionId: String(data.id),
    trackId,
    eventType: "created_draft",
    actor,
    toState: "draft",
    detail: { version_number: versionNumber, track_name: track.name },
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function updateDraft(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  opsActor: OpsActor | null = null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const id = String(body.song_dna_version_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };

  const { data: current } = await sb.from("song_dna_versions").select("*").eq("id", id).maybeSingle();
  if (!current) return { status: 404, data: { error: "Song DNA version not found" } };
  if (String(current.approval_state) === "approved") {
    const fendiErr = requireFendiOps(opsActor, "alter_approved_song_dna");
    if (fendiErr) return fendiErr;
  } else {
    const draftCapErr = denyUnlessCan(
      opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" },
      "draft_song_dna",
    );
    if (draftCapErr) return draftCapErr;
    if (!EDITABLE_STATES.has(String(current.approval_state))) {
    return {
      status: 400,
      data: {
        error: `Cannot edit Song DNA in state '${current.approval_state}'. Create a new draft version instead.`,
      },
    };
    }
  }

  const trackId = String(current.track_id);
  const fieldErr = validateMusicFields({ ...current, ...body });
  if (fieldErr) return { status: 400, data: { error: fieldErr } };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.primary_genre !== undefined) {
    patch.primary_genre = body.primary_genre == null ? null : String(body.primary_genre).trim() || null;
  }
  if (body.secondary_genres !== undefined) patch.secondary_genres = asStringArray(body.secondary_genres);
  if (body.approved_lanes !== undefined) patch.approved_lanes = asStringArray(body.approved_lanes);
  if (body.excluded_lanes !== undefined) patch.excluded_lanes = asStringArray(body.excluded_lanes);
  if (body.mood_tags !== undefined) patch.mood_tags = asStringArray(body.mood_tags);
  if (body.context_tags !== undefined) patch.context_tags = asStringArray(body.context_tags);
  if (body.reference_artists !== undefined) {
    patch.reference_artists = asStringArray(body.reference_artists);
  }
  if (body.short_pitch !== undefined) {
    patch.short_pitch = body.short_pitch == null ? null : String(body.short_pitch).trim() || null;
  }
  if (body.bpm_hint !== undefined) {
    patch.bpm_hint = body.bpm_hint == null || body.bpm_hint === "" ? null : Number(body.bpm_hint);
  }
  if (body.energy_hint !== undefined) {
    patch.energy_hint = body.energy_hint == null || body.energy_hint === "" ? null : Number(body.energy_hint);
  }
  if (body.sample_declaration !== undefined) patch.sample_declaration = String(body.sample_declaration);
  if (body.sync_recommendation !== undefined) patch.sync_recommendation = String(body.sync_recommendation);
  if (body.notes !== undefined) patch.notes = body.notes == null ? null : String(body.notes);
  if (body.payload !== undefined) patch.payload = body.payload ?? {};
  if (current.approval_state === "rejected") {
    patch.approval_state = "draft";
    patch.rejection_reason = null;
    patch.rejected_at = null;
    patch.rejected_by = null;
  }

  const { data, error } = await sb.from("song_dna_versions").update(patch).eq("id", id).select("*").single();
  if (error) throw error;

  await audit(sb, {
    songDnaVersionId: id,
    trackId,
    eventType: "updated_draft",
    actor,
    fromState: String(current.approval_state),
    toState: String(data.approval_state),
    detail: { previous: current, next: data, reason: String(body.reason ?? "").trim() || undefined },
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function submitForReview(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  opsActor: OpsActor | null = null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const capErr = denyUnlessCan(
    opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" },
    "submit_song_dna_for_review",
  );
  if (capErr) return capErr;
  const id = String(body.song_dna_version_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };

  const { data: current } = await sb.from("song_dna_versions").select("*").eq("id", id).maybeSingle();
  if (!current) return { status: 404, data: { error: "Song DNA version not found" } };
  if (!EDITABLE_STATES.has(String(current.approval_state))) {
    return { status: 400, data: { error: `Cannot submit from state '${current.approval_state}'` } };
  }
  if (!String(current.primary_genre ?? "").trim()) {
    return { status: 400, data: { error: "primary_genre required before submit for Fendi review" } };
  }
  if ((current.approved_lanes as string[] | null)?.length === 0) {
    return {
      status: 400,
      data: { error: "approved_lanes required before submit (at least one playlist lane)" },
    };
  }
  if (!String(current.short_pitch ?? "").trim()) {
    return {
      status: 400,
      data: { error: "short_pitch required before submit — song-specific copy for {{pitch}}" },
    };
  }

  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("song_dna_versions")
    .update({
      approval_state: "pending_fendi_review",
      submitted_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await audit(sb, {
    songDnaVersionId: id,
    trackId: String(current.track_id),
    eventType: "submitted_for_review",
    actor,
    fromState: String(current.approval_state),
    toState: "pending_fendi_review",
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function approveSongDna(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  opsActor: OpsActor | null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const fendiErr = requireFendiOps(opsActor, "approve_song_dna");
  if (fendiErr) return fendiErr;
  body = stripSpoofedAttribution(body);
  const id = String(body.song_dna_version_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };

  const { data: current } = await sb.from("song_dna_versions").select("*").eq("id", id).maybeSingle();
  if (!current) return { status: 404, data: { error: "Song DNA version not found" } };
  if (String(current.approval_state) !== "pending_fendi_review") {
    return {
      status: 400,
      data: {
        error: `Only pending_fendi_review versions can be approved (current: ${current.approval_state})`,
      },
    };
  }

  await sb
    .from("song_dna_versions")
    .update({
      approval_state: "rejected",
      rejection_reason: "Superseded by newer approved version",
      rejected_at: new Date().toISOString(),
      rejected_by: actor!.kind === "user" ? actor!.userId : null,
      updated_at: new Date().toISOString(),
    })
    .eq("track_id", current.track_id)
    .eq("approval_state", "approved")
    .neq("id", id);

  const now = new Date().toISOString();
  const approver = actor!.kind === "user" ? actor!.userId : null;
  const { data, error } = await sb
    .from("song_dna_versions")
    .update({
      approval_state: "approved",
      approved_by: approver,
      approved_at: now,
      updated_at: now,
      rejected_by: null,
      rejected_at: null,
      rejection_reason: null,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await audit(sb, {
    songDnaVersionId: id,
    trackId: String(current.track_id),
    eventType: "approved",
    actor,
    fromState: "pending_fendi_review",
    toState: "approved",
    detail: { approved_by: approver },
  });

  // Best-effort pointer on tracks (column added in DNA migration).
  await sb
    .from("tracks")
    .update({
      approved_song_dna_version_id: id,
      // Keep track short_pitch in sync with approved DNA when DNA has pitch.
      ...(String(current.short_pitch ?? "").trim()
        ? { short_pitch: String(current.short_pitch).trim() }
        : {}),
      updated_at: now,
    })
    .eq("id", current.track_id);

  await sb.from("agh_config_audit_events").insert({
    entity_type: "song_dna_version",
    entity_id: id,
    event_type: "approved",
    actor_user_id: approver,
    previous_value: { approval_state: "pending_fendi_review" },
    new_value: { approval_state: "approved", track_id: current.track_id },
    reason: String(body.reason ?? "fendi_approved"),
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function rejectSongDna(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  opsActor: OpsActor | null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const fendiErr = requireFendiOps(opsActor, "reject_song_dna");
  if (fendiErr) return fendiErr;
  body = stripSpoofedAttribution(body);
  const id = String(body.song_dna_version_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };
  const reason = String(body.rejection_reason ?? "").trim();
  if (!reason) return { status: 400, data: { error: "rejection_reason required" } };

  const { data: current } = await sb.from("song_dna_versions").select("*").eq("id", id).maybeSingle();
  if (!current) return { status: 404, data: { error: "Song DNA version not found" } };
  if (String(current.approval_state) !== "pending_fendi_review") {
    return {
      status: 400,
      data: { error: `Only pending_fendi_review versions can be rejected (current: ${current.approval_state})` },
    };
  }

  const now = new Date().toISOString();
  const rejector = actor!.kind === "user" ? actor!.userId : null;
  const { data, error } = await sb
    .from("song_dna_versions")
    .update({
      approval_state: "rejected",
      rejected_by: rejector,
      rejected_at: now,
      rejection_reason: reason,
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await audit(sb, {
    songDnaVersionId: id,
    trackId: String(current.track_id),
    eventType: "rejected",
    actor,
    fromState: "pending_fendi_review",
    toState: "rejected",
    detail: { rejection_reason: reason },
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function listAudit(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const dnaId = String(body.song_dna_version_id ?? "").trim();
  const trackId = String(body.track_id ?? "").trim();
  let q = sb
    .from("song_dna_audit_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (dnaId) q = q.eq("song_dna_version_id", dnaId);
  else if (trackId) q = q.eq("track_id", trackId);
  else return { status: 400, data: { error: "song_dna_version_id or track_id required" } };
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, rows: data ?? [] } };
}

export async function runSongDnaAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
  opsActor: OpsActor | null = null,
): Promise<Result> {
  switch (action) {
    case "list_song_dna":
      return await listSongDna(sb, body);
    case "get_song_dna":
      return await getSongDna(sb, body);
    case "create_song_dna_draft":
      return await createDraft(sb, stripSpoofedAttribution(body), actor, opsActor);
    case "update_song_dna_draft":
      return await updateDraft(sb, stripSpoofedAttribution(body), actor, opsActor);
    case "submit_song_dna_for_review":
      return await submitForReview(sb, stripSpoofedAttribution(body), actor, opsActor);
    case "approve_song_dna":
      return await approveSongDna(sb, body, actor, opsActor);
    case "reject_song_dna":
      return await rejectSongDna(sb, body, actor, opsActor);
    case "list_song_dna_audit":
      return await listAudit(sb, body);
    default:
      return { status: 400, data: { error: `Unknown song DNA action: ${action}` } };
  }
}
