/**
 * AGH operating-actor identities and Claude / Grok / Fendi authority matrix.
 *
 * Identity is ALWAYS derived from authenticated credentials:
 *   - dedicated agent secrets (Claude / Grok)
 *   - scheduler secret
 *   - hub/service key
 *   - JWT user id (Fendi = exact ARTIST_USER_ID; human_admin = admin role)
 *
 * Headers `x-agh-agent` / `x-ops-agent` are NEVER identity. They may only be
 * retained as non-authoritative labels after the credential itself maps to
 * that actor. Admin JWT + x-agh-agent:grok remains human_admin.
 *
 * Request-body fields like approved_by / generated_by / performed_by are
 * ignored for authorization and attribution.
 */

import type { Actor } from "./outreach-auth.ts";

export type OpsActorKind =
  | "claude"
  | "claude_playlist_discovery"
  | "grok_playlist_control"
  | "fendi"
  | "scheduler"
  | "human_admin"
  | "anonymous"
  | "service";

export type OpsActor = {
  kind: OpsActorKind;
  userId: string | null;
  label: string;
};

export type OpsCapability =
  | "research_playlist_targets"
  | "verify_playlist_targets"
  | "draft_song_dna"
  | "submit_song_dna_for_review"
  | "generate_playlist_drafts"
  | "run_placement_discovery"
  | "record_research_evidence"
  | "record_placement_evidence"
  | "review_playlist_drafts"
  | "approve_playlist_drafts"
  | "reject_playlist_drafts"
  | "send_playlist_pitches"
  | "monitor_inbox"
  | "classify_replies"
  | "respond_to_curators"
  | "open_incidents"
  | "approve_song_dna"
  | "reject_song_dna"
  | "approve_sample_declaration"
  | "approve_sync_eligibility"
  | "alter_approved_song_dna"
  | "authorize_monetary_decisions"
  | "write_playlist_ops"
  | "read_playlist_ops"
  | "read_ops_metrics"
  | "update_sync_gate_ops_flags"
  // Daily ops / handoff / multichannel / Claude sync research
  | "run_daily_station"
  | "read_daily_ops"
  | "manage_ops_settings"
  | "create_handoff_batch"
  | "review_handoff_batch"
  | "verify_submission_path"
  | "research_sync_targets"
  | "verify_sync_targets"
  | "create_sync_target"
  | "create_sync_opportunity"
  | "draft_sync_pitch"
  | "read_own_sync_batches"
  /** Minimal projection for remote playlist-discovery connector (no fan/radio/licensing). */
  | "read_playlist_discovery_work"
  | "submit_playlist_candidates"
  | "read_own_playlist_batches"
  // Human/Fendi admin surfaces — never granted to Claude/Grok/service/scheduler.
  | "manage_campaigns"
  | "manage_catalog"
  | "manage_smart_links"
  | "manage_sync_registers"
  | "manage_radio"
  | "manage_fan_engagement";

/** Narrow remote-connector actor — draft-only playlist discovery. No DNA mutation, approve, send, inbox, fan/radio. */
const CLAUDE_PLAYLIST_DISCOVERY_CAPS = new Set<OpsCapability>([
  "research_playlist_targets",
  "verify_playlist_targets",
  "generate_playlist_drafts",
  "record_research_evidence",
  "run_daily_station",
  "create_handoff_batch",
  "verify_submission_path",
  "read_playlist_discovery_work",
  "submit_playlist_candidates",
  "read_own_playlist_batches",
]);

const CLAUDE_CAPS = new Set<OpsCapability>([
  "research_playlist_targets",
  "verify_playlist_targets",
  "draft_song_dna",
  "submit_song_dna_for_review",
  "generate_playlist_drafts",
  "run_placement_discovery",
  "record_research_evidence",
  "record_placement_evidence",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "run_daily_station",
  "create_handoff_batch",
  "verify_submission_path",
  "research_sync_targets",
  "verify_sync_targets",
  "create_sync_target",
  "create_sync_opportunity",
  "draft_sync_pitch",
  "read_own_sync_batches",
  "read_playlist_discovery_work",
]);

const GROK_CAPS = new Set<OpsCapability>([
  "research_playlist_targets",
  "verify_playlist_targets",
  "review_playlist_drafts",
  "approve_playlist_drafts",
  "reject_playlist_drafts",
  "send_playlist_pitches",
  "monitor_inbox",
  "classify_replies",
  "respond_to_curators",
  "record_placement_evidence",
  "open_incidents",
  "run_placement_discovery",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "update_sync_gate_ops_flags",
  "run_daily_station",
  "read_daily_ops",
  "create_handoff_batch",
  "review_handoff_batch",
  "verify_submission_path",
  "read_own_sync_batches",
  "read_playlist_discovery_work",
]);

/** Only Fendi's exact ARTIST_USER_ID may hold these reserved decisions. */
const FENDI_ONLY = new Set<OpsCapability>([
  "approve_song_dna",
  "reject_song_dna",
  "approve_sample_declaration",
  "approve_sync_eligibility",
  "alter_approved_song_dna",
  "authorize_monetary_decisions",
]);

const ADMIN_SURFACE = new Set<OpsCapability>([
  "manage_campaigns",
  "manage_catalog",
  "manage_smart_links",
  "manage_sync_registers",
  "manage_radio",
  "manage_fan_engagement",
]);

const FENDI_CAPS = new Set<OpsCapability>([
  ...FENDI_ONLY,
  ...ADMIN_SURFACE,
  "draft_song_dna",
  "submit_song_dna_for_review",
  "review_playlist_drafts",
  "approve_playlist_drafts",
  "reject_playlist_drafts",
  "send_playlist_pitches",
  "open_incidents",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "update_sync_gate_ops_flags",
  "monitor_inbox",
  "classify_replies",
  "respond_to_curators",
  "record_placement_evidence",
  "research_playlist_targets",
  "verify_playlist_targets",
  "generate_playlist_drafts",
  "run_placement_discovery",
  "record_research_evidence",
  "run_daily_station",
  "read_daily_ops",
  "manage_ops_settings",
  "create_handoff_batch",
  "review_handoff_batch",
  "verify_submission_path",
  "research_sync_targets",
  "verify_sync_targets",
  "create_sync_target",
  "create_sync_opportunity",
  "draft_sync_pitch",
  "read_own_sync_batches",
  "read_playlist_discovery_work",
  "submit_playlist_candidates",
  "read_own_playlist_batches",
]);

/** Human admins: ops reads/writes except playlist approve/send (Grok/Fendi only). */
const HUMAN_ADMIN_CAPS = new Set<OpsCapability>([
  ...ADMIN_SURFACE,
  "research_playlist_targets",
  "verify_playlist_targets",
  "draft_song_dna",
  "submit_song_dna_for_review",
  "generate_playlist_drafts",
  "review_playlist_drafts",
  "reject_playlist_drafts",
  "monitor_inbox",
  "classify_replies",
  "respond_to_curators",
  "record_research_evidence",
  "record_placement_evidence",
  "open_incidents",
  "run_placement_discovery",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "update_sync_gate_ops_flags",
  "run_daily_station",
  "read_daily_ops",
  "manage_ops_settings",
  "create_handoff_batch",
  "verify_submission_path",
  "research_sync_targets",
  "verify_sync_targets",
  "create_sync_target",
  "create_sync_opportunity",
  "draft_sync_pitch",
  "read_own_sync_batches",
  "read_playlist_discovery_work",
  "submit_playlist_candidates",
  "read_own_playlist_batches",
]);

const SCHEDULER_CAPS = new Set<OpsCapability>([
  "run_placement_discovery",
  "monitor_inbox",
  "record_placement_evidence",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "run_daily_station",
  "read_daily_ops",
]);

/**
 * Hub-key / service callers may draft + research; never approve/send, and never
 * unrestricted admin surfaces (campaigns, sync approvals, monetization).
 */
const SERVICE_CAPS = new Set<OpsCapability>([
  "research_playlist_targets",
  "verify_playlist_targets",
  "generate_playlist_drafts",
  "run_placement_discovery",
  "record_research_evidence",
  "record_placement_evidence",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
  "run_daily_station",
  "create_handoff_batch",
  "verify_submission_path",
  "research_sync_targets",
  "verify_sync_targets",
  "create_sync_target",
  "create_sync_opportunity",
  "draft_sync_pitch",
  "read_own_sync_batches",
]);

function artistUserId(): string {
  return (Deno.env.get("ARTIST_USER_ID") || Deno.env.get("FENDI_USER_ID") || "").trim();
}

/** Constant-time-ish compare to avoid leaking secret length/prefix by timing. */
export function secretsEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function header(req: Request | null, name: string): string {
  if (!req) return "";
  return (req.headers.get(name) || "").trim();
}

function presentedApiKey(req: Request | null): string {
  if (!req) return "";
  return header(req, "x-api-key") || header(req, "x-fanfuel-hub-key");
}

/** Non-authoritative agent label header — never used for identity. */
export function agentLabelHeader(req: Request | null): string {
  if (!req) return "";
  return (header(req, "x-agh-agent") || header(req, "x-ops-agent")).toLowerCase();
}

export function isGrokCredential(req: Request | null): boolean {
  const expected = (Deno.env.get("GROK_PLAYLIST_CONTROL_SECRET") || "").trim();
  if (!expected || !req) return false;
  const presented =
    header(req, "x-grok-playlist-control-secret") ||
    header(req, "x-grok-agent-secret") ||
    presentedApiKey(req);
  return secretsEqual(presented, expected);
}

export function isClaudePlaylistDiscoveryCredential(req: Request | null): boolean {
  const expected = (Deno.env.get("CLAUDE_PLAYLIST_DISCOVERY_SECRET") || "").trim();
  if (!expected || !req) return false;
  const presented =
    header(req, "x-claude-playlist-discovery-secret") ||
    header(req, "x-agh-playlist-discovery-secret") ||
    presentedApiKey(req);
  const hub = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  const claude = (Deno.env.get("CLAUDE_AGENT_SECRET") || "").trim();
  // Must not accept hub or broad Claude secrets as this narrower actor.
  if (hub && secretsEqual(presented, hub) && !secretsEqual(presented, expected)) return false;
  if (claude && secretsEqual(presented, claude) && !secretsEqual(presented, expected)) return false;
  return secretsEqual(presented, expected);
}

export function isClaudeCredential(req: Request | null): boolean {
  const expected = (Deno.env.get("CLAUDE_AGENT_SECRET") || "").trim();
  if (!expected || !req) return false;
  const presented =
    header(req, "x-claude-agent-secret") ||
    header(req, "x-claude-agent-key") ||
    presentedApiKey(req);
  // Do not treat FANFUEL_HUB_KEY as Claude — require the dedicated secret match
  // against the Claude-specific headers OR against x-api-key only when the
  // presented key equals CLAUDE_AGENT_SECRET (not the hub key).
  const hub = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  if (hub && secretsEqual(presented, hub) && !secretsEqual(presented, expected)) {
    return false;
  }
  // Dedicated playlist-discovery secret must not elevate to broad Claude.
  const discovery = (Deno.env.get("CLAUDE_PLAYLIST_DISCOVERY_SECRET") || "").trim();
  if (
    discovery &&
    secretsEqual(presented, discovery) &&
    !secretsEqual(presented, expected)
  ) {
    return false;
  }
  return secretsEqual(presented, expected);
}

export function isHubServiceCredential(req: Request | null): boolean {
  const expected = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  if (!expected || !req) return false;
  // Missing configured secret must never authorize. Arbitrary keys fail closed.
  return secretsEqual(presentedApiKey(req), expected);
}

export function isSchedulerCredential(req: Request | null): boolean {
  const expected = (Deno.env.get("OUTREACH_SCHEDULER_SECRET") || "").trim();
  if (!expected || !req) return false;
  return secretsEqual(header(req, "x-outreach-scheduler-secret"), expected);
}

/**
 * Derive operating actor from authenticated credentials only.
 * Agent headers never elevate privileges.
 */
export function resolveOpsActor(actor: Actor | null, req: Request | null = null): OpsActor {
  // 1) Dedicated credentials win — order: scheduler → Grok → playlist-discovery → Claude → service.
  if (actor?.kind === "scheduler" || isSchedulerCredential(req)) {
    return { kind: "scheduler", userId: null, label: "scheduler" };
  }
  if (actor?.kind === "grok_playlist_control" || isGrokCredential(req)) {
    return { kind: "grok_playlist_control", userId: null, label: "grok_playlist_control" };
  }
  if (
    actor?.kind === "claude_playlist_discovery" ||
    isClaudePlaylistDiscoveryCredential(req)
  ) {
    return {
      kind: "claude_playlist_discovery",
      userId: null,
      label: "claude_playlist_discovery",
    };
  }
  if (actor?.kind === "claude" || isClaudeCredential(req)) {
    return { kind: "claude", userId: actor?.kind === "user" ? actor.userId : null, label: "claude" };
  }
  if (actor?.kind === "service" || isHubServiceCredential(req)) {
    return { kind: "service", userId: null, label: "service" };
  }

  // 2) JWT-backed users — Fendi exact id, else human_admin, else anonymous.
  // Agent headers MUST NOT remap these identities.
  if (actor?.kind === "user") {
    const fendiId = artistUserId();
    if (fendiId && actor.userId === fendiId) {
      return { kind: "fendi", userId: actor.userId, label: "fendi" };
    }
    if (actor.isAdmin) {
      return { kind: "human_admin", userId: actor.userId, label: "human_admin" };
    }
    return { kind: "anonymous", userId: actor.userId, label: "user" };
  }

  if (!actor || actor.kind === "anonymous") {
    return { kind: "anonymous", userId: null, label: "anonymous" };
  }
  return { kind: "anonymous", userId: null, label: "anonymous" };
}

export function capabilitiesFor(kind: OpsActorKind): ReadonlySet<OpsCapability> {
  switch (kind) {
    case "claude_playlist_discovery":
      return CLAUDE_PLAYLIST_DISCOVERY_CAPS;
    case "claude":
      return CLAUDE_CAPS;
    case "grok_playlist_control":
      return GROK_CAPS;
    case "fendi":
      return FENDI_CAPS;
    case "human_admin":
      return HUMAN_ADMIN_CAPS;
    case "scheduler":
      return SCHEDULER_CAPS;
    case "service":
      return SERVICE_CAPS;
    default:
      return new Set();
  }
}

export function can(actor: OpsActor, capability: OpsCapability): boolean {
  return capabilitiesFor(actor.kind).has(capability);
}

export function isFendiReserved(capability: OpsCapability): boolean {
  return FENDI_ONLY.has(capability);
}

/**
 * Soft gate for Result-style handlers. Returns an error Result when denied.
 */
export function denyUnlessCan(
  actor: OpsActor,
  capability: OpsCapability,
): { status: number; data: { error: string } } | null {
  if (can(actor, capability)) return null;
  return {
    status: 403,
    data: { error: `${actor.label} is not permitted to ${capability}` },
  };
}

/** Throw-style gate for ledger helpers that prefer exceptions. */
export function assertCan(actor: OpsActor, capability: OpsCapability): void {
  const denied = denyUnlessCan(actor, capability);
  if (denied) {
    const err = new Error(denied.data.error) as Error & { status?: number };
    err.status = denied.status;
    throw err;
  }
}

/** Strip spoofable attribution fields from request bodies before persistence. */
export function stripSpoofedAttribution(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const key of [
    "approved_by",
    "rejected_by",
    "generated_by",
    "performed_by",
    "discovered_by",
    "verified_by",
    "drafted_by",
    "sent_by",
    "response_checked_by",
    "placement_checked_by",
    "actor_user_id",
    "actor_kind",
    "ops_actor",
    "discovered_by_label",
    "verified_by_label",
    "drafted_by_label",
    "approved_by_label",
    "sent_by_label",
    "response_checked_by_label",
    "placement_checked_by_label",
  ]) {
    delete out[key];
  }
  return out;
}

export function attributionFrom(actor: OpsActor): {
  actor_key: OpsActorKind;
  actor_kind: OpsActorKind;
  actor_user_id: string | null;
  actor_label: string;
} {
  return {
    actor_key: actor.kind,
    actor_kind: actor.kind,
    actor_user_id: actor.userId,
    actor_label: actor.label,
  };
}
