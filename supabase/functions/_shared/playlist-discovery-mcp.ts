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
import { buildDiscoveryCapacityPlan, dailyTargetFromPlan } from "./discovery-capacity.ts";
import { allocateDiscovery, buildPerSongFunnel } from "./playlist-funnel.ts";
import { enforceTrackDnaLaneEnvelope, resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import { resolveTrackPitchCopy } from "./pitch-copy.ts";
import { rejectCallerPlaylistCopy } from "./pitch-descriptor-guard.ts";
import { evaluateSubmissionPath, isValidFormUrl, isValidIgAccount } from "./multichannel-path.ts";
import {
  assertSubmissionReady,
  assessSubmissionRoute,
  releaseRouteHoldsForTarget,
  routeActionability,
  submissionTerms,
} from "./submission-route.ts";
import { curatorContactContext } from "./curator-contact.ts";
import { decideLaneFit, type ApprovedDnaLanes } from "./song-fit.ts";
import {
  advanceClaudeReadyBatches,
  batchStatusSummary,
  CLAUDE_SIDE_STATES,
  type HandoffQueueState,
  loadBatchRecordCounts,
  reviewHandoffBatch,
} from "./handoff-queues.ts";
import { startDailyStationRun, completeDailyStationRun } from "./daily-ops.ts";
import { CLAUDE_STATION_IDS, chicagoBusinessDate, isClaudeStationId } from "./chicago-time.ts";
import {
  normalizeSpotifyPlaylistIdentity,
  parseSpotifyPlaylistId,
  playlistTargetKeyAliases,
} from "./discovery-utils.ts";
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
  /**
   * false for route-only targets (first-party route + name verified, no platform id).
   * Persisted in research_context.identity_resolved so review/dedupe can tell them apart.
   */
  identityResolved?: boolean;
  /** As read off the source page; null/undefined = unknown (stored as null, not 0 / ""). */
  curatorName?: string | null;
  followerCount?: number | null;
  submissionTerms?: string | null;
  loginRequired?: boolean | null;
}): Record<string, unknown> {
  const researchContext: Record<string, unknown> = {
    source: "claude_playlist_discovery",
    discovered_at: new Date().toISOString(),
    identity_resolved: opts.identityResolved !== false,
  };
  if (opts.identityResolved === false) researchContext.identity_kind = "route_only";
  // Who/what verified the route: the server's shared route rules on the submitted evidence.
  if (opts.pathVerified) researchContext.route_verified_by = "server_route_rules";
  const terms = ["free", "paid", "tip_appreciated"].includes(String(opts.submissionTerms ?? ""))
    ? String(opts.submissionTerms)
    : "unknown";
  const followers = typeof opts.followerCount === "number" && Number.isFinite(opts.followerCount) && opts.followerCount >= 0
    ? Math.floor(opts.followerCount)
    : null;
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
    submission_cost: terms,
    form_login_required: typeof opts.loginRequired === "boolean" ? opts.loginRequired : null,
    curator_name: opts.curatorName && String(opts.curatorName).trim() ? String(opts.curatorName).trim() : null,
    // Explicit null: the column defaults to 0, which reads as "zero followers" instead of unknown.
    follower_count: followers,
    last_verified_at: opts.pathVerified ? new Date().toISOString() : null,
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
  "advance_playlist_batches",
  "get_batch_candidates",
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
            // Only values read off the source — omit when unknown (stored as null, never invented).
            curator_name: { type: "string", maxLength: 256 },
            follower_count: { type: "integer", minimum: 0, maximum: 1000000000 },
            submission_terms: { type: "string", enum: ["free", "paid", "tip_appreciated", "unknown"] },
            login_required: { type: "boolean" },
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
  advance_playlist_batches: {
    type: "object",
    required: ["batch_ids"],
    additionalProperties: false,
    properties: {
      batch_ids: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  },
  get_batch_candidates: {
    type: "object",
    required: ["batch_id"],
    additionalProperties: false,
    properties: {
      batch_id: { type: "string", minLength: 1, maxLength: 64 },
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
  // Flag + status + the stored route itself must pass (catches pre-fix false verifications).
  return assertSubmissionReady(row).ok;
}

/** Prefix for route-only playlist_targets ids (never 22-char Spotify-shaped). */
export const ROUTE_ONLY_ID_PREFIX = "route-";

export type RouteOnlyIdentity = {
  playlist_id: string;
  channel: "email" | "web_form" | "instagram_dm";
  /** Normalized route value used for identity and dedupe. */
  route: string;
  /** Raw route value as supplied (for exact-match dedupe against older rows). */
  raw_route: string;
  column: "curator_email" | "form_url" | "ig_curator_account";
};

function normalizePlaylistName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeFormUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    }
    const path = u.pathname.replace(/\/+$/, "");
    const q = u.searchParams.toString();
    return `${u.protocol}//${u.host.toLowerCase()}${path}${q ? `?${q}` : ""}`;
  } catch {
    return raw.trim();
  }
}

async function sha256HexShort(input: string, len = 32): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

/**
 * Deterministic identity for a candidate with no resolvable platform id but a
 * first-party route + playlist name. Returns null when either is missing.
 * The id is stable for (channel, normalized route, normalized name), so resubmitting
 * the same curator route + playlist dedupes onto the same target.
 */
export async function routeOnlyPlaylistIdentity(opts: {
  playlistName: string;
  submissionChannel?: string | null;
  curatorEmail?: string | null;
  formUrl?: string | null;
  igAccount?: string | null;
}): Promise<RouteOnlyIdentity | null> {
  const name = normalizePlaylistName(opts.playlistName ?? "");
  if (!name) return null;
  const email = String(opts.curatorEmail ?? "").trim();
  const form = String(opts.formUrl ?? "").trim();
  const ig = String(opts.igAccount ?? "").trim();
  const requested = String(opts.submissionChannel ?? "").trim().toLowerCase();

  const pick = (ch: string): RouteOnlyIdentity["channel"] | null => {
    if (ch === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "email";
    if (ch === "web_form" && isValidFormUrl(form)) return "web_form";
    if (ch === "instagram_dm" && isValidIgAccount(ig)) return "instagram_dm";
    return null;
  };
  const channel = requested
    ? pick(requested)
    : pick("email") ?? pick("web_form") ?? pick("instagram_dm");
  if (!channel) return null;

  let route: string;
  let raw: string;
  let column: RouteOnlyIdentity["column"];
  if (channel === "email") {
    raw = email;
    route = email.toLowerCase();
    column = "curator_email";
  } else if (channel === "web_form") {
    raw = form;
    route = normalizeFormUrl(form);
    column = "form_url";
  } else {
    raw = ig;
    route = ig.replace(/^@/, "").toLowerCase();
    column = "ig_curator_account";
  }
  const hash = await sha256HexShort(`${channel}|${route}|${name}`);
  return { playlist_id: `${ROUTE_ONLY_ID_PREFIX}${hash}`, channel, route, raw_route: raw, column };
}

/**
 * Dedupe a route-only candidate against existing catalog rows that share its route and
 * playlist name (e.g. a row that already has a real Spotify id). Query errors surface.
 */
async function findExistingTargetByRoute(
  sb: SupabaseClient,
  route: RouteOnlyIdentity,
  playlistName: string,
): Promise<{ playlist_id: string | null; error: string | null }> {
  const values = [...new Set([route.raw_route, route.route].filter(Boolean))];
  const { data, error } = await sb
    .from("playlist_targets")
    .select("playlist_id, playlist_name")
    .in(route.column, values)
    .limit(50);
  if (error) return { playlist_id: null, error: error.message };
  const want = normalizePlaylistName(playlistName);
  const hit = (data ?? []).find((r) =>
    normalizePlaylistName(String(r.playlist_name ?? "")) === want
  );
  return { playlist_id: hit?.playlist_id ? String(hit.playlist_id) : null, error: null };
}

/**
 * Re-verify an existing catalog row's submission route with fresh candidate evidence.
 * manually_verified rows keep their status (the human verification stands); other rows
 * become auto_verified only when the route passes the shared rules. Valid stored route
 * values are never overwritten; a stored value that FAILS the shared route rules (e.g. a
 * Spotify playlist URL in form_url) may be replaced, and the old value is kept in
 * path_verification_notes for audit. Lane/DNA/pair eligibility is re-checked by the caller.
 */
export async function reverifyManuallyVerifiedTarget(
  sb: SupabaseClient,
  ops: OpsActor,
  opts: { playlistId: string; evidence: string; candidate: Record<string, unknown> },
): Promise<
  | { ok: true; reverified: boolean; reason: string; channel: string | null }
  | { ok: false; error: string }
> {
  const { data: row, error } = await sb
    .from("playlist_targets")
    .select(
      "playlist_id, verification_status, path_verified, contact_method, submission_method, curator_email, form_url, submission_url, ig_curator_account, curator_instagram, form_source_evidence, ig_source_evidence, research_context",
    )
    .eq("playlist_id", opts.playlistId)
    .maybeSingle();
  if (error) return { ok: false, error: `manual_reverify_lookup_failed:${error.message}` };
  if (!row) {
    return { ok: true, reverified: false, reason: "target_missing", channel: null };
  }
  const priorStatus = String(row.verification_status ?? "");
  const c = opts.candidate;
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const rowFormOk = !!str(row.form_url) &&
    assessSubmissionRoute(
      { form_url: row.form_url, form_source_evidence: row.form_source_evidence, research_context: row.research_context },
      "web_form",
    ).ok;
  const email = str(row.curator_email) || str(c.curator_email);
  const form = (rowFormOk ? str(row.form_url) : "") || str(c.form_url);
  const ig = str(row.ig_curator_account) || str(row.curator_instagram) || str(c.ig_curator_account);
  const rowChannel = resolveTargetChannel(row as Record<string, unknown>);
  // The stored channel wins only when the row actually holds a route value for it.
  const rowHasRoute = (rowChannel === "email" && !!str(row.curator_email)) ||
    (rowChannel === "web_form" && rowFormOk) ||
    (rowChannel === "instagram_dm" && !!(str(row.ig_curator_account) || str(row.curator_instagram)));
  const channel = (rowHasRoute ? rowChannel : null) ?? (str(c.submission_channel) || rowChannel || null);
  // Same-host proof can come from the page the evidence was read on, as for new targets.
  // The candidate's source_url wins over the stored one; it is saved below so the stored
  // row keeps passing the shared route rule (agh_route_failure_code reads it).
  const rc0 = (row.research_context && typeof row.research_context === "object" ? row.research_context : {}) as Record<string, unknown>;
  const candSource = /^https?:\/\//i.test(str(c.source_url)) ? str(c.source_url) : "";
  const sourceUrl = candSource || str(rc0.source_url) || null;

  const path = await evaluateSubmissionPath(
    {
      submission_channel: channel,
      curator_email: email || null,
      form_url: form || null,
      form_source_evidence: opts.evidence,
      ig_curator_account: ig || null,
      ig_source_evidence: opts.evidence,
      // Only a real form URL counts; legacy submission_url often holds the playlist URL.
      submission_url: form || null,
      source_url: sourceUrl,
    },
    { sb },
  );
  if (!path.path_verified || !path.channel) {
    return { ok: true, reverified: false, reason: path.reason, channel: path.channel };
  }

  const replacedForm = str(row.form_url) && !rowFormOk && form && form !== str(row.form_url)
    ? ` (replaced invalid form_url ${str(row.form_url)})`
    : "";
  const patch: Record<string, unknown> = {
    path_verified: true,
    path_verification_notes: `re-verified by ${ops.label}: ${path.reason}${replacedForm}`,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!rowChannel || rowChannel !== path.channel) {
    patch.contact_method = path.channel;
    patch.submission_method = path.channel;
  }
  if (!str(row.curator_email) && email) patch.curator_email = email;
  if ((!str(row.form_url) || !rowFormOk) && form) {
    patch.form_url = form;
    patch.submission_url = form;
  }
  if (priorStatus !== "manually_verified") patch.verification_status = path.status;
  if (!str(row.ig_curator_account) && ig) patch.ig_curator_account = ig;
  // Store the evidence that actually verified the route. Keeping older evidence that the
  // shared rule rejects left rows path_verified=true that fail agh_route_failure_code, so
  // agh_route_recertify_targets kept demoting them again. Prior evidence is kept for audit.
  const evidenceKey = path.channel === "web_form" ? "form_source_evidence" : path.channel === "instagram_dm" ? "ig_source_evidence" : null;
  let rcPatch: Record<string, unknown> | null = null;
  if (evidenceKey && str(opts.evidence) && str(opts.evidence) !== str(row[evidenceKey])) {
    patch[evidenceKey] = opts.evidence;
    if (str(row[evidenceKey])) rcPatch = { ...rc0, [`prior_${evidenceKey}`]: row[evidenceKey] };
  }
  if (path.channel === "web_form" && candSource && candSource !== str(rc0.source_url)) {
    rcPatch = { ...(rcPatch ?? rc0), source_url: candSource };
    if (str(rc0.source_url)) rcPatch.prior_source_url = rc0.source_url;
  }
  if (rcPatch) patch.research_context = rcPatch;
  const schemaErr = Object.keys(patch).find((k) => !PLAYLIST_TARGETS_SCHEMA_INSERT_KEYS.has(k));
  if (schemaErr) return { ok: false, error: `manual_reverify_schema:unknown_key:${schemaErr}` };

  const { error: upErr, count } = await sb
    .from("playlist_targets")
    .update(patch, { count: "exact" })
    .eq("playlist_id", opts.playlistId);
  const w = assertWriteOk("manual_reverify_update", upErr, count, 1);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, reverified: true, reason: path.reason, channel: path.channel };
}

/**
 * Find the stored playlist_targets key for a canonical Spotify playlist id across its
 * legitimate key forms. More than one stored form = collision (never merged silently).
 */
export async function resolvePlaylistTargetKey(
  sb: SupabaseClient,
  canonicalId: string,
): Promise<{ key: string | null; collision: boolean; keys: string[]; error?: string }> {
  const aliases = playlistTargetKeyAliases(canonicalId);
  const { data, error } = await sb.from("playlist_targets").select("playlist_id").in("playlist_id", aliases);
  if (error) return { key: null, collision: false, keys: [], error: error.message };
  const keys = [...new Set(((data ?? []) as { playlist_id: string }[]).map((r) => String(r.playlist_id)))];
  if (keys.length > 1) {
    const { data: canonical, error: aliasError } = await sb.rpc("agh_resolve_playlist_alias", { p_id: canonicalId });
    if (!aliasError && typeof canonical === "string" && keys.includes(canonical))
      return { key: canonical, collision: false, keys };
    return { key: null, collision: true, keys };
  }
  return { key: keys[0] ?? null, collision: false, keys };
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

  // Measurement failures are surfaced inside daily_target (measurement_status /
  // warnings) rather than failing the whole projection — the objective stays usable.
  let capacity: Record<string, unknown>;
  let perSong: Record<string, unknown>;
  try {
    const plan = await buildDiscoveryCapacityPlan(sb, tracks.length || trackIds.length);
    capacity = dailyTargetFromPlan(plan);
    const r2v = plan.funnel.raw_to_verified;
    const funnel = await buildPerSongFunnel(
      sb,
      tracks.map((t) => ({ track_id: String(t.track_id), title: (t.title as string | null) ?? null })),
      {
        objectivePerSong: plan.target_verified_per_song_per_day,
        rawToEligibleRate: r2v.status === "measured" ? r2v.rate : null,
      },
    );
    perSong = {
      business_goal: "actual submissions per song per CT business day (drafts/reviews/approvals are not submissions)",
      raw_unit: "distinct song–playlist candidate evaluated per day",
      yield_basis: r2v.source,
      evaluation_log_available: funnel.evaluation_log_available,
      songs: funnel.songs,
      discovery_allocation: {
        rule: "Allocate further discovery by each song's own remaining need; one song's surplus never offsets another song's shortfall.",
        songs: allocateDiscovery(funnel.songs),
      },
      capacity_exclusion_rule:
        "Discovery headroom ignores Soundplate (frozen route), route-repair batches, REJECTED_* and SENT records, unsent IG DMs, and any packet that fails the contact-policy check. Those counts are capacity_exclusions on each song. Soundplate stays frozen, and cooldown rules are unchanged.",
      errors: funnel.errors,
      limits: {
        max_candidates_per_submit_call: 50,
        note:
          "Work through raw_candidates_needed in calls of ≤50. If you must stop before a song's need is met (time, sources saturated, tool errors), close the station with status partial and a shortfall_reason — never report the target as met.",
      },
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
      per_song_funnel: perSong,
      manually_verified_supply: await loadManuallyVerifiedSupply(sb),
    },
  };
}

/**
 * Catalog rows a human marked manually_verified that are not yet draftable by this
 * actor (no verified submission path / no known channel). Submitting one of these
 * playlist_ids through submit_playlist_candidates re-verifies its route and, if it
 * passes (plus the normal lane/DNA/pair checks), makes it draftable.
 */
async function loadManuallyVerifiedSupply(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await sb
    .from("playlist_targets")
    .select(
      "playlist_id, playlist_name, lane, contact_method, submission_method, path_verified, curator_email, form_url, ig_curator_account",
    )
    .eq("verification_status", "manually_verified")
    .eq("is_active", true)
    .limit(200);
  if (error) {
    return { status: "query_failed", error: error.message, rows: [] };
  }
  const needsReverify = (data ?? []).filter((r) =>
    r.path_verified !== true || resolveTargetChannel(r as Record<string, unknown>) == null
  );
  return {
    status: "ok",
    total_scanned: (data ?? []).length,
    needs_reverify_count: needsReverify.length,
    rows: needsReverify.slice(0, 25).map((r) => ({
      playlist_id: r.playlist_id,
      playlist_name: r.playlist_name ?? null,
      lane: r.lane ?? null,
      channel: resolveTargetChannel(r as Record<string, unknown>),
      path_verified: r.path_verified === true,
      has_email: Boolean(r.curator_email),
      has_form_url: Boolean(r.form_url),
      has_ig: Boolean(r.ig_curator_account),
    })),
    how_to_use:
      "Submit the playlist_id (plus lane, source_evidence and the route fields) via submit_playlist_candidates to re-verify and make it draftable.",
  };
}

type EvalSnapshot = { v: number; u: number; d: number; r: number; f: number };

/** Stable identity key for a candidate that never resolved to a stored target. */
function candidateFallbackKey(raw: unknown): string {
  const c = (typeof raw === "object" && raw ? raw : {}) as Record<string, unknown>;
  const parts = [c.playlist_id, c.spotify_playlist_id, c.playlist_url, c.form_url, c.curator_email, c.ig_curator_account, c.playlist_name ?? c.name]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? `unresolved:${parts.join("|").slice(0, 400)}` : "unresolved:empty";
}

/**
 * Best-effort candidate evaluation log (agh_log_candidate_evaluation RPC). A missing RPC
 * (migration not applied) disables logging for the rest of the call; discovery itself is
 * never blocked by logging.
 */
function createEvaluationLogger(sb: SupabaseClient, trackId: string) {
  const businessDate = chicagoBusinessDate();
  let disabled = false;
  const warnings: string[] = [];
  return {
    warnings,
    async record(opts: {
      key: string;
      before: EvalSnapshot;
      after: EvalSnapshot;
      verified: Record<string, unknown>[];
      rejected: Record<string, unknown>[];
      deferred: Record<string, unknown>[];
      createdTarget: boolean;
    }) {
      if (disabled) return;
      let outcome: string;
      let reason: string | null = null;
      if (opts.after.v > opts.before.v) {
        const entry = opts.verified[opts.verified.length - 1] ?? {};
        outcome = entry.reused_existing_target ? "verified_eligible_existing" : "verified_eligible_new";
      } else if (opts.after.u > opts.before.u) outcome = "accepted_unverified";
      else if (opts.after.d > opts.before.d) outcome = "duplicate";
      else if (opts.after.f > opts.before.f) {
        // Cooldown / temporary host or DB failure: retry later, not a target rejection.
        outcome = "deferred";
        const last = opts.deferred[opts.deferred.length - 1] ?? {};
        reason = String(last.code ?? last.reason ?? "").slice(0, 120) || null;
      }
      else if (opts.after.r > opts.before.r) {
        outcome = "rejected";
        const last = opts.rejected[opts.rejected.length - 1] ?? {};
        reason = String(last.code ?? last.reason ?? "").slice(0, 120) || null;
      } else return;
      const { error } = await sb.rpc("agh_log_candidate_evaluation", {
        p_business_date: businessDate,
        p_track_id: trackId,
        p_identity_key: opts.key,
        p_playlist_target_id: opts.key.startsWith("unresolved:") ? null : opts.key,
        p_outcome: outcome,
        p_reason_code: reason,
        p_created_target: opts.createdTarget,
      });
      if (error) {
        disabled = true;
        warnings.push(`candidate evaluation log unavailable: ${error.message}`);
      }
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
  // Retry/defer, never a permanent rejection: pair cooldowns, temporary host (MX/DNS)
  // failures, and transient DB errors while classifying an existing target.
  const deferred: Record<string, unknown>[] = [];

  const { data: trackRow } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", trackId)
    .maybeSingle();
  const trackName = trackRow?.name != null ? String(trackRow.name) : null;

  // Server-side raw denominator: one row per (day, song, candidate identity).
  const evalLog = createEvaluationLogger(sb, trackId);
  for (const raw of candidates) {
    const before = {
      v: acceptedVerified.length,
      u: acceptedUnverified.length,
      d: duplicates.length,
      r: rejected.length,
      f: deferred.length,
    };
    let logKey: string | null = null;
    let createdTarget = false;
    try {
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

      // Wrong Spotify entity types (track/album/artist) are never playlist identities.
      const idParse = parseSpotifyPlaylistId(rawId);
      const urlParse = parseSpotifyPlaylistId(rawPlaylistUrl);
      if (
        (!idParse.ok && idParse.code === "wrong_entity_type") ||
        (!urlParse.ok && urlParse.code === "wrong_entity_type")
      ) {
        rejected.push({
          reason: "wrong_spotify_entity_type",
          code: "wrong_spotify_entity_type",
          playlist_id: rawId || null,
          playlist_url: rawPlaylistUrl || null,
          entity: (!idParse.ok && idParse.entity) || (!urlParse.ok && urlParse.entity) || null,
        });
        continue;
      }
      const normalized = normalizeSpotifyPlaylistIdentity(rawId, rawPlaylistUrl);
      let id: string;
      let playlistUrl: string | null;
      // false only for a NEW route-only target (no platform id, route + name verified).
      let identityResolved = true;

      if (normalized) {
        // The same playlist may already be stored as `ID`, `spotify:ID` or
        // `spotify:playlist:ID` (all legitimate key forms here). Reuse the stored key.
        const alias = await resolvePlaylistTargetKey(sb, normalized.playlist_id);
        if (alias.error) {
          rejected.push({ playlist_id: normalized.playlist_id, reason: `dedupe_query_failed:${alias.error}` });
          continue;
        }
        if (alias.collision) {
          rejected.push({
            playlist_id: normalized.playlist_id,
            reason: "identity_alias_collision",
            code: "identity_alias_collision",
            stored_keys: alias.keys,
            detail: "the same Spotify playlist is stored under more than one key — resolve with the existing dedupe process",
          });
          continue;
        }
        id = alias.key ?? normalized.playlist_id;
        playlistUrl = normalized.playlist_url;
      } else {
        // (a) Direct reference to an existing catalog row by its stored playlist_id
        //     (catalog rows are not always Spotify-shaped, e.g. form-only curators).
        let catalogId: string | null = null;
        if (rawId) {
          const { data: cat, error: catErr } = await sb
            .from("playlist_targets")
            .select("playlist_id")
            .eq("playlist_id", rawId)
            .maybeSingle();
          if (catErr) {
            rejected.push({ playlist_id: rawId, reason: `dedupe_query_failed:${catErr.message}` });
            continue;
          }
          if (cat) catalogId = rawId;
        }

        if (catalogId) {
          id = catalogId;
          playlistUrl = null;
        } else {
          // (b) Route-only identity: first-party route + playlist name + evidence.
          const route = await routeOnlyPlaylistIdentity({
            playlistName: name,
            submissionChannel: c.submission_channel != null ? String(c.submission_channel) : null,
            curatorEmail: c.curator_email != null ? String(c.curator_email) : null,
            formUrl: c.form_url != null ? String(c.form_url) : null,
            igAccount: c.ig_curator_account != null ? String(c.ig_curator_account) : null,
          });
          if (!route) {
            if (!rawId && !rawPlaylistUrl && !rawSourceUrl) {
              rejected.push({ reason: "missing_playlist_identity", candidate: c });
              continue;
            }
            // Fail closed: never key a target off source_url (shared across candidates) or an
            // unnormalizable raw id — that silently merges several playlists into one target.
            rejected.push({
              reason: "unresolvable_playlist_identity",
              code: "unresolvable_playlist_identity",
              detail:
                "need a Spotify playlist id/url, an existing catalog playlist_id, or playlist_name + a first-party route (curator_email, form_url or ig_curator_account)",
              playlist_id: rawId || null,
              playlist_url: rawPlaylistUrl || null,
            });
            continue;
          }
          const match = await findExistingTargetByRoute(sb, route, name);
          if (match.error) {
            rejected.push({ playlist_id: route.playlist_id, reason: `dedupe_query_failed:${match.error}` });
            continue;
          }
          if (match.playlist_id) {
            id = match.playlist_id;
          } else {
            id = route.playlist_id;
            identityResolved = false;
          }
          playlistUrl = null;
        }
      }

      logKey = id;
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
        let classified = await classifyExistingPlaylistTarget(sb, {
          trackId,
          playlistId: id,
          songDnaVersionId: dna.songDnaVersionId!,
          actor: ops,
          trackName,
        });
        // manually_verified catalog rows are supply, not just dedupe fodder: re-verify the
        // route (fresh evidence) and re-classify under the normal lane/DNA/pair checks.
        let manualReverify: Record<string, unknown> | null = null;
        // Also covers rows whose stored route fails the shared route rules.
        if (
          classified.classification === "existing_unverified" ||
          (classified.classification === "existing_verified_eligible" && !classified.channel)
        ) {
          const re = await reverifyManuallyVerifiedTarget(sb, ops, {
            playlistId: id,
            evidence,
            candidate: c,
          });
          if (!re.ok) {
            rejected.push({
              playlist_id: id,
              reason: re.error,
              code: "db_error",
              classification: "manual_reverify_failed",
            });
            continue;
          }
          manualReverify = { reverified: re.reverified, reason: re.reason, channel: re.channel };
          if (re.reverified) {
            // Records held for this target's bad route can go back through review now.
            const rel = await releaseRouteHoldsForTarget(sb, id, ops.label);
            if (rel.released.length || rel.error) {
              manualReverify.route_holds_released = rel.released;
              if (rel.error) manualReverify.route_hold_release_error = rel.error;
            }
            classified = await classifyExistingPlaylistTarget(sb, {
              trackId,
              playlistId: id,
              songDnaVersionId: dna.songDnaVersionId!,
              actor: ops,
              trackName,
            });
          }
        }
        existingClassified.push(manualReverify ? { ...classified, manual_reverify: manualReverify } : classified);
        if (classified.classification === "classification_failed") {
          deferred.push({
            playlist_id: id,
            reason: classified.reason ?? "classification_failed",
            code: "temporary_db_error",
            classification: classified.classification,
            retry: "resubmit this candidate later",
          });
        } else if (classified.classification === "existing_pair_cooldown") {
          deferred.push({
            playlist_id: id,
            reason: "song–playlist pair is in its pitch cooldown",
            code: "pair_cooldown",
            classification: classified.classification,
            retry_after: classified.cooldown_until ?? null,
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
            ...(manualReverify?.reverified ? { reverified_manual_target: true } : {}),
          });
        } else if (classified.classification === "existing_unverified") {
          acceptedUnverified.push({
            playlist_id: id,
            channel: classified.channel,
            classification: classified.classification,
            reason: classified.reason ?? null,
            reused_existing_target: true,
            ...(manualReverify ? { manual_reverify: manualReverify } : {}),
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
          // Never fall back to the playlist's own URL: a playlist page is not a route.
          submission_url: c.form_url != null ? String(c.form_url) : null,
          playlist_url: playlistUrl,
          source_url: rawSourceUrl || null,
        },
        { sb },
      );

      if (path.retryable) {
        // Temporary host failure (e.g. MX lookup error) — don't store an unverified row
        // that would never be re-checked; defer and let the candidate be resubmitted.
        deferred.push({
          playlist_id: id,
          reason: path.reason,
          code: "temporary_host_failure",
          retry: "resubmit this candidate later",
        });
        continue;
      }

      if (!identityResolved && !path.path_verified) {
        // Route-only candidates are accepted only on a verified first-party route —
        // without it there is neither a platform identity nor a usable route.
        rejected.push({
          reason: "unresolvable_playlist_identity",
          code: "unresolvable_playlist_identity",
          detail: "route-only candidate (no platform id) requires a verified first-party route",
          path_reason: path.reason,
          playlist_id: id,
          identity_resolved: false,
        });
        continue;
      }

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
          identityResolved,
          curatorName: c.curator_name != null ? String(c.curator_name) : null,
          followerCount: typeof c.follower_count === "number" ? c.follower_count : null,
          submissionTerms: c.submission_terms != null ? String(c.submission_terms) : null,
          loginRequired: typeof c.login_required === "boolean" ? c.login_required : null,
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
          } else if (classified.classification === "existing_pair_cooldown") {
            deferred.push({
              playlist_id: id,
              reason: "song–playlist pair is in its pitch cooldown",
              code: "pair_cooldown",
              classification: classified.classification,
              retry_after: classified.cooldown_until ?? null,
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

      createdTarget = true;
      const entry = {
        playlist_id: id,
        lane,
        channel,
        path_verified: path.path_verified,
        verification_status: path.path_verified ? path.status : "unverified",
        song_dna_version_id: dna.songDnaVersionId,
        path_reason: path.reason,
        identity_resolved: identityResolved,
      };
      if (path.path_verified && (VERIFIED_STATUSES as readonly string[]).includes(path.status)) {
        acceptedVerified.push(entry);
      } else {
        acceptedUnverified.push(entry);
      }
    } finally {
      await evalLog.record({
        key: logKey ?? candidateFallbackKey(raw),
        before,
        after: {
          v: acceptedVerified.length,
          u: acceptedUnverified.length,
          d: duplicates.length,
          r: rejected.length,
          f: deferred.length,
        },
        verified: acceptedVerified,
        rejected,
        deferred,
        createdTarget,
      });
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      track_id: trackId,
      song_dna_version_id: dna.songDnaVersionId,
      // Intake into verification — NOT playlist submissions. A submission is only an
      // email with a provider id or a manual form/DM with submitted_at (per_song_funnel).
      candidates_submitted_for_verification: candidates.length,
      accepted_count: acceptedVerified.length + acceptedUnverified.length,
      verified_eligible_count: acceptedVerified.length,
      accepted_unverified_count: acceptedUnverified.length,
      duplicate_count: duplicates.length,
      rejected_count: rejected.length,
      deferred_count: deferred.length,
      verified_eligible: acceptedVerified,
      accepted_unverified: acceptedUnverified,
      existing_targets: existingClassified,
      eligible_existing_playlist_ids: [...new Set(eligibleExistingIds)],
      duplicates,
      rejected,
      deferred,
      discovered_by: attr.actor_kind,
      ...(evalLog.warnings.length ? { warnings: evalLog.warnings } : {}),
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
  /** agh_contact_policy pre-check wrapper — test inject only. */
  contactPolicy?: (
    sb: SupabaseClient,
    args: { playlist_id: string; track_id: string; channel: string },
  ) => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
};

/**
 * Pre-check the contact policy (#43/#49: cooldown, paid, blocklist, suppression) that
 * agh_guard_draft_policy enforces at insert. A refused row is deferred and reported instead
 * of raising inside the atomic persist RPC, where one row would fail the whole batch.
 * Returns null when the policy passes or cannot be read — the trigger still guards the insert.
 */
export async function inventoryPolicyDeferral(
  sb: SupabaseClient,
  args: { playlist_id: string; track_id: string; channel: string },
  check?: InventoryDeps["contactPolicy"],
): Promise<Record<string, unknown> | null> {
  const run = check ??
    ((client, a) =>
      client.rpc("agh_contact_policy", { p_target: a.playlist_id, p_track: a.track_id, p_channel: a.channel }));
  let res: { data: Record<string, unknown> | null; error: { message: string } | null };
  try {
    res = await run(sb, args);
  } catch {
    return null;
  }
  const policy = res?.error ? null : res?.data;
  if (!policy || typeof policy !== "object" || policy.ok !== false) return null;
  return {
    playlist_id: args.playlist_id,
    channel: args.channel,
    code: String(policy.code ?? "blocked"),
    pitch_log_id: policy.pitch_log_id ?? null,
    cooldown_until: policy.cooldown_until ?? null,
  };
}

function inventoryPersistAttr(ops: OpsActor): Record<string, string> {
  const attr = attributionFrom(ops);
  return {
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    drafted_by: attr.actor_kind,
    drafted_by_label: attr.actor_label,
  };
}

/** Advance a persisted Claude inventory batch into the Grok review queue. */
async function promotePlaylistInventoryBatch(
  sb: SupabaseClient,
  ops: OpsActor,
  batchId: string | null | undefined,
): Promise<{ error: ToolResult | null; queue_state: string | null }> {
  const id = String(batchId ?? "").trim();
  if (!id) return { error: null, queue_state: null };
  const promoted = await advanceClaudeReadyBatches(
    sb,
    { batch_ids: [id], batch_kind: "playlist" },
    ops,
  );
  if (promoted.status >= 400) {
    return {
      error: {
        status: promoted.status,
        data: {
          ...promoted.data,
          error: `inventory persisted but Grok promotion failed: ${
            String(promoted.data.error ?? "unknown")
          }`,
          code: String(promoted.data.code ?? "promotion_failed"),
          batch_id: id,
          persisted: true,
        },
      },
      queue_state: null,
    };
  }
  const advanced = (promoted.data.advanced as Array<{ queue_state?: string }> | undefined) ?? [];
  const skipped = (promoted.data.skipped as Array<{ queue_state?: string }> | undefined) ?? [];
  const queueState = String(advanced[0]?.queue_state ?? skipped[0]?.queue_state ?? "") || null;
  return { error: null, queue_state: queueState };
}

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
  const policyDeferred: Record<string, unknown>[] = [];

  for (const requestedId of candidateIds) {
    // Accept any supported Spotify form for a stored target (ID / spotify:ID / URL).
    let playlistId = requestedId;
    const parsedReq = parseSpotifyPlaylistId(requestedId);
    if (parsedReq.ok) {
      const alias = await resolvePlaylistTargetKey(sb, parsedReq.id);
      if (alias.error) {
        return { status: 500, data: { error: `target_query_failed:${alias.error}`, code: "db_error", playlist_id: requestedId } };
      }
      if (alias.collision) {
        return {
          status: 409,
          data: { error: "identity_alias_collision", code: "identity_alias_collision", playlist_id: requestedId, stored_keys: alias.keys },
        };
      }
      if (alias.key) playlistId = alias.key;
    }
    const { data: target, error: tErr } = await sb
      .from("playlist_targets")
      .select(
        "playlist_id, contact_method, submission_method, path_verified, verification_status, form_url, submission_url, curator_email, ig_curator_account, curator_instagram, form_source_evidence, ig_source_evidence, research_context, is_active, lane, last_verified_at, submission_cost, form_login_required",
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
    const routeCheck = assertSubmissionReady(target as Record<string, unknown>);
    if (!routeCheck.ok) {
      return {
        status: 422,
        data: {
          error: "only verified_eligible candidates may enter draft inventory",
          code: "not_verified_eligible",
          route_code: routeCheck.code,
          route_reason: routeCheck.reason,
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

    const deferral = await inventoryPolicyDeferral(
      sb,
      { playlist_id: playlistId, track_id: trackId, channel },
      deps.contactPolicy,
    );
    if (deferral) {
      policyDeferred.push(deferral);
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
      const composedData = (composed.data ?? {}) as Record<string, unknown>;
      if (composed.status >= 400) {
        return {
          status: composed.status,
          data: {
            ...composedData,
            error: composedData.error ?? "email_compose_failed",
            playlist_id: playlistId,
          },
        };
      }
      if (!composedData.body) {
        return {
          status: 500,
          data: { error: "compose returned no body", playlist_id: playlistId },
        };
      }
      const recipient = String(
        composedData.recipient ?? target.curator_email ?? "",
      ).trim();
      if (!recipient) {
        return {
          status: 422,
          data: {
            error: "email inventory requires curator_email",
            code: "missing_curator_email",
            playlist_id: playlistId,
          },
        };
      }
      draftPayload = {
        track_name: composedData.track_name ?? trackName,
        subject: composedData.subject ?? null,
        body: composedData.body,
        recipient,
        pitch_copy_source: composedData.pitch_copy_source ?? pitchProbe.source,
        pitch_copy_hash: composedData.pitch_copy_hash ?? null,
        generated_by: composedData.generated_by ?? ops.label,
        metadata: composedData.metadata ?? {},
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
      // Authoritative fit decision + DNA/policy version, so review disagreements are diagnosable.
      song_fit: decideLaneFit(dnaRow as ApprovedDnaLanes | null, target.lane),
      // What established the route: the server's shared route rules applied to Claude's evidence.
      route_verification: {
        method: "server_route_rules",
        submitted_by: ops.label,
        verification_status: target.verification_status ?? null,
        verified_at: target.last_verified_at ?? null,
        submission_terms: submissionTerms(target as Record<string, unknown>),
        login_required: target.form_login_required ?? null,
      },
    };
    if (channel === "email") {
      packet.curator_email = String(draftPayload?.recipient ?? target.curator_email ?? "")
        .trim()
        .toLowerCase();
    }
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

  const persistAttr = inventoryPersistAttr(ops);

  if (!items.length && !reusedPreview.length && policyDeferred.length) {
    return {
      status: 409,
      data: {
        error: "every candidate is refused by contact policy — nothing to persist",
        code: "policy_deferred_all",
        policy_deferred: policyDeferred,
      },
    };
  }

  if (!items.length) {
    const reusedBatchId = reusedPreview[0]?.batch_id != null
      ? String(reusedPreview[0].batch_id)
      : null;
    const promoted = await promotePlaylistInventoryBatch(sb, ops, reusedBatchId);
    if (promoted.error) return promoted.error;
    return {
      status: 200,
      data: {
        ok: true,
        idempotent: true,
        batch_id: reusedBatchId,
        track_id: trackId,
        song_dna_version_id: songDnaVersionId,
        draft_status: "pending",
        approved: false,
        sent: false,
        discovered_by: persistAttr.discovered_by,
        drafted_by: persistAttr.drafted_by,
        queue_state: promoted.queue_state,
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
        policy_deferred: policyDeferred,
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
    attr: persistAttr,
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
  const persistedBatchId = result.batch_id != null ? String(result.batch_id) : null;
  const promoted = await promotePlaylistInventoryBatch(sb, ops, persistedBatchId);
  if (promoted.error) return promoted.error;
  return {
    status: 200,
    data: {
      ok: true,
      idempotent: Boolean(result.idempotent),
      batch_id: persistedBatchId,
      track_id: trackId,
      song_dna_version_id: songDnaVersionId,
      draft_status: "pending",
      approved: false,
      sent: false,
      discovered_by: persistAttr.discovered_by,
      drafted_by: persistAttr.drafted_by,
      queue_state: promoted.queue_state,
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
      policy_deferred: policyDeferred,
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
  const res = await completeDailyStationRun(sb, clean, playlistDiscoveryCredentialActor(), null);
  if (res.status >= 400) return res;
  // A station can finish successfully while the business target is unmet — report both.
  res.data = { ...res.data, business_target: await businessTargetSnapshot(sb, clean) };
  return res;
}

async function businessTargetSnapshot(
  sb: SupabaseClient,
  clean: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const { data: camps, error } = await sb.from("pitch_campaigns").select("track_id, status").eq("status", "active");
    if (error) return { status: "query_failed", error: error.message };
    const ids = [...new Set(((camps ?? []) as { track_id: string }[]).map((c) => String(c.track_id)).filter(Boolean))];
    const { data: trackRows } = ids.length
      ? await sb.from("tracks").select("id, name").in("id", ids)
      : { data: [] as { id: string; name: string }[] };
    const names = new Map(((trackRows ?? []) as { id: string; name: string }[]).map((t) => [String(t.id), t.name]));
    const plan = await buildDiscoveryCapacityPlan(sb, ids.length);
    const r2v = plan.funnel.raw_to_verified;
    const funnel = await buildPerSongFunnel(
      sb,
      ids.map((id) => ({ track_id: id, title: names.get(id) ?? null })),
      { objectivePerSong: plan.target_verified_per_song_per_day, rawToEligibleRate: r2v.status === "measured" ? r2v.rate : null },
    );
    const met = funnel.songs.length > 0 && funnel.songs.every((s) => s.business_target_met);
    const stationStatus = String(clean.status ?? "completed");
    const shortfallGiven = String(clean.shortfall_reason ?? "").trim().length > 0;
    return {
      status: funnel.ok ? "ok" : "partial",
      business_target_met: met,
      station_status: stationStatus,
      songs: funnel.songs.map((s) => ({
        track_id: s.track_id,
        title: s.title,
        submissions_today: s.submissions_today,
        objective_submissions: s.objective_submissions,
        submission_shortfall: s.submission_shortfall,
        drafts_awaiting_review_today: s.drafts_awaiting_review_today,
        remaining_eligible_packets_needed: s.remaining_eligible_packets_needed,
        discovery_headroom: s.discovery_headroom,
        capacity_exclusions: s.capacity_exclusions,
        raw_candidates_needed: s.raw_candidates_needed,
      })),
      ...(met || shortfallGiven ? {} : { warning: "business target unmet and no shortfall_reason given" }),
      errors: funnel.errors,
    };
  } catch (e) {
    return { status: "query_failed", error: String((e as Error).message || e) };
  }
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
    .eq("discovered_by", OWN_ACTOR)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { status: 500, data: { error: error.message, code: "db_error" } };
  const rawRows = (data ?? []) as Record<string, unknown>[];
  const rc = await loadBatchRecordCounts(sb, rawRows.map((b) => String(b.id)));
  if (rc.error) return { status: 500, data: { error: `record_counts_failed:${rc.error}`, code: "db_error" } };
  return {
    status: 200,
    data: {
      ok: true,
      // batch_status comes from record states — the batch queue_state alone can hide mixed outcomes.
      rows: rawRows.map((b) => ({
        ...b,
        batch_status: batchStatusSummary(String(b.queue_state), rc.counts.get(String(b.id)) ?? {}),
      })),
      scoped_to: "claude_playlist_discovery",
    },
  };
}

const OWN_ACTOR = "claude_playlist_discovery";

/**
 * Advance this actor's own playlist batches from CLAUDE_BATCH_READY (or
 * CLAUDE_PLAYLIST_COMPLETE) to AWAITING_GROK_REVIEW — independent of station runs and
 * business date, so batches that missed their day's playlist_tranche_final close are
 * never stranded. Ceiling is AWAITING_GROK_REVIEW: the caller cannot choose a state.
 */
export async function advancePlaylistBatches(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "create_handoff_batch");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const ids = Array.isArray(clean.batch_ids)
    ? [...new Set(clean.batch_ids.map((v) => String(v ?? "").trim()).filter(Boolean))]
    : [];
  if (!ids.length) return { status: 400, data: { error: "batch_ids[] required", code: "invalid_args" } };

  const { data: rows, error } = await sb
    .from("agh_handoff_batches")
    .select("id, batch_kind, queue_state, discovered_by, business_date_ct")
    .in("id", ids);
  if (error) {
    return { status: 500, data: { error: `batch_query_failed:${error.message}`, code: "db_error" } };
  }
  const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));

  const eligible: string[] = [];
  const skipped: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];
  const pending = new Set<string>(["CLAUDE_BATCH_READY", "CLAUDE_PLAYLIST_COMPLETE"]);
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) {
      failed.push({ batch_id: id, code: "batch_not_found" });
      continue;
    }
    if (String(b.discovered_by ?? "") !== OWN_ACTOR) {
      // Foreign batches look exactly like missing ones — no state leak.
      failed.push({ batch_id: id, code: "batch_not_found" });
      continue;
    }
    if (String(b.batch_kind ?? "") !== "playlist") {
      failed.push({ batch_id: id, code: "not_playlist_batch" });
      continue;
    }
    const state = String(b.queue_state);
    if (state === "AWAITING_GROK_REVIEW") {
      skipped.push({ batch_id: id, queue_state: state, reason: "already_awaiting_grok_review" });
      continue;
    }
    if (!pending.has(state)) {
      skipped.push({ batch_id: id, queue_state: state, reason: "not_claude_pending" });
      continue;
    }
    eligible.push(id);
  }

  let advanced: Record<string, unknown>[] = [];
  if (eligible.length) {
    const res = await advanceClaudeReadyBatches(
      sb,
      { batch_ids: eligible, batch_kind: "playlist" },
      ops,
    );
    if (res.status >= 500 || res.status === 403) {
      return { status: res.status, data: { ...res.data, code: String(res.data.code ?? "advance_failed") } };
    }
    advanced = (res.data.advanced as Record<string, unknown>[] | undefined) ?? [];
    for (const sk of (res.data.skipped as Record<string, unknown>[] | undefined) ?? []) skipped.push(sk);
    for (const f of (res.data.failed as Record<string, unknown>[] | undefined) ?? []) failed.push(f);
  }

  // Defense in depth: nothing this tool returns may sit past the Claude-side ceiling.
  for (const a of advanced) {
    if (!CLAUDE_SIDE_STATES.has(String(a.queue_state) as HandoffQueueState)) {
      return {
        status: 500,
        data: { error: "internal: advanced beyond Claude-side ceiling", code: "ceiling_violation" },
      };
    }
  }

  return {
    status: failed.length > 0 && advanced.length === 0 && skipped.length === 0 ? 422 : 200,
    data: {
      ok: failed.length === 0,
      target_state: "AWAITING_GROK_REVIEW",
      advanced,
      advanced_count: advanced.length,
      skipped,
      failed,
      scoped_to: OWN_ACTOR,
    },
  };
}

/**
 * Read-only: full candidate records inside one of this actor's own batches, joined to
 * their playlist_targets rows. No pitch copy (subject/body) is returned.
 */
export async function getBatchCandidates(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "read_own_playlist_batches");
  if (denied) return denied;
  const batchId = String(body.batch_id ?? "").trim();
  if (!batchId) return { status: 400, data: { error: "batch_id required", code: "invalid_args" } };

  const { data: batch, error: bErr } = await sb
    .from("agh_handoff_batches")
    .select(
      "id, batch_kind, queue_state, track_id, song_dna_version_id, record_count, discovered_by, drafted_by, business_date_ct, created_at, updated_at",
    )
    .eq("id", batchId)
    .maybeSingle();
  if (bErr) return { status: 500, data: { error: `batch_query_failed:${bErr.message}`, code: "db_error" } };
  if (!batch || String(batch.discovered_by ?? "") !== OWN_ACTOR) {
    return { status: 404, data: { error: "batch not found for this actor", code: "batch_not_found" } };
  }

  const { data: records, error: rErr } = await sb
    .from("agh_handoff_records")
    .select(
      "id, record_kind, queue_state, track_id, playlist_target_id, outreach_draft_id, submission_channel, song_dna_version_id, discovered_by, verified_by, drafted_by, reviewed_by, rejection_reason, packet, submitted_at, manual_submit_result, created_at, updated_at",
    )
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true });
  if (rErr) {
    return { status: 500, data: { error: `records_query_failed:${rErr.message}`, code: "db_error" } };
  }

  const targetIds = [
    ...new Set((records ?? []).map((r) => String(r.playlist_target_id ?? "")).filter(Boolean)),
  ];
  const targets = new Map<string, Record<string, unknown>>();
  if (targetIds.length) {
    const { data: tRows, error: tErr } = await sb
      .from("playlist_targets")
      .select(
        "playlist_id, playlist_name, platform, curator_name, curator_email, curator_url, form_url, submission_url, ig_curator_account, curator_instagram, lane, contact_method, submission_method, verification_status, path_verified, path_verification_notes, form_source_evidence, ig_source_evidence, notes, research_context, follower_count, last_verified_at, discovered_by, is_active, submission_cost, form_login_required",
      )
      .in("playlist_id", targetIds);
    if (tErr) {
      return { status: 500, data: { error: `targets_query_failed:${tErr.message}`, code: "db_error" } };
    }
    for (const t of tRows ?? []) targets.set(String(t.playlist_id), t as Record<string, unknown>);
  }

  const draftIds = [
    ...new Set((records ?? []).map((r) => String(r.outreach_draft_id ?? "")).filter(Boolean)),
  ];
  const draftStatus = new Map<string, string>();
  if (draftIds.length) {
    const { data: dRows, error: dErr } = await sb
      .from("outreach_drafts")
      .select("id, status")
      .in("id", draftIds);
    if (dErr) {
      return { status: 500, data: { error: `drafts_query_failed:${dErr.message}`, code: "db_error" } };
    }
    for (const d of dRows ?? []) draftStatus.set(String(d.id), String(d.status ?? ""));
  }

  // Shared-curator relationships (same email / form / IG across playlists) for Grok.
  const curatorByRecord = new Map<string, Record<string, unknown>>();
  for (const r of (records ?? []) as Record<string, unknown>[]) {
    const t = targets.get(String(r.playlist_target_id ?? ""));
    if (!t || r.submitted_at) continue;
    const ctx = await curatorContactContext(sb, { target: t, trackId: String(r.track_id ?? "") || null, trackName: null });
    curatorByRecord.set(String(r.id), ctx.error ? { error: ctx.error } : {
      shared_with_playlists: ctx.sibling_playlist_ids.filter((p) => p !== String(r.playlist_target_id)),
      same_song_cooldown: ctx.same_song_block,
      other_song_contacts_in_window: ctx.other_song_contacts.length,
      cooldown_days: ctx.cooldown_days,
    });
  }

  // Authoritative fit against the song's CURRENT approved DNA (same decision Grok sees).
  const { data: dnaTrack } = await sb.from("tracks").select("approved_song_dna_version_id").eq("id", String(batch.track_id ?? "")).maybeSingle();
  let dnaLanes: ApprovedDnaLanes | null = null;
  if (dnaTrack?.approved_song_dna_version_id) {
    const { data: d } = await sb
      .from("song_dna_versions")
      .select("id, track_id, approval_state, primary_genre, approved_lanes, excluded_lanes")
      .eq("id", String(dnaTrack.approved_song_dna_version_id))
      .maybeSingle();
    if (d && String(d.approval_state) === "approved" && String(d.track_id) === String(batch.track_id)) dnaLanes = d as ApprovedDnaLanes;
  }
  const counts: Record<string, number> = {};
  for (const r of (records ?? []) as Record<string, unknown>[]) counts[String(r.queue_state)] = (counts[String(r.queue_state)] ?? 0) + 1;

  const candidates = (records ?? []).map((r) => {
    const t = targets.get(String(r.playlist_target_id ?? "")) ?? null;
    const rc = (t?.research_context ?? {}) as Record<string, unknown>;
    const packet = { ...((r.packet ?? {}) as Record<string, unknown>) };
    for (const k of ["body", "subject", "pitch", "draft_body", "ig_dm_draft"]) delete packet[k];
    return {
      handoff_record_id: r.id,
      record_kind: r.record_kind,
      queue_state: r.queue_state,
      track_id: r.track_id,
      song_dna_version_id: r.song_dna_version_id,
      submission_channel: r.submission_channel,
      outreach_draft_id: r.outreach_draft_id ?? null,
      outreach_draft_status: r.outreach_draft_id
        ? draftStatus.get(String(r.outreach_draft_id)) ?? null
        : null,
      discovered_by: r.discovered_by ?? null,
      verified_by: r.verified_by ?? null,
      drafted_by: r.drafted_by ?? null,
      reviewed_by: r.reviewed_by ?? null,
      rejection_reason: r.rejection_reason ?? null,
      packet,
      playlist: t
        ? {
          playlist_id: t.playlist_id,
          playlist_name: t.playlist_name ?? null,
          platform: t.platform ?? null,
          playlist_url: rc.playlist_url ?? null,
          identity_resolved: rc.identity_resolved !== false,
          curator_name: t.curator_name ?? null,
          curator_url: t.curator_url ?? null,
          lane: t.lane ?? null,
          // 0 is the column default, not a reading — report unknown as null.
          follower_count: t.follower_count != null && Number(t.follower_count) > 0 ? t.follower_count : null,
          is_active: t.is_active ?? null,
        }
        : { playlist_id: r.playlist_target_id ?? null, missing_target_row: true },
      route: t
        ? {
          channel: resolveTargetChannel(t),
          curator_email: t.curator_email ?? null,
          form_url: t.form_url ?? null,
          submission_url: t.submission_url ?? null,
          ig_curator_account: t.ig_curator_account ?? null,
          submission_terms: submissionTerms(t),
        }
        : null,
      verification: t
        ? {
          verification_status: t.verification_status ?? null,
          path_verified: t.path_verified === true,
          path_verification_notes: t.path_verification_notes ?? null,
          last_verified_at: t.last_verified_at ?? null,
        }
        : null,
      evidence: t
        ? {
          form_source_evidence: t.form_source_evidence ?? null,
          ig_source_evidence: t.ig_source_evidence ?? null,
          notes: t.notes ?? null,
          source_url: rc.source_url ?? null,
        }
        : null,
      route_hold: (r.packet as Record<string, unknown> | null)?.route_hold ?? null,
      route_check: t
        ? (() => {
          const v = assertSubmissionReady(t, String(r.submission_channel ?? "") || null);
          return { ok: v.ok, code: v.code, reason: v.reason };
        })()
        : { ok: false, code: "target_missing", reason: "playlist target not found" },
      curator_contact: curatorByRecord.get(String(r.id)) ?? null,
      song_fit: decideLaneFit(dnaLanes, t?.lane ?? null),
      route_actionability: routeActionability(t, r as Record<string, unknown>, {
        emailSent: ["sent", "sent_audit_broken"].includes(String(draftStatus.get(String(r.outreach_draft_id ?? "")) ?? "")),
        emailProviderId: null,
      }),
      created_at: r.created_at,
    };
  });

  return {
    status: 200,
    data: {
      ok: true,
      batch,
      batch_status: batchStatusSummary(String(batch.queue_state), counts),
      candidate_count: candidates.length,
      candidates,
      scoped_to: OWN_ACTOR,
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
    case "advance_playlist_batches":
      return advancePlaylistBatches(sb, ops, args);
    case "get_batch_candidates":
      return getBatchCandidates(sb, ops, args);
    default:
      return { status: 400, data: { error: `Unknown MCP tool: ${tool}`, code: "unknown_tool" } };
  }
}

export { reviewHandoffBatch };
