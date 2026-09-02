/**
 * Song DNA — versioned music identity for campaign activation + sync readiness.
 *
 * Approval is Fendi-only (admin JWT). Cursor/migrations never invent approvals
 * or music facts. Locked: docs/PHASE0_LOCKED_DECISIONS.md §3.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  TRACK_IDS,
  assertHouseElectronicStampAllowed,
  normalizeTrackId,
} from "./catalog-rules.ts";

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

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function requireAdminActor(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return {
      status: 401,
      data: {
        error:
          "Song DNA writes require Fendi’s authenticated admin JWT. Caller-supplied identity is ignored.",
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

function validateMusicFields(body: Record<string, unknown>, trackId: string): string | null {
  const primary = body.primary_genre == null ? null : String(body.primary_genre).trim();
  if (primary) {
    const houseCheck = assertHouseElectronicStampAllowed(
      trackId,
      primary === "house_electronic" || primary.toLowerCase().includes("house")
        ? "house_electronic"
        : "other",
    );
    // Only enforce allow-list when the stamp is explicitly house_electronic.
    if (primary === "house_electronic" && !houseCheck.ok) return houseCheck.error;
  }

  const sample = String(body.sample_declaration ?? "unknown");
  if (!["yes", "no", "unknown"].includes(sample)) {
    return "sample_declaration must be yes|no|unknown";
  }

  const syncRec = String(body.sync_recommendation ?? "blocked");
  if (!["blocked", "candidate", "approved", "rejected"].includes(syncRec)) {
    return "sync_recommendation must be blocked|candidate|approved|rejected";
  }

  // Neva Too Much Prada remains sync-blocked without license evidence (locked §4).
  if (
    normalizeTrackId(trackId) === TRACK_IDS.NEVA_TOO_MUCH_PRADA &&
    (syncRec === "approved" || syncRec === "candidate")
  ) {
    const hasLicense = Boolean(
      (body.payload as Record<string, unknown> | undefined)?.license_evidence_id ||
        (body.payload as Record<string, unknown> | undefined)?.private_license_uploaded,
    );
    if (!hasLicense) {
      return "Neva Too Much Prada stays sync-blocked until private license evidence is attached. Do not invent licenses.";
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

async function listSongDna(sb: SupabaseClient, body: Record<string, unknown>): Promise<Result> {
  const trackId = String(body.track_id ?? "").trim();
  let q = sb
    .from("song_dna_versions")
    .select(
      "id, track_id, version_number, approval_state, primary_genre, secondary_genres, approved_lanes, excluded_lanes, mood_tags, bpm_hint, energy_hint, sample_declaration, sync_recommendation, notes, payload, created_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, created_at, updated_at, tracks(name)",
    )
    .order("version_number", { ascending: false });
  if (trackId) q = q.eq("track_id", trackId);
  const { data, error } = await q.limit(200);
  if (error) {
    return {
      status: 503,
      data: {
        error:
          `song_dna_versions unavailable (${error.message}). Apply 20260903000000_song_dna_versions.sql via Lovable SQL Editor.`,
      },
    };
  }
  const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
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
    .select("*, tracks(name)")
    .eq("id", id)
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!data) return { status: 404, data: { error: "Song DNA version not found" } };
  return {
    status: 200,
    data: {
      ok: true,
      version: {
        ...data,
        track_name: (data.tracks as { name?: string } | null)?.name ?? null,
        tracks: undefined,
      },
    },
  };
}

async function createDraft(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  const { data: track } = await sb.from("tracks").select("id, name").eq("id", trackId).maybeSingle();
  if (!track) return { status: 404, data: { error: "Track not found" } };

  const fieldErr = validateMusicFields(body, trackId);
  if (fieldErr) return { status: 400, data: { error: fieldErr } };

  const versionNumber = await nextVersionNumber(sb, trackId);
  const now = new Date().toISOString();
  const row = {
    track_id: trackId,
    version_number: versionNumber,
    approval_state: "draft",
    primary_genre: body.primary_genre == null ? null : String(body.primary_genre).trim() || null,
    secondary_genres: asStringArray(body.secondary_genres),
    approved_lanes: asStringArray(body.approved_lanes),
    excluded_lanes: asStringArray(body.excluded_lanes),
    mood_tags: asStringArray(body.mood_tags),
    bpm_hint: body.bpm_hint == null || body.bpm_hint === "" ? null : Number(body.bpm_hint),
    energy_hint: body.energy_hint == null || body.energy_hint === "" ? null : Number(body.energy_hint),
    sample_declaration: String(body.sample_declaration ?? "unknown"),
    sync_recommendation: String(body.sync_recommendation ?? "blocked"),
    notes: body.notes == null ? null : String(body.notes),
    payload: (body.payload as Record<string, unknown> | undefined) ?? {},
    created_by: actor!.kind === "user" ? actor!.userId : null,
    updated_at: now,
  };

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
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
  const id = String(body.song_dna_version_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "song_dna_version_id required" } };

  const { data: current } = await sb.from("song_dna_versions").select("*").eq("id", id).maybeSingle();
  if (!current) return { status: 404, data: { error: "Song DNA version not found" } };
  if (!EDITABLE_STATES.has(String(current.approval_state))) {
    return {
      status: 400,
      data: {
        error: `Cannot edit Song DNA in state '${current.approval_state}'. Create a new draft version instead.`,
      },
    };
  }

  const trackId = String(current.track_id);
  const fieldErr = validateMusicFields({ ...current, ...body }, trackId);
  if (fieldErr) return { status: 400, data: { error: fieldErr } };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.primary_genre !== undefined) {
    patch.primary_genre = body.primary_genre == null ? null : String(body.primary_genre).trim() || null;
  }
  if (body.secondary_genres !== undefined) patch.secondary_genres = asStringArray(body.secondary_genres);
  if (body.approved_lanes !== undefined) patch.approved_lanes = asStringArray(body.approved_lanes);
  if (body.excluded_lanes !== undefined) patch.excluded_lanes = asStringArray(body.excluded_lanes);
  if (body.mood_tags !== undefined) patch.mood_tags = asStringArray(body.mood_tags);
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
  // Editing a rejected version returns it to draft.
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
  });

  return { status: 200, data: { ok: true, version: data } };
}

async function submitForReview(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
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
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
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

  // Demote any prior approved version on this track (unique index also enforces one).
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

  await sb
    .from("tracks")
    .update({ approved_song_dna_version_id: id })
    .eq("id", current.track_id);

  try {
    const { recomputeTrackSyncEligible } = await import("./sync-eligibility.ts");
    const sync = await recomputeTrackSyncEligible(sb, String(current.track_id));
    return { status: 200, data: { ok: true, version: data, sync } };
  } catch (e) {
    console.error("sync recompute after DNA approve failed:", e);
    return {
      status: 200,
      data: {
        ok: true,
        version: data,
        sync_recompute_error: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

async function rejectSongDna(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
): Promise<Result> {
  const authErr = requireAdminActor(actor);
  if (authErr) return authErr;
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
): Promise<Result> {
  switch (action) {
    case "list_song_dna":
      return await listSongDna(sb, body);
    case "get_song_dna":
      return await getSongDna(sb, body);
    case "create_song_dna_draft":
      return await createDraft(sb, body, actor);
    case "update_song_dna_draft":
      return await updateDraft(sb, body, actor);
    case "submit_song_dna_for_review":
      return await submitForReview(sb, body, actor);
    case "approve_song_dna":
      return await approveSongDna(sb, body, actor);
    case "reject_song_dna":
      return await rejectSongDna(sb, body, actor);
    case "list_song_dna_audit":
      return await listAudit(sb, body);
    default:
      return { status: 400, data: { error: `Unknown song DNA action: ${action}` } };
  }
}
