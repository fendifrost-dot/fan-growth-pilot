/**
 * Fixed tool handlers for the claude_playlist_discovery remote MCP connector.
 * Tools call internal AGH logic under a fixed identity — never forward arbitrary
 * action names from the model. OAuth bearer identity is sufficient; no synthetic
 * CLAUDE_PLAYLIST_DISCOVERY_SECRET requests.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  can,
  denyUnlessCan,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";
import { buildDiscoveryCapacityPlan } from "./discovery-capacity.ts";
import { enforceTrackDnaLaneEnvelope, resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import { resolveTrackPitchCopy } from "./pitch-copy.ts";
import { rejectCallerPlaylistCopy } from "./pitch-descriptor-guard.ts";
import { evaluateSubmissionPath } from "./multichannel-path.ts";
import { reviewHandoffBatch } from "./handoff-queues.ts";
import { startDailyStationRun, completeDailyStationRun } from "./daily-ops.ts";
import { CLAUDE_STATION_IDS, isClaudeStationId } from "./chicago-time.ts";
import { normalizeSpotifyPlaylistIdentity } from "./discovery-utils.ts";
import { runDraftPitch } from "./playlist-agent-run.ts";
import { VERIFIED_STATUSES } from "./verify-target.ts";
import {
  classifyExistingPlaylistTarget,
  inventoryIdempotencyKey,
  lookupInventoryPair,
  assertWriteOk,
} from "./playlist-discovery-ops.ts";

export type ToolResult = { status: number; data: Record<string, unknown> };

/**
 * playlist_targets Insert keys from generated Supabase types (live schema).
 * Used to fail closed on mistaken columns such as playlist_url / research_notes.
 */
export const PLAYLIST_TARGETS_SCHEMA_INSERT_KEYS = new Set([
  "authenticity_notes",
  "authenticity_score",
  "bounce_count",
  "contact_confidence",
  "contact_method",
  "created_at",
  "curator_email",
  "curator_handle",
  "curator_instagram",
  "curator_linktree",
  "curator_name",
  "curator_submission_dm",
  "curator_submission_note",
  "curator_submission_url",
  "curator_tiktok",
  "curator_twitter",
  "curator_url",
  "curator_website",
  "discovered_by",
  "discovered_by_label",
  "discovery_profile_id",
  "follower_count",
  "form_cost",
  "form_deadline",
  "form_login_required",
  "form_manual_submit_result",
  "form_manual_submitted_at",
  "form_manual_submitted_by",
  "form_required_fields",
  "form_requirements",
  "form_source_evidence",
  "form_url",
  "form_verified_at",
  "fraud_score",
  "fraud_verdict",
  "id",
  "ig_curator_account",
  "ig_dm_draft",
  "ig_manual_response_status",
  "ig_manual_submitted_at",
  "ig_manual_submitted_by",
  "ig_source_evidence",
  "ig_verified_at",
  "is_active",
  "is_paid",
  "lane",
  "last_bounced_at",
  "last_enriched_at",
  "last_pitched_at",
  "last_verified_at",
  "legitimacy_score",
  "notes",
  "overlap_score",
  "path_verification_notes",
  "path_verified",
  "pitch_count",
  "pitch_status",
  "pitched_at",
  "platform",
  "playlist_id",
  "playlist_name",
  "recommended_pitch_angle",
  "research_context",
  "similar_artists",
  "song_dna_version_id",
  "submission_cost",
  "submission_method",
  "submission_url",
  "tier",
  "track_count",
  "track_name",
  "updated_at",
  "verification_notes",
  "verification_status",
  "verified_by",
  "verified_by_label",
  "vibe_tags",
  "whitelist_status",
  "why_it_fits",
]);

/** Forbidden mistaken columns that have caused live PostgREST schema-cache failures. */
export const PLAYLIST_TARGETS_FORBIDDEN_INSERT_KEYS = [
  "playlist_url",
  "research_notes",
] as const;

/**
 * Build a schema-safe playlist_targets insert for discovery.
 * Accepts playlist_url / source_url only as inputs for identity/context — never as columns.
 */
export function buildDiscoveryPlaylistTargetInsert(opts: {
  playlistId: string;
  playlistName: string;
  lane: string;
  pathVerified: boolean;
  verificationStatus: string;
  pathReason: string | null;
  channel: string | null;
  curatorEmail: string | null;
  formUrl: string | null;
  igAccount: string | null;
  evidence: string;
  discoveredBy: string;
  discoveredByLabel: string;
  trackName: string | null;
  songDnaVersionId: string | null;
  /** Canonical Spotify URL from normalization — stored in research_context only. */
  playlistUrl: string | null;
  rawSourceUrl?: string | null;
}): Record<string, unknown> {
  const researchContext: Record<string, unknown> = {
    source: "claude_playlist_discovery",
    discovered_at: new Date().toISOString(),
  };
  if (opts.playlistUrl) researchContext.playlist_url = opts.playlistUrl;
  if (opts.rawSourceUrl && opts.rawSourceUrl !== opts.playlistUrl) {
    researchContext.source_url = opts.rawSourceUrl;
  }

  const row: Record<string, unknown> = {
    playlist_id: opts.playlistId,
    playlist_name: opts.playlistName,
    platform: "spotify",
    lane: opts.lane,
    verification_status: opts.verificationStatus,
    path_verified: opts.pathVerified,
    path_verification_notes: opts.pathReason,
    curator_email: opts.curatorEmail,
    form_url: opts.formUrl,
    form_source_evidence: opts.evidence,
    // Only use form URL as submission_url; never stash playlist URLs here.
    submission_url: opts.formUrl,
    ig_curator_account: opts.igAccount,
    curator_instagram: opts.igAccount,
    ig_source_evidence: opts.evidence,
    contact_method: opts.channel ?? "email",
    submission_method: opts.channel ?? "email",
    submission_cost: "unknown",
    discovered_by: opts.discoveredBy,
    discovered_by_label: opts.discoveredByLabel,
    song_dna_version_id: opts.songDnaVersionId,
    track_name: opts.trackName ?? "",
    research_context: researchContext,
    notes: opts.evidence,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const schemaErr = assertPlaylistTargetInsertSchema(row);
  if (schemaErr) {
    throw new Error(`playlist_targets_insert_schema:${schemaErr}`);
  }
  return row;
}

/** Returns null when the row matches the live/generated insert contract. */
export function assertPlaylistTargetInsertSchema(row: Record<string, unknown>): string | null {
  for (const bad of PLAYLIST_TARGETS_FORBIDDEN_INSERT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, bad)) {
      return `forbidden_key:${bad}`;
    }
  }
  for (const key of Object.keys(row)) {
    if (!PLAYLIST_TARGETS_SCHEMA_INSERT_KEYS.has(key)) {
      return `unknown_key:${key}`;
    }
  }
  if (!String(row.playlist_id ?? "").trim()) return "missing_playlist_id";
  if (!String(row.playlist_name ?? "").trim()) return "missing_playlist_name";
  return null;
}

export const PLAYLIST_DISCOVERY_TOOLS = [
  "get_playlist_discovery_work",
  "submit_playlist_candidates",
  "create_playlist_draft_inventory",
  "start_claude_playlist_station",
  "complete_claude_playlist_station",
  "get_own_playlist_batches",
] as const;

export type PlaylistDiscoveryTool = (typeof PLAYLIST_DISCOVERY_TOOLS)[number];

export function isPlaylistDiscoveryTool(name: string): name is PlaylistDiscoveryTool {
  return (PLAYLIST_DISCOVERY_TOOLS as readonly string[]).includes(name);
}

/** Fixed identity — never accept caller-supplied actor labels. */
export function playlistDiscoveryActor(): OpsActor {
  return {
    kind: "claude_playlist_discovery",
    userId: null,
    label: "claude_playlist_discovery",
  };
}

/** Credential Actor for handlers that resolve via resolveOpsActor(actor, req). */
export function playlistDiscoveryCredentialActor(): Actor {
  return { kind: "claude_playlist_discovery" };
}

const SUBMISSION_CHANNELS = ["email", "web_form", "instagram_dm"] as const;

export const PLAYLIST_DISCOVERY_TOOL_SCHEMAS: Record<
  PlaylistDiscoveryTool,
  Record<string, unknown>
> = {
  get_playlist_discovery_work: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  submit_playlist_candidates: {
    type: "object",
    required: ["track_id", "candidates"],
    additionalProperties: false,
    properties: {
      track_id: { type: "string", minLength: 1, maxLength: 64 },
      song_dna_version_id: { type: "string", maxLength: 64 },
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            playlist_id: { type: "string", maxLength: 128 },
            spotify_playlist_id: { type: "string", maxLength: 128 },
            playlist_url: { type: "string", maxLength: 512 },
            source_url: { type: "string", maxLength: 512 },
            playlist_name: { type: "string", maxLength: 256 },
            name: { type: "string", maxLength: 256 },
            lane: { type: "string", minLength: 1, maxLength: 64 },
            source_evidence: { type: "string", maxLength: 4000 },
            evidence: { type: "string", maxLength: 4000 },
            submission_channel: { type: "string", enum: [...SUBMISSION_CHANNELS] },
            curator_email: { type: "string", maxLength: 320 },
            form_url: { type: "string", maxLength: 512 },
            ig_curator_account: { type: "string", maxLength: 64 },
          },
        },
      },
    },
  },
  create_playlist_draft_inventory: {
    type: "object",
    required: ["track_id"],
    additionalProperties: false,
    properties: {
      track_id: { type: "string", minLength: 1, maxLength: 64 },
      song_dna_version_id: { type: "string", maxLength: 64 },
      accepted_candidate_ids: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 128 },
      },
      playlist_ids: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
  },
  start_claude_playlist_station: {
    type: "object",
    required: ["station_id"],
    additionalProperties: false,
    properties: {
      station_id: { type: "string", enum: [...CLAUDE_STATION_IDS] },
      business_date_ct: { type: "string", maxLength: 16 },
      input_batch_id: { type: "string", maxLength: 64 },
    },
  },
  complete_claude_playlist_station: {
    type: "object",
    required: ["run_id"],
    additionalProperties: false,
    properties: {
      run_id: { type: "string", minLength: 1, maxLength: 64 },
      id: { type: "string", maxLength: 64 },
      output_batch_id: { type: "string", maxLength: 64 },
      notes: { type: "string", maxLength: 2000 },
      status: {
        type: "string",
        enum: ["completed", "partial", "blocked", "failed"],
      },
      raw_discoveries: { type: "integer", minimum: 0, maximum: 100000 },
      unique_discoveries: { type: "integer", minimum: 0, maximum: 100000 },
      verified_targets: { type: "integer", minimum: 0, maximum: 100000 },
      drafts_created: { type: "integer", minimum: 0, maximum: 100000 },
      duplicates: { type: "integer", minimum: 0, maximum: 100000 },
      rejected_blocked: {
        type: "array",
        maxItems: 200,
        items: { type: "object", additionalProperties: true },
      },
      saturation_indicators: {
        type: "array",
        maxItems: 200,
        items: { type: "string", maxLength: 500 },
      },
      shortfall_reason: { type: "string", maxLength: 2000 },
      error_summary: { type: "string", maxLength: 4000 },
      metrics: { type: "object", additionalProperties: true },
    },
  },
  get_own_playlist_batches: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
};

/** Runtime enforcement of published MCP JSON Schemas (nested objects included). */
function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string | null {
  const typ = schema.type;
  if (typ === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `${path}: expected object`;
    }
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
        return `${path}.${key}: required`;
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(obj).filter((k) => !(k in props));
      if (extra.length) return `${path}: unexpected fields ${extra.join(", ")}`;
    }
    for (const [key, child] of Object.entries(props)) {
      if (obj[key] === undefined) continue;
      const err = validateAgainstSchema(child, obj[key], `${path}.${key}`);
      if (err) return err;
    }
    return null;
  }
  if (typ === "array") {
    if (!Array.isArray(value)) return `${path}: expected array`;
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems != null && value.length < minItems) {
      return `${path}: minItems ${minItems}`;
    }
    if (maxItems != null && value.length > maxItems) {
      return `${path}: maxItems ${maxItems}`;
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateAgainstSchema(items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  }
  if (typ === "string") {
    if (typeof value !== "string") return `${path}: expected string`;
    const minLength = schema.minLength as number | undefined;
    const maxLength = schema.maxLength as number | undefined;
    if (minLength != null && value.length < minLength) {
      return `${path}: minLength ${minLength}`;
    }
    if (maxLength != null && value.length > maxLength) {
      return `${path}: maxLength ${maxLength}`;
    }
    const enumVals = schema.enum as unknown[] | undefined;
    if (enumVals && !enumVals.includes(value)) {
      return `${path}: invalid enum`;
    }
    return null;
  }
  if (typ === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `${path}: expected integer`;
    }
    const minimum = schema.minimum as number | undefined;
    const maximum = schema.maximum as number | undefined;
    if (minimum != null && value < minimum) return `${path}: minimum ${minimum}`;
    if (maximum != null && value > maximum) return `${path}: maximum ${maximum}`;
    return null;
  }
  if (typ === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return `${path}: expected number`;
    return null;
  }
  if (typ === "boolean") {
    if (typeof value !== "boolean") return `${path}: expected boolean`;
    return null;
  }
  return null;
}

export function validateToolArgs(
  tool: PlaylistDiscoveryTool,
  args: Record<string, unknown>,
): ToolResult | null {
  const schema = PLAYLIST_DISCOVERY_TOOL_SCHEMAS[tool];
  const err = validateAgainstSchema(schema, args, "args");
  if (err) {
    return { status: 400, data: { error: err, code: "invalid_args" } };
  }
  if (tool === "create_playlist_draft_inventory") {
    const a = Array.isArray(args.accepted_candidate_ids) ? args.accepted_candidate_ids : [];
    const b = Array.isArray(args.playlist_ids) ? args.playlist_ids : [];
    if (!a.length && !b.length) {
      return {
        status: 400,
        data: { error: "accepted_candidate_ids or playlist_ids required", code: "invalid_args" },
      };
    }
  }
  return null;
}

function resolveTargetChannel(row: Record<string, unknown>): string | null {
  const contact = String(row.contact_method ?? "").trim().toLowerCase();
  const submission = String(row.submission_method ?? "").trim().toLowerCase();
  for (const c of [contact, submission]) {
    if ((SUBMISSION_CHANNELS as readonly string[]).includes(c)) return c;
  }
  return null;
}

function isVerifiedEligible(row: Record<string, unknown>): boolean {
  const pathOk = row.path_verified === true;
  const status = String(row.verification_status ?? "");
  return pathOk && (VERIFIED_STATUSES as readonly string[]).includes(status);
}

export async function getPlaylistDiscoveryWork(
  sb: SupabaseClient,
  ops: OpsActor,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "read_playlist_discovery_work");
  if (denied) return denied;

  const { data: campaigns, error: campErr } = await sb
    .from("pitch_campaigns")
    .select("track_id, status")
    .eq("status", "active")
    .limit(50);
  if (campErr) {
    return {
      status: 500,
      data: { error: `campaign_query_failed:${campErr.message}`, code: "db_error" },
    };
  }
  const trackIds = [...new Set((campaigns ?? []).map((c) => String(c.track_id)).filter(Boolean))];

  const tracks: Record<string, unknown>[] = [];
  if (trackIds.length) {
    const { data: rows, error: trackErr } = await sb
      .from("tracks")
      .select("id, name, approved_song_dna_version_id")
      .in("id", trackIds);
    if (trackErr) {
      return {
        status: 500,
        data: { error: `track_query_failed:${trackErr.message}`, code: "db_error" },
      };
    }
    for (const t of rows ?? []) {
      const trackId = String(t.id);
      const dna = await resolveCurrentApprovedDna(sb, { trackId });
      if (!dna.ok || !dna.songDnaVersionId) continue;
      const { data: dnaRow, error: dnaErr } = await sb
        .from("song_dna_versions")
        .select("id, short_pitch, primary_genre, approved_lanes, excluded_lanes, approval_state")
        .eq("id", dna.songDnaVersionId)
        .maybeSingle();
      if (dnaErr) {
        return {
          status: 500,
          data: { error: `dna_query_failed:${dnaErr.message}`, code: "db_error" },
        };
      }
      tracks.push({
        track_id: trackId,
        title: t.name ?? null,
        approved_song_dna_version_id: dna.songDnaVersionId,
        allowed_lanes: dna.approvedLanes,
        excluded_lanes: dna.excludedLanes,
        approved_pitch_descriptors: dnaRow?.short_pitch ? [String(dnaRow.short_pitch)] : [],
        primary_genre: dnaRow?.primary_genre ?? null,
      });
    }
  }

  const { data: profiles, error: profErr } = await sb
    .from("discovery_profiles")
    .select("id, profile_key, label, genre_family, approved_lanes, is_active, approval_status")
    .eq("is_active", true)
    .eq("approval_status", "approved")
    .limit(40);
  if (profErr) {
    return {
      status: 500,
      data: { error: `profile_query_failed:${profErr.message}`, code: "db_error" },
    };
  }

  let capacity: Record<string, unknown>;
  try {
    const plan = await buildDiscoveryCapacityPlan(sb, tracks.length || trackIds.length);
    capacity = {
      daily_raw_requirement: plan.daily_raw_requirement,
      effective_raw_target: plan.effective_raw_target,
      effective_verified_target: plan.effective_verified_target,
      active_pitching_songs: plan.active_pitching_songs,
    };
  } catch (e) {
    return {
      status: 500,
      data: {
        error: `capacity_query_failed:${String((e as Error).message || e)}`,
        code: "db_error",
      },
    };
  }

  return {
    status: 200,
    data: {
      ok: true,
      actor: ops.label,
      tracks,
      discovery_profiles: (profiles ?? []).map((p) => ({
        id: p.id,
        profile_key: p.profile_key,
        label: p.label,
        genre_family: p.genre_family ?? null,
        approved_lanes: p.approved_lanes ?? [],
      })),
      daily_target: capacity,
    },
  };
}

export async function submitPlaylistCandidates(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "submit_playlist_candidates");
  if (denied) return denied;
  if (!can(ops, "verify_playlist_targets") || !can(ops, "research_playlist_targets")) {
    return { status: 403, data: { error: "missing research/verify capability" } };
  }

  const callerCopy = rejectCallerPlaylistCopy(body);
  if (callerCopy) return callerCopy;
  if (Boolean(body.override_category_check)) {
    return {
      status: 403,
      data: {
        error: "override_category_check is forbidden for claude_playlist_discovery",
        code: "override_forbidden",
      },
    };
  }

  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };
  const candidates = Array.isArray(clean.candidates) ? clean.candidates : [];
  if (!candidates.length) return { status: 400, data: { error: "candidates[] required" } };

  const dna = await resolveCurrentApprovedDna(sb, {
    trackId,
    callerSongDnaVersionId: clean.song_dna_version_id != null
      ? String(clean.song_dna_version_id)
      : null,
  });
  if (!dna.ok) {
    return {
      status: 422,
      data: { error: dna.errors[0] ?? "dna_rejected", code: dna.errors[0], errors: dna.errors },
    };
  }

  const attr = attributionFrom(ops);
  const acceptedVerified: Record<string, unknown>[] = [];
  const acceptedUnverified: Record<string, unknown>[] = [];
  const existingClassified: Record<string, unknown>[] = [];
  const eligibleExistingIds: string[] = [];
  const duplicates: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];

  const { data: trackRow } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", trackId)
    .maybeSingle();
  const trackName = trackRow?.name != null ? String(trackRow.name) : null;

  for (const raw of candidates) {
    const c = typeof raw === "object" && raw
      ? stripSpoofedAttribution(raw as Record<string, unknown>)
      : {};
    delete c.verified;
    delete c.compatible;
    delete c.approved;
    delete c.actor_kind;
    delete c.discovered_by;

    const evidence = String(c.source_evidence ?? c.evidence ?? "").trim();
    const lane = String(c.lane ?? "").trim();
    const name = String(c.playlist_name ?? c.name ?? "").trim();
    const rawId = String(c.playlist_id ?? c.spotify_playlist_id ?? "").trim();
    // Identity comes from the playlist url only. source_url is evidence context (a
    // listicle/blog page) and is shared by many candidates — keying identity off it
    // collapsed distinct playlists into a single target.
    const rawPlaylistUrl = String(c.playlist_url ?? "").trim();
    const rawSourceUrl = String(c.source_url ?? "").trim();
    const rawUrl = rawPlaylistUrl || rawSourceUrl;

    if (!evidence) {
      rejected.push({ reason: "missing_source_evidence", playlist_id: rawId || null });
      continue;
    }
    if (!lane) {
      rejected.push({ reason: "unknown_lane_fail_closed", playlist_id: rawId || null });
      continue;
    }

    const normalized = normalizeSpotifyPlaylistIdentity(rawId, rawPlaylistUrl);
    if (!normalized && !rawId && !rawPlaylistUrl && !rawSourceUrl) {
      rejected.push({ reason: "missing_playlist_identity", candidate: c });
      continue;
    }
    if (!normalized) {
      // Fail closed: never key a target off source_url (shared across candidates) or an
      // unnormalizable raw id — that silently merges several playlists into one target.
      rejected.push({
        reason: "unresolvable_playlist_identity",
        code: "unresolvable_playlist_identity",
        playlist_id: rawId || null,
        playlist_url: rawPlaylistUrl || null,
      });
      continue;
    }
    const id = normalized.playlist_id;
    const playlistUrl = normalized.playlist_url;

    const { data: existing, error: existErr } = await sb
      .from("playlist_targets")
      .select("playlist_id")
      .eq("playlist_id", id)
      .maybeSingle();
    if (existErr) {
      rejected.push({ playlist_id: id, reason: `dedupe_query_failed:${existErr.message}` });
      continue;
    }
    if (existing) {
      const classified = await classifyExistingPlaylistTarget(sb, {
        trackId,
        playlistId: id,
        songDnaVersionId: dna.songDnaVersionId!,
        actor: ops,
        trackName,
      });
      existingClassified.push(classified);
      if (classified.classification === "classification_failed") {
        rejected.push({
          playlist_id: id,
          reason: classified.reason ?? "classification_failed",
          code: "db_error",
          classification: classified.classification,
        });
      } else if (classified.classification === "existing_verified_eligible") {
        eligibleExistingIds.push(id);
        acceptedVerified.push({
          playlist_id: id,
          lane,
          channel: classified.channel,
          path_verified: true,
          verification_status: "existing_verified",
          song_dna_version_id: dna.songDnaVersionId,
          classification: classified.classification,
          reused_existing_target: true,
        });
      } else if (classified.classification === "existing_unverified") {
        acceptedUnverified.push({
          playlist_id: id,
          channel: classified.channel,
          classification: classified.classification,
          reason: classified.reason ?? null,
          reused_existing_target: true,
        });
      } else {
        duplicates.push({
          playlist_id: id,
          reason: classified.classification,
          classification: classified.classification,
          outreach_draft_id: classified.outreach_draft_id ?? null,
          handoff_record_id: classified.handoff_record_id ?? null,
          cooldown_until: classified.cooldown_until ?? null,
        });
      }
      continue;
    }

    // Live schema requires playlist_name — reject clearly before PostgREST insert.
    if (!name) {
      rejected.push({
        reason: "missing_playlist_name",
        playlist_id: id,
        code: "playlist_name_required",
      });
      continue;
    }

    // Database-backed path/email verification — never format-only auto-verify.
    const path = await evaluateSubmissionPath(
      {
        submission_channel: c.submission_channel != null ? String(c.submission_channel) : null,
        curator_email: c.curator_email != null ? String(c.curator_email) : null,
        form_url: c.form_url != null ? String(c.form_url) : null,
        form_source_evidence: evidence,
        ig_curator_account: c.ig_curator_account != null ? String(c.ig_curator_account) : null,
        ig_source_evidence: evidence,
        submission_url: (c.form_url != null ? String(c.form_url) : null) || playlistUrl,
      },
      { sb },
    );

    const channel = path.channel;
    const formUrl = c.form_url != null ? String(c.form_url) : null;
    const igAccount = c.ig_curator_account != null ? String(c.ig_curator_account) : null;
    const curatorEmail = c.curator_email != null ? String(c.curator_email) : null;

    let row: Record<string, unknown>;
    try {
      row = buildDiscoveryPlaylistTargetInsert({
        playlistId: id,
        playlistName: name,
        lane,
        pathVerified: path.path_verified,
        verificationStatus: path.path_verified ? path.status : "unverified",
        pathReason: path.reason,
        channel,
        curatorEmail,
        formUrl,
        igAccount,
        evidence,
        discoveredBy: attr.actor_kind,
        discoveredByLabel: attr.actor_label,
        trackName,
        songDnaVersionId: dna.songDnaVersionId,
        playlistUrl,
        rawSourceUrl: rawSourceUrl || rawPlaylistUrl || null,
      });
    } catch (e) {
      rejected.push({
        playlist_id: id,
        reason: `insert_schema:${String((e as Error).message || e)}`,
        code: "playlist_targets_schema",
      });
      continue;
    }

    const { error: insErr } = await sb.from("playlist_targets").insert(row);
    if (insErr) {
      if (String(insErr.message).includes("duplicate") || insErr.code === "23505") {
        const classified = await classifyExistingPlaylistTarget(sb, {
          trackId,
          playlistId: id,
          songDnaVersionId: dna.songDnaVersionId!,
          actor: ops,
          trackName,
        });
        existingClassified.push(classified);
        if (classified.classification === "existing_verified_eligible") {
          eligibleExistingIds.push(id);
          acceptedVerified.push({
            playlist_id: id,
            lane,
            channel: classified.channel,
            path_verified: true,
            verification_status: "existing_verified",
            song_dna_version_id: dna.songDnaVersionId,
            classification: classified.classification,
            reused_existing_target: true,
          });
        } else {
          duplicates.push({
            playlist_id: id,
            reason: classified.classification,
            classification: classified.classification,
          });
        }
        continue;
      }
      rejected.push({ playlist_id: id, reason: `insert_failed:${insErr.message}` });
      continue;
    }

    const laneCheck = await enforceTrackDnaLaneEnvelope(sb, {
      route: "submit_playlist_candidates",
      trackId,
      playlistId: id,
      callerSongDnaVersionId: dna.songDnaVersionId,
      actor: ops,
    });
    if (!laneCheck.ok) {
      const { error: delErr, count: delCount } = await sb
        .from("playlist_targets")
        .delete({ count: "exact" })
        .eq("playlist_id", id);
      const delOk = assertWriteOk("rollback_incompatible_target", delErr, delCount, 1);
      if (!delOk.ok) {
        rejected.push({
          playlist_id: id,
          reason: laneCheck.errors[0] ?? "dna_lane_rejected",
          cleanup_error: delOk.error,
          errors: laneCheck.errors,
        });
        continue;
      }
      rejected.push({
        playlist_id: id,
        reason: laneCheck.errors[0] ?? "dna_lane_rejected",
        errors: laneCheck.errors,
      });
      continue;
    }

    const entry = {
      playlist_id: id,
      lane,
      channel,
      path_verified: path.path_verified,
      verification_status: path.path_verified ? path.status : "unverified",
      song_dna_version_id: dna.songDnaVersionId,
      path_reason: path.reason,
    };
    if (path.path_verified && (VERIFIED_STATUSES as readonly string[]).includes(path.status)) {
      acceptedVerified.push(entry);
    } else {
      acceptedUnverified.push(entry);
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      track_id: trackId,
      song_dna_version_id: dna.songDnaVersionId,
      accepted_count: acceptedVerified.length + acceptedUnverified.length,
      verified_eligible_count: acceptedVerified.length,
      accepted_unverified_count: acceptedUnverified.length,
      duplicate_count: duplicates.length,
      rejected_count: rejected.length,
      verified_eligible: acceptedVerified,
      accepted_unverified: acceptedUnverified,
      existing_targets: existingClassified,
      eligible_existing_playlist_ids: [...new Set(eligibleExistingIds)],
      duplicates,
      rejected,
      discovered_by: attr.actor_kind,
    },
  };
}

export type InventoryDeps = {
  /** Compose email draft content without persisting (defaults to runDraftPitch with persist:false). */
  composeDraft?: typeof runDraftPitch;
  /** Atomic persist RPC wrapper — test inject only. */
  persistInventory?: (
    sb: SupabaseClient,
    args: {
      track_id: string;
      song_dna_version_id: string;
      attr: Record<string, unknown>;
      items: Record<string, unknown>[];
    },
  ) => Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }>;
};

export async function createPlaylistDraftInventory(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
  deps: InventoryDeps = {},
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "generate_playlist_drafts");
  if (denied) return denied;
  if (!can(ops, "create_handoff_batch")) {
    return { status: 403, data: { error: "create_handoff_batch required" } };
  }

  const callerCopy = rejectCallerPlaylistCopy(body);
  if (callerCopy) return callerCopy;
  if (Boolean(body.override_category_check)) {
    return {
      status: 403,
      data: {
        error: "override_category_check is forbidden for claude_playlist_discovery",
        code: "override_forbidden",
      },
    };
  }

  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  const candidateIds = Array.isArray(clean.accepted_candidate_ids)
    ? clean.accepted_candidate_ids.map(String)
    : Array.isArray(clean.playlist_ids)
    ? clean.playlist_ids.map(String)
    : [];
  if (!trackId || !candidateIds.length) {
    return { status: 400, data: { error: "track_id and accepted_candidate_ids required" } };
  }

  const dna = await resolveCurrentApprovedDna(sb, {
    trackId,
    callerSongDnaVersionId: clean.song_dna_version_id != null
      ? String(clean.song_dna_version_id)
      : null,
  });
  if (!dna.ok) {
    return {
      status: 422,
      data: { error: dna.errors[0] ?? "dna_rejected", code: dna.errors[0], errors: dna.errors },
    };
  }
  const songDnaVersionId = dna.songDnaVersionId!;

  const { data: dnaRow, error: dnaErr } = await sb
    .from("song_dna_versions")
    .select("id, short_pitch, approval_state, primary_genre, approved_lanes, excluded_lanes")
    .eq("id", songDnaVersionId)
    .maybeSingle();
  if (dnaErr) {
    return { status: 500, data: { error: `dna_query_failed:${dnaErr.message}`, code: "db_error" } };
  }
  const pitchProbe = resolveTrackPitchCopy({ approvedDna: dnaRow, requireApprovedDna: true });
  if (!pitchProbe.ok) {
    return {
      status: 422,
      data: { error: "missing approved Song DNA pitch copy", code: "missing_track_pitch_copy" },
    };
  }

  const { data: trackRow, error: trackErr } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", trackId)
    .maybeSingle();
  if (trackErr) {
    return { status: 500, data: { error: `track_lookup_failed:${trackErr.message}`, code: "db_error" } };
  }
  const trackName = trackRow?.name != null ? String(trackRow.name) : "unknown";

  const composeDraft = deps.composeDraft ?? runDraftPitch;
  const persistInventory = deps.persistInventory ??
    ((client, args) =>
      client.rpc("agh_mcp_persist_playlist_inventory", {
        p_track_id: args.track_id,
        p_song_dna_version_id: args.song_dna_version_id,
        p_attr: args.attr,
        p_items: args.items,
      }));

  type Prepared = {
    playlist_id: string;
    channel: string;
    idempotency_key: string;
    record_kind: string;
    queue_state: string;
    draft?: Record<string, unknown>;
    packet: Record<string, unknown>;
  };

  const items: Prepared[] = [];
  const reusedPreview: Record<string, unknown>[] = [];

  for (const playlistId of candidateIds) {
    const { data: target, error: tErr } = await sb
      .from("playlist_targets")
      .select(
        "playlist_id, contact_method, submission_method, path_verified, verification_status, form_url, submission_url, curator_email, ig_curator_account, curator_instagram, lane",
      )
      .eq("playlist_id", playlistId)
      .maybeSingle();
    if (tErr) {
      return {
        status: 500,
        data: { error: `target_query_failed:${tErr.message}`, code: "db_error", playlist_id: playlistId },
      };
    }
    if (!target) {
      return {
        status: 404,
        data: { error: "playlist target not found", code: "target_not_found", playlist_id: playlistId },
      };
    }
    if (!isVerifiedEligible(target as Record<string, unknown>)) {
      return {
        status: 422,
        data: {
          error: "only verified_eligible candidates may enter draft inventory",
          code: "not_verified_eligible",
          playlist_id: playlistId,
          path_verified: target.path_verified ?? false,
          verification_status: target.verification_status ?? null,
        },
      };
    }

    const channel = resolveTargetChannel(target as Record<string, unknown>);
    if (!channel) {
      return {
        status: 422,
        data: {
          error: "unknown submission channel on target — fail closed",
          code: "unknown_channel",
          playlist_id: playlistId,
        },
      };
    }

    const envelope = await enforceTrackDnaLaneEnvelope(sb, {
      route: "create_playlist_draft_inventory",
      trackId,
      playlistId,
      callerSongDnaVersionId: songDnaVersionId,
      actor: ops,
    });
    if (!envelope.ok) {
      return {
        status: 422,
        data: {
          error: envelope.errors[0] ?? "dna_lane_rejected",
          code: envelope.errors[0],
          playlist_id: playlistId,
          errors: envelope.errors,
        },
      };
    }

    const key = inventoryIdempotencyKey(trackId, playlistId, channel, songDnaVersionId);
    const existing = await lookupInventoryPair(sb, {
      trackId,
      playlistId,
      channel,
      songDnaVersionId,
    });
    if (existing.ok === false) {
      return {
        status: existing.code === "migration_required" ? 503 : 500,
        data: {
          error: String(existing.error ?? "lookup_failed"),
          code: String(existing.code ?? "db_error"),
          playlist_id: playlistId,
        },
      };
    }
    if (existing.found) {
      reusedPreview.push({
        playlist_id: playlistId,
        channel,
        idempotency_key: key,
        outreach_draft_id: existing.outreach_draft_id ?? null,
        handoff_record_id: existing.handoff_record_id ?? null,
        batch_id: existing.batch_id ?? null,
        reused: true,
      });
      continue;
    }

    let draftPayload: Record<string, unknown> | undefined;
    let packetKind = "manual_handoff";

    if (channel === "email") {
      const composed = await composeDraft(
        {
          playlist_id: playlistId,
          track_id: trackId,
          channel: "email",
          song_dna_version_id: songDnaVersionId,
          persist: false,
          compose_only: true,
        },
        sb,
        playlistDiscoveryCredentialActor(),
        null,
      );
      if (composed.status >= 400) {
        return {
          status: composed.status,
          data: {
            ...composed.data,
            error: composed.data.error ?? "email_compose_failed",
            playlist_id: playlistId,
          },
        };
      }
      if (!composed.data.body) {
        return {
          status: 500,
          data: { error: "compose returned no body", playlist_id: playlistId },
        };
      }
      draftPayload = {
        track_name: composed.data.track_name ?? trackName,
        subject: composed.data.subject ?? null,
        body: composed.data.body,
        recipient: composed.data.recipient ?? null,
        pitch_copy_source: composed.data.pitch_copy_source ?? pitchProbe.source,
        pitch_copy_hash: composed.data.pitch_copy_hash ?? null,
        generated_by: composed.data.generated_by ?? ops.label,
        metadata: composed.data.metadata ?? {},
      };
      packetKind = "email_outreach_draft";
    } else if (channel === "web_form") {
      packetKind = "manual_web_form_packet";
    } else if (channel === "instagram_dm") {
      packetKind = "manual_ig_dm_packet";
    }

    const packet: Record<string, unknown> = {
      track_id: trackId,
      song_dna_version_id: songDnaVersionId,
      packet_kind: packetKind,
      channel,
      automated_submit: false,
      automated_dm: false,
      ops_idempotency_key: key,
    };
    if (channel === "web_form") {
      packet.form_url = target.form_url ?? target.submission_url ?? null;
    }
    if (channel === "instagram_dm") {
      packet.ig_curator_account = target.ig_curator_account ?? target.curator_instagram ?? null;
    }

    const copyProbe = rejectCallerPlaylistCopy(packet);
    if (copyProbe) return copyProbe;
    for (const k of ["pitch", "draft_body", "body", "subject", "ig_dm_draft"]) {
      if (packet[k] != null) {
        return {
          status: 500,
          data: { error: `internal: must not pass ${k} into handoff packet`, code: "copy_leak" },
        };
      }
    }

    items.push({
      playlist_id: playlistId,
      channel,
      idempotency_key: key,
      record_kind: "playlist_target",
      queue_state: "CLAUDE_BATCH_READY",
      draft: draftPayload,
      packet,
    });
  }

  const attr = attributionFrom(ops);

  if (!items.length) {
    return {
      status: 200,
      data: {
        ok: true,
        idempotent: true,
        batch_id: reusedPreview[0]?.batch_id ?? null,
        track_id: trackId,
        song_dna_version_id: songDnaVersionId,
        draft_status: "pending",
        approved: false,
        sent: false,
        discovered_by: attr.actor_kind,
        drafted_by: attr.actor_kind,
        email_drafts: reusedPreview
          .filter((r) => r.channel === "email")
          .map((r) => ({
            playlist_id: r.playlist_id,
            outreach_draft_id: r.outreach_draft_id,
            reused: true,
          })),
        manual_packets: reusedPreview
          .filter((r) => r.channel !== "email")
          .map((r) => ({ playlist_id: r.playlist_id, channel: r.channel, reused: true })),
        reused_pairs: reusedPreview,
        server_pitch_source: pitchProbe.source,
        records: { ok: true, inserted: 0, duplicates: reusedPreview.length, rows: [] },
        stored_pitch_sources: reusedPreview.map((r) => ({
          outreach_draft_id: r.outreach_draft_id ?? null,
          playlist_target_id: r.playlist_id ?? null,
          pitch_copy_source: null,
          has_server_pitch: false,
          reused: true,
        })),
      },
    };
  }

  if (reusedPreview.length) {
    return {
      status: 409,
      data: {
        error: "request mixes existing and new inventory pairs — split the call",
        code: "mixed_idempotent_set",
        existing: reusedPreview,
      },
    };
  }

  const { data: persisted, error: persistErr } = await persistInventory(sb, {
    track_id: trackId,
    song_dna_version_id: songDnaVersionId,
    attr: {
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
    },
    items,
  });

  if (persistErr) {
    if (/could not find|does not exist|PGRST202/i.test(persistErr.message)) {
      return {
        status: 503,
        data: {
          error: "migration_required",
          code: "migration_required",
          detail: "agh_mcp_persist_playlist_inventory RPC unavailable",
        },
      };
    }
    return {
      status: 500,
      data: { error: `persist_failed:${persistErr.message}`, code: "db_error" },
    };
  }

  const result = (persisted ?? {}) as Record<string, unknown>;
  if (!result.ok) {
    return {
      status: result.code === "conflict" ? 409 : 500,
      data: {
        error: String(result.error ?? "persist_rejected"),
        code: String(result.code ?? "persist_failed"),
        detail: result,
      },
    };
  }

  const resultItems = (result.items as Record<string, unknown>[]) ?? [];
  return {
    status: 200,
    data: {
      ok: true,
      idempotent: Boolean(result.idempotent),
      batch_id: result.batch_id ?? null,
      track_id: trackId,
      song_dna_version_id: songDnaVersionId,
      draft_status: "pending",
      approved: false,
      sent: false,
      discovered_by: attr.actor_kind,
      drafted_by: attr.actor_kind,
      email_drafts: result.email_drafts ?? [],
      manual_packets: result.manual_packets ?? [],
      reused_pairs: resultItems.filter((i) => i.reused),
      server_pitch_source: pitchProbe.source,
      records: {
        ok: true,
        inserted: result.inserted ?? 0,
        record_count: result.record_count ?? 0,
        rows: resultItems,
      },
      stored_pitch_sources: resultItems.map((r) => ({
        outreach_draft_id: r.outreach_draft_id ?? null,
        playlist_target_id: r.playlist_id ?? null,
        pitch_copy_source: pitchProbe.source,
        has_server_pitch: true,
        reused: Boolean(r.reused),
      })),
      race_resolved: result.race_resolved ?? false,
    },
  };
}

export async function startClaudePlaylistStation(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "run_daily_station");
  if (denied) return denied;
  const stationId = String(body.station_id ?? "").trim();
  if (!isClaudeStationId(stationId)) {
    return {
      status: 403,
      data: {
        error:
          `claude_playlist_discovery may only start Claude stations: ${CLAUDE_STATION_IDS.join(", ")}`,
        code: "station_ownership",
      },
    };
  }
  // Trusted actor — no synthetic secret Request.
  return startDailyStationRun(sb, body, playlistDiscoveryCredentialActor(), null);
}

export async function completeClaudePlaylistStation(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "run_daily_station");
  if (denied) return denied;

  // Pass status / counts / shortfall / error_summary through to completeDailyStationRun.
  // completed + playlist_tranche_final still requires a real owned output_batch_id;
  // failed / blocked / partial may close without inventing a batch.
  const clean = stripSpoofedAttribution(body);
  if (clean.notes != null && clean.metrics == null) {
    // Preserve operator notes without inventing station metrics.
    clean.metrics = { notes: String(clean.notes) };
  }
  return completeDailyStationRun(sb, clean, playlistDiscoveryCredentialActor(), null);
}

export async function getOwnPlaylistBatches(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "read_own_playlist_batches");
  if (denied) return denied;
  const limit = Math.min(Number(body.limit) || 40, 100);
  const { data, error } = await sb
    .from("agh_handoff_batches")
    .select(
      "id, batch_kind, queue_state, track_id, song_dna_version_id, record_count, discovered_by, drafted_by, business_date_ct, created_at, updated_at",
    )
    .eq("discovered_by", "claude_playlist_discovery")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { status: 500, data: { error: error.message, code: "db_error" } };
  return {
    status: 200,
    data: {
      ok: true,
      rows: data ?? [],
      scoped_to: "claude_playlist_discovery",
    },
  };
}

export async function runPlaylistDiscoveryTool(
  tool: string,
  args: Record<string, unknown>,
  sb: SupabaseClient,
  ops: OpsActor = playlistDiscoveryActor(),
): Promise<ToolResult> {
  if (ops.kind !== "claude_playlist_discovery") {
    return {
      status: 403,
      data: { error: "playlist discovery tools require claude_playlist_discovery identity" },
    };
  }
  if (!isPlaylistDiscoveryTool(tool)) {
    return {
      status: 400,
      data: { error: `Unknown MCP tool: ${tool}`, code: "unknown_tool" },
    };
  }
  const argErr = validateToolArgs(tool, args);
  if (argErr) return argErr;

  switch (tool) {
    case "get_playlist_discovery_work":
      return getPlaylistDiscoveryWork(sb, ops);
    case "submit_playlist_candidates":
      return submitPlaylistCandidates(sb, ops, args);
    case "create_playlist_draft_inventory":
      return createPlaylistDraftInventory(sb, ops, args);
    case "start_claude_playlist_station":
      return startClaudePlaylistStation(sb, ops, args);
    case "complete_claude_playlist_station":
      return completeClaudePlaylistStation(sb, ops, args);
    case "get_own_playlist_batches":
      return getOwnPlaylistBatches(sb, ops, args);
    default:
      return { status: 400, data: { error: `Unknown MCP tool: ${tool}`, code: "unknown_tool" } };
  }
}

export { reviewHandoffBatch };
