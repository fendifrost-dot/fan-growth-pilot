/**
 * AGH operating-actor identities and Claude / Grok / Fendi authority matrix.
 *
 * Identity is ALWAYS derived from authenticated credentials (JWT / agent header /
 * scheduler secret). Request-body fields like approved_by / generated_by /
 * performed_by are ignored for authorization and attribution.
 */

import type { Actor } from "./outreach-auth.ts";

export type OpsActorKind =
  | "claude"
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
  | "update_sync_gate_ops_flags";

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

const FENDI_CAPS = new Set<OpsCapability>([
  ...FENDI_ONLY,
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
]);

const HUMAN_ADMIN_CAPS = new Set<OpsCapability>([
  "research_playlist_targets",
  "verify_playlist_targets",
  "draft_song_dna",
  "submit_song_dna_for_review",
  "generate_playlist_drafts",
  "review_playlist_drafts",
  "approve_playlist_drafts",
  "reject_playlist_drafts",
  "send_playlist_pitches",
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
]);

const SCHEDULER_CAPS = new Set<OpsCapability>([
  "run_placement_discovery",
  "monitor_inbox",
  "record_placement_evidence",
  "write_playlist_ops",
  "read_playlist_ops",
  "read_ops_metrics",
]);

function artistUserId(): string {
  return (Deno.env.get("ARTIST_USER_ID") || Deno.env.get("FENDI_USER_ID") || "").trim();
}

function agentHeader(req: Request | null): string {
  if (!req) return "";
  return (req.headers.get("x-agh-agent") || req.headers.get("x-ops-agent") || "").trim().toLowerCase();
}

/** Derive operating actor from authenticated credentials only. */
export function resolveOpsActor(actor: Actor | null, req: Request | null = null): OpsActor {
  const header = agentHeader(req);
  if (header === "claude" || header === "claude_research") {
    return { kind: "claude", userId: actor?.kind === "user" ? actor.userId : null, label: "claude" };
  }
  if (header === "grok" || header === "grok_playlist_control") {
    return {
      kind: "grok_playlist_control",
      userId: actor?.kind === "user" ? actor.userId : null,
      label: "grok_playlist_control",
    };
  }

  if (!actor || actor.kind === "anonymous") {
    return { kind: "anonymous", userId: null, label: "anonymous" };
  }
  if (actor.kind === "scheduler") return { kind: "scheduler", userId: null, label: "scheduler" };
  if (actor.kind === "service") return { kind: "service", userId: null, label: "service" };

  const fendiId = artistUserId();
  if (fendiId && actor.userId === fendiId) {
    return { kind: "fendi", userId: actor.userId, label: "fendi" };
  }
  if (actor.kind === "user" && actor.isAdmin) {
    return { kind: "human_admin", userId: actor.userId, label: "human_admin" };
  }
  return { kind: "anonymous", userId: actor.userId, label: "user" };
}

export function capabilitiesFor(kind: OpsActorKind): ReadonlySet<OpsCapability> {
  switch (kind) {
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
