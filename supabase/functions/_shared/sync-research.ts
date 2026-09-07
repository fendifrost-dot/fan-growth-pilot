/**
 * Claude sync-research intake — narrowly scoped.
 * Claude may research/verify/create targets & opportunities and draft pitches
 * only for tracks AGH already marks sync-eligible. Claude may NOT approve
 * sync eligibility, samples, licenses, sends, contracts, or monetary authority.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const SYNC_RESEARCH_ACTIONS = [
  "research_sync_targets",
  "verify_sync_targets",
  "create_sync_target",
  "create_sync_opportunity",
  "draft_sync_pitch",
  "read_own_sync_batches",
  "list_sync_research_targets",
  "list_sync_research_opportunities",
] as const;

export function isSyncResearchAction(action: string): boolean {
  return (SYNC_RESEARCH_ACTIONS as readonly string[]).includes(action);
}

export const SYNC_ROLE_CATEGORIES = [
  "music_supervisor",
  "music_coordinator",
  "sync_agent",
  "licensing_agency",
  "production_music_library",
  "advertising_brand_music_director",
  "film_television_production",
  "trailer_game_music",
  "artist_manager_sync_relevant",
] as const;

export function isSyncRoleCategory(v: string): boolean {
  return (SYNC_ROLE_CATEGORIES as readonly string[]).includes(v);
}

export function syncTargetDedupeKey(input: {
  person_name?: string | null;
  company_name?: string | null;
  role_category?: string | null;
  official_url?: string | null;
  verified_contact_path?: string | null;
}): string {
  const parts = [
    (input.role_category ?? "").trim().toLowerCase(),
    (input.company_name ?? "").trim().toLowerCase(),
    (input.person_name ?? "").trim().toLowerCase(),
    (input.official_url ?? "").trim().toLowerCase(),
    (input.verified_contact_path ?? "").trim().toLowerCase(),
  ];
  return parts.filter(Boolean).join("|") || `anon:${crypto.randomUUID()}`;
}

export function opportunityDedupeKey(input: {
  project_brief?: string | null;
  source_url?: string | null;
  sync_target_id?: string | null;
}): string {
  const brief = (input.project_brief ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const src = (input.source_url ?? "").trim().toLowerCase();
  const tid = (input.sync_target_id ?? "").trim();
  return [tid, src, brief.slice(0, 120)].filter(Boolean).join("|");
}

/** Tracks AGH currently marks sync-eligible (sample-cleared + flag). */
export async function loadSyncEligibleTrackIds(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb
    .from("tracks")
    .select("id, sync_eligible, has_sample")
    .eq("sync_eligible", true);
  return (data ?? []).map((r) => String(r.id));
}

async function assertClaudeResearchCap(ops: OpsActor, cap: Parameters<typeof can>[1]): Promise<RunResult | null> {
  if (!can(ops, cap)) {
    return { status: 403, data: { error: `${ops.label} is not permitted to ${cap}` } };
  }
  // Explicit denials for reserved domains even if a broad cap were mis-granted.
  if (
    can(ops, "approve_sync_eligibility") === false &&
    (cap as string) === "approve_sync_eligibility"
  ) {
    return { status: 403, data: { error: "sync-eligibility approval is Fendi-only" } };
  }
  return null;
}

export async function createSyncTarget(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "create_sync_target");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const role = String(clean.role_category ?? "").trim();
  if (!isSyncRoleCategory(role)) {
    return {
      status: 400,
      data: { error: `role_category must be one of ${SYNC_ROLE_CATEGORIES.join(", ")}` },
    };
  }
  const attr = attributionFrom(ops);
  const dedupe = String(clean.dedupe_key ?? "").trim() ||
    syncTargetDedupeKey({
      person_name: clean.person_name as string,
      company_name: clean.company_name as string,
      role_category: role,
      official_url: clean.official_url as string,
      verified_contact_path: clean.verified_contact_path as string,
    });

  const row = {
    person_name: clean.person_name != null ? String(clean.person_name).trim() : null,
    company_name: clean.company_name != null ? String(clean.company_name).trim() : null,
    role_category: role,
    official_url: clean.official_url != null ? String(clean.official_url).trim() : null,
    verified_contact_path: clean.verified_contact_path != null
      ? String(clean.verified_contact_path).trim()
      : null,
    contact_channel: clean.contact_channel != null ? String(clean.contact_channel).trim() : null,
    territories: Array.isArray(clean.territories) ? clean.territories.map(String) : [],
    media_types: Array.isArray(clean.media_types) ? clean.media_types.map(String) : [],
    genres_styles_sought: Array.isArray(clean.genres_styles_sought)
      ? clean.genres_styles_sought.map(String)
      : [],
    submission_policy: clean.submission_policy != null ? String(clean.submission_policy) : null,
    source_evidence: clean.source_evidence != null ? String(clean.source_evidence) : null,
    date_verified: clean.date_verified != null ? String(clean.date_verified) : null,
    dedupe_key: dedupe,
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    song_dna_version_id: clean.song_dna_version_id ? String(clean.song_dna_version_id) : null,
    discovery_profile_id: clean.discovery_profile_id ? String(clean.discovery_profile_id) : null,
    batch_id: clean.batch_id ? String(clean.batch_id) : null,
    status: "discovered",
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await sb
    .from("sync_research_targets")
    .select("*")
    .eq("dedupe_key", dedupe)
    .maybeSingle();
  if (existing) {
    return { status: 200, data: { ok: true, collapsed: true, row: existing } };
  }

  const { data, error } = await sb.from("sync_research_targets").insert(row).select().single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("sync_research_targets")
        .select("*")
        .eq("dedupe_key", dedupe)
        .maybeSingle();
      return { status: 200, data: { ok: true, collapsed: true, row: raced } };
    }
    return { status: 500, data: { error: error.message } };
  }
  return { status: 200, data: { ok: true, created: true, row: data } };
}

export async function verifySyncTargets(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "verify_sync_targets");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const ids = Array.isArray(clean.ids)
    ? clean.ids.map(String)
    : clean.id
    ? [String(clean.id)]
    : [];
  if (!ids.length) return { status: 400, data: { error: "ids[] or id required" } };
  const attr = attributionFrom(ops);
  const { data, error } = await sb
    .from("sync_research_targets")
    .update({
      status: "verified",
      date_verified: new Date().toISOString(),
      verified_by: attr.actor_kind,
      verified_by_label: attr.actor_label,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .select();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, verified: (data ?? []).length, rows: data ?? [] } };
}

export async function createSyncOpportunity(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "create_sync_opportunity");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const brief = String(clean.project_brief ?? "").trim();
  if (!brief) return { status: 400, data: { error: "project_brief required" } };
  const attr = attributionFrom(ops);
  const eligible = await loadSyncEligibleTrackIds(sb);
  const requested = Array.isArray(clean.recommended_track_ids)
    ? clean.recommended_track_ids.map(String)
    : [];
  const recommended = requested.filter((id) => eligible.includes(id));
  const noEligible = recommended.length === 0;
  const dedupe = String(clean.dedupe_key ?? "").trim() ||
    opportunityDedupeKey({
      project_brief: brief,
      source_url: clean.source_url as string,
      sync_target_id: clean.sync_target_id as string,
    });

  const { data: existing } = await sb
    .from("sync_research_opportunities")
    .select("*")
    .eq("dedupe_key", dedupe)
    .maybeSingle();
  if (existing) {
    return { status: 200, data: { ok: true, collapsed: true, row: existing } };
  }

  const row = {
    sync_target_id: clean.sync_target_id ? String(clean.sync_target_id) : null,
    project_brief: brief,
    media_type: clean.media_type != null ? String(clean.media_type) : null,
    deadline: clean.deadline != null ? String(clean.deadline) : null,
    compensation_public: clean.compensation_public != null
      ? String(clean.compensation_public)
      : null,
    rights_requested: clean.rights_requested != null ? String(clean.rights_requested) : null,
    exclusivity: clean.exclusivity != null ? String(clean.exclusivity) : null,
    territory: clean.territory != null ? String(clean.territory) : null,
    term: clean.term != null ? String(clean.term) : null,
    submission_requirements: clean.submission_requirements != null
      ? String(clean.submission_requirements)
      : null,
    source_url: clean.source_url != null ? String(clean.source_url) : null,
    source_evidence: clean.source_evidence != null ? String(clean.source_evidence) : null,
    recommended_track_ids: recommended,
    no_eligible_track: noEligible,
    no_eligible_track_reason: noEligible ? "no eligible track" : null,
    status: "open",
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    song_dna_version_id: clean.song_dna_version_id ? String(clean.song_dna_version_id) : null,
    batch_id: clean.batch_id ? String(clean.batch_id) : null,
    dedupe_key: dedupe,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("sync_research_opportunities").insert(row).select().single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await sb
        .from("sync_research_opportunities")
        .select("*")
        .eq("dedupe_key", dedupe)
        .maybeSingle();
      return { status: 200, data: { ok: true, collapsed: true, row: raced } };
    }
    return { status: 500, data: { error: error.message } };
  }
  return {
    status: 200,
    data: {
      ok: true,
      created: true,
      row: data,
      no_eligible_track: noEligible,
      drafted: false,
    },
  };
}

export async function draftSyncPitch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "draft_sync_pitch");
  if (denied) return denied;
  // Explicit: Claude cannot send / approve eligibility.
  if (can(ops, "approve_sync_eligibility")) {
    // Fendi may draft too — fine.
  }
  const clean = stripSpoofedAttribution(body);
  const opportunityId = String(clean.opportunity_id ?? "").trim();
  const trackId = String(clean.track_id ?? "").trim();
  const bodyText = String(clean.body ?? "").trim();
  if (!opportunityId || !trackId || !bodyText) {
    return { status: 400, data: { error: "opportunity_id, track_id, and body required" } };
  }

  const eligible = await loadSyncEligibleTrackIds(sb);
  if (!eligible.includes(trackId)) {
    // Store opportunity shortfall — do not draft or infer eligibility.
    await sb
      .from("sync_research_opportunities")
      .update({
        no_eligible_track: true,
        no_eligible_track_reason: "no eligible track",
        updated_at: new Date().toISOString(),
      })
      .eq("id", opportunityId);
    return {
      status: 422,
      data: {
        error: "no eligible track",
        code: "no_eligible_track",
        drafted: false,
        inferred_eligibility: false,
      },
    };
  }

  const attr = attributionFrom(ops);
  const row = {
    opportunity_id: opportunityId,
    track_id: trackId,
    song_dna_version_id: clean.song_dna_version_id ? String(clean.song_dna_version_id) : null,
    subject: clean.subject != null ? String(clean.subject) : null,
    body: bodyText,
    status: "draft",
    drafted_by: attr.actor_kind,
    drafted_by_label: attr.actor_label,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb.from("sync_research_pitch_drafts").insert(row).select().single();
  if (error) return { status: 500, data: { error: error.message } };

  await sb
    .from("sync_research_opportunities")
    .update({
      status: "drafted",
      drafted_by: attr.actor_kind,
      drafted_by_label: attr.actor_label,
      no_eligible_track: false,
      no_eligible_track_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunityId);

  return {
    status: 200,
    data: {
      ok: true,
      draft: data,
      sent: false,
      license_verified: false,
      monetary_authority: false,
    },
  };
}

export async function researchSyncTargets(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "research_sync_targets");
  if (denied) return denied;
  // Research = create one or many targets from a structured payload.
  const items = Array.isArray(body.targets) ? body.targets : [body];
  const created: unknown[] = [];
  const collapsed: unknown[] = [];
  for (const item of items) {
    const res = await createSyncTarget(
      sb,
      typeof item === "object" && item ? (item as Record<string, unknown>) : {},
      ops,
    );
    if (res.status >= 400) return res;
    if (res.data.collapsed) collapsed.push(res.data.row);
    else created.push(res.data.row);
  }
  return {
    status: 200,
    data: {
      ok: true,
      created: created.length,
      collapsed: collapsed.length,
      rows: [...created, ...collapsed],
    },
  };
}

export async function readOwnSyncBatches(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "read_own_sync_batches");
  if (denied) return denied;
  const limit = Math.min(Number(body.limit) || 40, 100);
  let q = sb
    .from("agh_handoff_batches")
    .select("*")
    .eq("batch_kind", "sync")
    .order("created_at", { ascending: false })
    .limit(limit);
  // Claude only sees batches it discovered; admins/Fendi see all.
  if (ops.kind === "claude") {
    q = q.eq("discovered_by", "claude");
  }
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, rows: data ?? [] } };
}

export async function runSyncResearchAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case "research_sync_targets":
      return researchSyncTargets(sb, body, ops);
    case "verify_sync_targets":
      return verifySyncTargets(sb, body, ops);
    case "create_sync_target":
      return createSyncTarget(sb, body, ops);
    case "create_sync_opportunity":
      return createSyncOpportunity(sb, body, ops);
    case "draft_sync_pitch":
      return draftSyncPitch(sb, body, ops);
    case "read_own_sync_batches":
      return readOwnSyncBatches(sb, body, ops);
    case "list_sync_research_targets": {
      const { data, error } = await sb
        .from("sync_research_targets")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(Math.min(Number(body.limit) || 50, 200));
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }
    case "list_sync_research_opportunities": {
      const { data, error } = await sb
        .from("sync_research_opportunities")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(Math.min(Number(body.limit) || 50, 200));
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }
    default:
      return { status: 400, data: { error: `Unknown sync research action: ${action}` } };
  }
}
