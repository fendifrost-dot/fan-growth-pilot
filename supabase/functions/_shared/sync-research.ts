/**
 * Claude sync-research intake — narrowly scoped.
 * Claude may research/verify/create targets & opportunities and draft pitches
 * only when AGH server eligibility passes. Research persists even when drafting
 * is blocked. Claude may NOT approve sync eligibility, samples, licenses, sends,
 * contracts, or monetary authority. Track selection comes from ops_settings.
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
import { resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import {
  computeTrackSyncEligibility,
  formatEligibilityBlock,
  loadSyncEligibleTrackIds,
  type SyncEligibilityDecision,
} from "./sync-eligibility.ts";
import {
  activeResearchTrackIds,
  isActiveResearchTrack,
  loadSyncResearchConfig,
  rejectCallerSyncIdentity,
  trackResearchStatus,
} from "./sync-research-config.ts";
import { chicagoBusinessDate } from "./chicago-time.ts";

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
  "get_sync_discovery_work",
  "submit_sync_research",
  "advance_sync_batch",
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

export const OPPORTUNITY_TYPES = ["active_brief", "agency_introduction"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export function isSyncRoleCategory(v: string): boolean {
  return (SYNC_ROLE_CATEGORIES as readonly string[]).includes(v);
}

export function isOpportunityType(v: string): v is OpportunityType {
  return (OPPORTUNITY_TYPES as readonly string[]).includes(v);
}

export function syncTargetDedupeKey(input: {
  person_name?: string | null;
  company_name?: string | null;
  role_category?: string | null;
  official_url?: string | null;
  verified_contact_path?: string | null;
  target_type?: string | null;
}): string {
  const parts = [
    (input.target_type ?? "agency_introduction").trim().toLowerCase(),
    (input.role_category ?? "").trim().toLowerCase(),
    (input.company_name ?? "").trim().toLowerCase(),
    (input.person_name ?? "").trim().toLowerCase(),
    (input.official_url ?? "").trim().toLowerCase(),
    (input.verified_contact_path ?? "").trim().toLowerCase(),
  ];
  return parts.filter(Boolean).join("|") || `anon:${crypto.randomUUID()}`;
}

export function opportunityDedupeKey(input: {
  opportunity_type?: string | null;
  project_brief?: string | null;
  source_url?: string | null;
  sync_target_id?: string | null;
  deadline?: string | null;
}): string {
  const brief = (input.project_brief ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const src = (input.source_url ?? "").trim().toLowerCase();
  const tid = (input.sync_target_id ?? "").trim();
  const typ = (input.opportunity_type ?? "").trim().toLowerCase();
  const dl = (input.deadline ?? "").trim();
  return [typ, tid, src, dl, brief.slice(0, 120)].filter(Boolean).join("|");
}

async function assertClaudeResearchCap(
  ops: OpsActor,
  cap: Parameters<typeof can>[1],
): Promise<RunResult | null> {
  if (!can(ops, cap)) {
    return { status: 403, data: { error: `${ops.label} is not permitted to ${cap}` } };
  }
  if (
    can(ops, "approve_sync_eligibility") === false &&
    (cap as string) === "approve_sync_eligibility"
  ) {
    return { status: 403, data: { error: "sync-eligibility approval is Fendi-only" } };
  }
  return null;
}

function ownScopeKinds(ops: OpsActor): boolean {
  return (
    ops.kind === "claude" ||
    ops.kind === "claude_sync_discovery" ||
    ops.kind === "service"
  );
}

function unscopedSyncReader(ops: OpsActor): boolean {
  return (
    ops.kind === "fendi" ||
    ops.kind === "human_admin" ||
    ops.kind === "grok_playlist_control"
  );
}

export async function createSyncTarget(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "create_sync_target");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const role = String(clean.role_category ?? "").trim();
  if (!isSyncRoleCategory(role)) {
    return {
      status: 400,
      data: { error: `role_category must be one of ${SYNC_ROLE_CATEGORIES.join(", ")}` },
    };
  }
  const targetType = String(clean.target_type ?? "agency_introduction").trim();
  if (targetType !== "agency_introduction" && targetType !== "active_brief_contact") {
    return {
      status: 400,
      data: { error: "target_type must be agency_introduction or active_brief_contact" },
    };
  }

  const associatedTrackId = clean.associated_track_id
    ? String(clean.associated_track_id).trim()
    : clean.track_id
    ? String(clean.track_id).trim()
    : "";
  if (associatedTrackId) {
    const config = await loadSyncResearchConfig(sb);
    if (!isActiveResearchTrack(config, associatedTrackId)) {
      return {
        status: 422,
        data: {
          error: "track not active for sync research",
          code: "sync_research_track_inactive",
          track_id: associatedTrackId,
          status: trackResearchStatus(config, associatedTrackId),
        },
      };
    }
  }

  const attr = attributionFrom(ops);
  const primarySource =
    clean.primary_source_url != null
      ? String(clean.primary_source_url).trim()
      : clean.official_url != null
      ? String(clean.official_url).trim()
      : "";
  const dedupe = String(clean.dedupe_key ?? "").trim() ||
    syncTargetDedupeKey({
      person_name: clean.person_name as string,
      company_name: clean.company_name as string,
      role_category: role,
      official_url: clean.official_url as string,
      verified_contact_path: clean.verified_contact_path as string,
      target_type: targetType,
    });

  let songDnaVersionId: string | null = null;
  if (associatedTrackId) {
    const dna = await resolveCurrentApprovedDna(sb, {
      trackId: associatedTrackId,
      callerSongDnaVersionId: clean.song_dna_version_id != null
        ? String(clean.song_dna_version_id)
        : null,
    });
    if (dna.ok) songDnaVersionId = dna.songDnaVersionId;
    // Research may proceed without approved DNA — do not invent DNA id from caller.
  }

  const row = {
    person_name: clean.person_name != null ? String(clean.person_name).trim() : null,
    company_name: clean.company_name != null ? String(clean.company_name).trim() : null,
    role_category: role,
    target_type: targetType,
    official_url: clean.official_url != null ? String(clean.official_url).trim() : null,
    primary_source_url: primarySource || null,
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
    acceptance_policy_status: clean.acceptance_policy_status != null
      ? String(clean.acceptance_policy_status)
      : null,
    exclusivity_rights_warnings: clean.exclusivity_rights_warnings != null
      ? String(clean.exclusivity_rights_warnings)
      : null,
    compensation_known: clean.compensation_known != null
      ? String(clean.compensation_known)
      : null,
    source_evidence: clean.source_evidence != null ? String(clean.source_evidence) : null,
    date_verified: clean.date_verified != null ? String(clean.date_verified) : null,
    verification_timestamp: clean.verification_timestamp != null
      ? String(clean.verification_timestamp)
      : null,
    dedupe_key: dedupe,
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    associated_track_id: associatedTrackId || null,
    song_dna_version_id: songDnaVersionId,
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

  const { data: rows, error: loadErr } = await sb
    .from("sync_research_targets")
    .select("*")
    .in("id", ids);
  if (loadErr) return { status: 500, data: { error: loadErr.message } };

  const verified: Record<string, unknown>[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const row of rows ?? []) {
    if (ownScopeKinds(ops) && row.discovered_by && row.discovered_by !== ops.kind) {
      rejected.push({ id: String(row.id), reason: "not_own_record" });
      continue;
    }
    const path = String(row.verified_contact_path ?? "").trim();
    const evidence = String(row.source_evidence ?? "").trim();
    const url = String(row.primary_source_url ?? row.official_url ?? "").trim();
    if (!path) {
      rejected.push({ id: String(row.id), reason: "missing_verified_contact_path" });
      continue;
    }
    if (!evidence) {
      rejected.push({ id: String(row.id), reason: "missing_source_evidence" });
      continue;
    }
    if (!url && !path.startsWith("http") && !path.includes("@")) {
      rejected.push({ id: String(row.id), reason: "no_official_url_or_contact_path" });
      continue;
    }
    const now = new Date().toISOString();
    const { data: updated, error } = await sb
      .from("sync_research_targets")
      .update({
        status: "verified",
        date_verified: now,
        verification_timestamp: now,
        verified_by: attr.actor_kind,
        verified_by_label: attr.actor_label,
        updated_at: now,
      })
      .eq("id", row.id)
      .select()
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (updated) verified.push(updated);
  }

  return {
    status: 200,
    data: {
      ok: true,
      verified: verified.length,
      rejected: rejected.length,
      rows: verified,
      rejected_rows: rejected,
      false_verify: false,
    },
  };
}

export async function createSyncOpportunity(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "create_sync_opportunity");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const brief = String(clean.project_brief ?? "").trim();
  if (!brief) return { status: 400, data: { error: "project_brief required" } };

  const opportunityTypeRaw = String(clean.opportunity_type ?? "").trim();
  if (!isOpportunityType(opportunityTypeRaw)) {
    return {
      status: 400,
      data: {
        error: "opportunity_type must be active_brief or agency_introduction",
        code: "invalid_opportunity_type",
      },
    };
  }

  const deadline = clean.deadline != null ? String(clean.deadline).trim() : "";
  // Undated agency directory entries must NOT be classified as active_brief.
  if (opportunityTypeRaw === "active_brief" && !deadline) {
    return {
      status: 422,
      data: {
        error: "active_brief requires a deadline; undated contacts are agency_introduction",
        code: "active_brief_requires_deadline",
      },
    };
  }
  if (opportunityTypeRaw === "agency_introduction" && deadline) {
    // Allow but do not auto-promote — keep type as declared.
  }

  const sourceUrl = clean.primary_source_url != null
    ? String(clean.primary_source_url).trim()
    : clean.source_url != null
    ? String(clean.source_url).trim()
    : "";
  const sourceEvidence = clean.source_evidence != null ? String(clean.source_evidence).trim() : "";
  if (!sourceUrl && !sourceEvidence) {
    return {
      status: 422,
      data: {
        error: "source_url or source_evidence required before opportunity can be open for pitching",
        code: "missing_sync_provenance",
      },
    };
  }

  const associatedTrackId = clean.associated_track_id
    ? String(clean.associated_track_id).trim()
    : clean.track_id
    ? String(clean.track_id).trim()
    : "";
  if (associatedTrackId) {
    const config = await loadSyncResearchConfig(sb);
    if (!isActiveResearchTrack(config, associatedTrackId)) {
      return {
        status: 422,
        data: {
          error: "track not active for sync research",
          code: "sync_research_track_inactive",
          track_id: associatedTrackId,
          status: trackResearchStatus(config, associatedTrackId),
        },
      };
    }
  }

  const attr = attributionFrom(ops);
  const eligible = await loadSyncEligibleTrackIds(sb);
  const requested = Array.isArray(clean.recommended_track_ids)
    ? clean.recommended_track_ids.map(String)
    : associatedTrackId
    ? [associatedTrackId]
    : [];
  // Never invent eligibility — only keep ids already sync_eligible server-side.
  const recommended = requested.filter((id) => eligible.includes(id));
  const noEligible = recommended.length === 0;
  const noEligibleReason = noEligible
    ? associatedTrackId && !eligible.includes(associatedTrackId)
      ? "associated track not sync-eligible"
      : "no eligible track"
    : null;

  let songDnaVersionId: string | null = null;
  if (associatedTrackId || recommended[0]) {
    const tid = associatedTrackId || recommended[0];
    const dna = await resolveCurrentApprovedDna(sb, {
      trackId: tid,
      callerSongDnaVersionId: clean.song_dna_version_id != null
        ? String(clean.song_dna_version_id)
        : null,
    });
    if (dna.ok) songDnaVersionId = dna.songDnaVersionId;
  }

  const dedupe = String(clean.dedupe_key ?? "").trim() ||
    opportunityDedupeKey({
      opportunity_type: opportunityTypeRaw,
      project_brief: brief,
      source_url: sourceUrl,
      sync_target_id: clean.sync_target_id as string,
      deadline: deadline || null,
    });

  const { data: existing } = await sb
    .from("sync_research_opportunities")
    .select("*")
    .eq("dedupe_key", dedupe)
    .maybeSingle();
  if (existing) {
    return { status: 200, data: { ok: true, collapsed: true, row: existing } };
  }

  const now = new Date().toISOString();
  const row = {
    sync_target_id: clean.sync_target_id ? String(clean.sync_target_id) : null,
    opportunity_type: opportunityTypeRaw,
    project_brief: brief,
    media_type: clean.media_type != null ? String(clean.media_type) : null,
    usage_type: clean.usage_type != null ? String(clean.usage_type) : null,
    deadline: deadline || null,
    compensation_public: clean.compensation_public != null
      ? String(clean.compensation_public)
      : null,
    compensation_known: clean.compensation_known != null
      ? String(clean.compensation_known)
      : clean.compensation_public != null
      ? String(clean.compensation_public)
      : null,
    rights_requested: clean.rights_requested != null ? String(clean.rights_requested) : null,
    exclusivity: clean.exclusivity != null ? String(clean.exclusivity) : null,
    exclusivity_rights_warnings: clean.exclusivity_rights_warnings != null
      ? String(clean.exclusivity_rights_warnings)
      : null,
    territory: clean.territory != null ? String(clean.territory) : null,
    term: clean.term != null ? String(clean.term) : null,
    music_requirements: clean.music_requirements != null
      ? String(clean.music_requirements)
      : null,
    submission_requirements: clean.submission_requirements != null
      ? String(clean.submission_requirements)
      : null,
    acceptance_policy_status: clean.acceptance_policy_status != null
      ? String(clean.acceptance_policy_status)
      : null,
    source_url: sourceUrl || null,
    primary_source_url: sourceUrl || null,
    source_evidence: sourceEvidence || null,
    verification_timestamp: now,
    recommended_track_ids: recommended,
    associated_track_id: associatedTrackId || null,
    no_eligible_track: noEligible,
    no_eligible_track_reason: noEligibleReason,
    status: "open",
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    song_dna_version_id: songDnaVersionId,
    batch_id: clean.batch_id ? String(clean.batch_id) : null,
    dedupe_key: dedupe,
    updated_at: now,
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
      opportunity_type: opportunityTypeRaw,
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
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const opportunityId = String(clean.opportunity_id ?? "").trim();
  const trackId = String(clean.track_id ?? "").trim();
  const bodyText = String(clean.body ?? "").trim();
  if (!opportunityId || !trackId || !bodyText) {
    return { status: 400, data: { error: "opportunity_id, track_id, and body required" } };
  }

  // Config: drafting requires active research track AND sync eligibility.
  const config = await loadSyncResearchConfig(sb);
  if (!isActiveResearchTrack(config, trackId)) {
    return {
      status: 422,
      data: {
        error: "track not active for sync research",
        code: "sync_research_track_inactive",
        track_id: trackId,
        status: trackResearchStatus(config, trackId),
        drafted: false,
      },
    };
  }

  const decision = await computeTrackSyncEligibility(sb, trackId);
  if ("error" in decision) {
    return { status: 500, data: { error: decision.error } };
  }
  if (!decision.eligible) {
    await sb
      .from("sync_research_opportunities")
      .update({
        no_eligible_track: true,
        no_eligible_track_reason: decision.reasons.join("; ") || "sync_eligibility_blocked",
        updated_at: new Date().toISOString(),
      })
      .eq("id", opportunityId);
    return {
      status: 422,
      data: formatEligibilityBlock(decision),
    };
  }

  const { data: opp } = await sb
    .from("sync_research_opportunities")
    .select("id, source_url, primary_source_url, source_evidence, status, opportunity_type")
    .eq("id", opportunityId)
    .maybeSingle();
  if (!opp) return { status: 404, data: { error: "opportunity not found" } };
  const hasProvenance =
    String(opp.primary_source_url ?? opp.source_url ?? "").trim() !== "" ||
    String(opp.source_evidence ?? "").trim() !== "";
  if (!hasProvenance) {
    return {
      status: 422,
      data: { error: "opportunity missing source provenance", code: "missing_sync_provenance" },
    };
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

  const attr = attributionFrom(ops);
  const row = {
    opportunity_id: opportunityId,
    track_id: trackId,
    song_dna_version_id: dna.songDnaVersionId,
    subject: clean.subject != null ? String(clean.subject) : null,
    body: bodyText,
    status: "draft",
    drafted_by: attr.actor_kind,
    drafted_by_label: attr.actor_label,
    batch_id: clean.batch_id ? String(clean.batch_id) : null,
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

  const attachRequested =
    clean.attach_split_sheet === true || clean.include_split_sheet === true;

  return {
    status: 200,
    data: {
      ok: true,
      draft: data,
      sent: false,
      approved: false,
      license_verified: false,
      monetary_authority: false,
      eligibility: decision,
      split_sheet_attached: false,
      split_sheet_delivery_policy: "request_only",
      ...(attachRequested ? { split_sheet_attach_ignored: true } : {}),
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

export async function getSyncDiscoveryWork(
  sb: SupabaseClient,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "read_sync_discovery_work");
  if (denied) return denied;

  const config = await loadSyncResearchConfig(sb);
  const activeIds = activeResearchTrackIds(config);
  const tracks: Record<string, unknown>[] = [];

  for (const trackId of activeIds) {
    const { data: t } = await sb
      .from("tracks")
      .select(
        "id, name, approved_song_dna_version_id, sync_eligible, sync_eligible_blockers, has_sample, assets_ready, splits_ready, publishing_ready",
      )
      .eq("id", trackId)
      .maybeSingle();
    if (!t) continue;

    const dna = await resolveCurrentApprovedDna(sb, { trackId });
    let dnaProjection: Record<string, unknown> | null = null;
    if (dna.ok && dna.songDnaVersionId) {
      const { data: dnaRow } = await sb
        .from("song_dna_versions")
        .select(
          "id, version_number, approval_state, primary_genre, secondary_genres, approved_lanes, excluded_lanes, mood_tags, context_tags, short_pitch, sample_declaration, sync_recommendation, payload",
        )
        .eq("id", dna.songDnaVersionId)
        .maybeSingle();
      if (dnaRow) {
        dnaProjection = {
          song_dna_version_id: dnaRow.id,
          version_number: dnaRow.version_number,
          approval_state: dnaRow.approval_state,
          primary_genre: dnaRow.primary_genre,
          secondary_genres: dnaRow.secondary_genres ?? [],
          allowed_positioning: dnaRow.approved_lanes ?? [],
          exclusions: dnaRow.excluded_lanes ?? [],
          descriptors: [
            ...(Array.isArray(dnaRow.mood_tags) ? dnaRow.mood_tags : []),
            ...(Array.isArray(dnaRow.context_tags) ? dnaRow.context_tags : []),
          ],
          short_pitch: dnaRow.short_pitch ?? null,
          sample_declaration: dnaRow.sample_declaration,
          sync_recommendation: dnaRow.sync_recommendation,
          // Never echo private license secrets — only whether DNA asserts need.
          requires_private_license:
            (dnaRow.payload as Record<string, unknown> | null)?.requires_private_license === true,
        };
      }
    }

    const eligibility = await computeTrackSyncEligibility(sb, trackId);
    const entry = config.tracks[trackId];
    tracks.push({
      track_id: trackId,
      title: t.name ?? entry?.label ?? null,
      research_status: "active_research",
      notes: entry?.notes ?? null,
      sync_eligible: !("error" in eligibility) && eligibility.eligible,
      // Server-derived only — Claude must not claim eligibility.
      eligibility_blockers: "error" in eligibility ? [] : eligibility.blockers,
      eligibility_reasons: "error" in eligibility ? [eligibility.error] : eligibility.reasons,
      approved_song_dna: dnaProjection,
      // Explicit: caller cannot set this; projection is read-only.
      may_draft_outreach: !("error" in eligibility) && eligibility.eligible,
      may_research: true,
    });
  }

  return {
    status: 200,
    data: {
      ok: true,
      actor: ops.label,
      business_date_ct: chicagoBusinessDate(),
      config_source: "ops_settings.sync_research_config",
      default_status: config.default_status,
      active_research_track_ids: activeIds,
      tracks,
      opportunity_types: OPPORTUNITY_TYPES,
      rules: {
        research_persists_when_eligibility_blocked: true,
        drafting_requires_server_eligibility: true,
        active_brief_requires_deadline: true,
        undated_directory_is_agency_introduction: true,
        never_claim_eligibility: true,
        never_approve_or_send: true,
      },
    },
  };
}

export async function submitSyncResearch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "submit_sync_research");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);

  const targets = Array.isArray(clean.targets) ? clean.targets : [];
  const opportunities = Array.isArray(clean.opportunities) ? clean.opportunities : [];
  const drafts = Array.isArray(clean.drafts) ? clean.drafts : [];

  const targetRows: unknown[] = [];
  const opportunityRows: unknown[] = [];
  const draftRows: unknown[] = [];
  const draftBlocked: unknown[] = [];

  for (const t of targets) {
    const res = await createSyncTarget(
      sb,
      typeof t === "object" && t ? (t as Record<string, unknown>) : {},
      ops,
    );
    if (res.status >= 400) return res;
    targetRows.push(res.data.row);
  }
  for (const o of opportunities) {
    const res = await createSyncOpportunity(
      sb,
      typeof o === "object" && o ? (o as Record<string, unknown>) : {},
      ops,
    );
    if (res.status >= 400) return res;
    opportunityRows.push(res.data.row);
  }
  for (const d of drafts) {
    const res = await draftSyncPitch(
      sb,
      typeof d === "object" && d ? (d as Record<string, unknown>) : {},
      ops,
    );
    if (res.status === 422 && res.data.code === "sync_eligibility_blocked") {
      draftBlocked.push(res.data);
      continue;
    }
    if (res.status >= 400) return res;
    draftRows.push(res.data.draft);
  }

  return {
    status: 200,
    data: {
      ok: true,
      targets: targetRows.length,
      opportunities: opportunityRows.length,
      drafts: draftRows.length,
      drafts_blocked: draftBlocked.length,
      draft_blocked_rows: draftBlocked,
      rows: { targets: targetRows, opportunities: opportunityRows, drafts: draftRows },
    },
  };
}

export async function advanceSyncBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await assertClaudeResearchCap(ops, "advance_sync_batch");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const attr = attributionFrom(ops);
  const config = await loadSyncResearchConfig(sb);
  const activeIds = activeResearchTrackIds(config);
  const trackId = clean.track_id
    ? String(clean.track_id).trim()
    : activeIds[0] ?? "";
  if (!trackId || !isActiveResearchTrack(config, trackId)) {
    return {
      status: 422,
      data: {
        error: "no active sync research track configured",
        code: "sync_research_track_inactive",
      },
    };
  }

  const businessDate = String(clean.business_date_ct ?? chicagoBusinessDate());
  const targetIds = Array.isArray(clean.target_ids) ? clean.target_ids.map(String) : [];
  const opportunityIds = Array.isArray(clean.opportunity_ids)
    ? clean.opportunity_ids.map(String)
    : [];
  const draftIds = Array.isArray(clean.draft_ids) ? clean.draft_ids.map(String) : [];

  let dnaId: string | null = null;
  const dna = await resolveCurrentApprovedDna(sb, { trackId });
  if (dna.ok) dnaId = dna.songDnaVersionId;

  const eligibility = await computeTrackSyncEligibility(sb, trackId);

  const { data: batch, error: bErr } = await sb
    .from("agh_handoff_batches")
    .insert({
      batch_kind: "sync",
      queue_state: "AWAITING_GROK_REVIEW",
      business_date_ct: businessDate,
      track_id: trackId,
      song_dna_version_id: dnaId,
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
      drafted_by: draftIds.length ? attr.actor_kind : null,
      drafted_by_label: draftIds.length ? attr.actor_label : null,
      raw_count: targetIds.length,
      verified_count: Number(clean.verified_count) || 0,
      opportunity_count: opportunityIds.length,
      drafted_count: draftIds.length,
      approved_count: 0,
      submitted_count: 0,
      rejected_count: 0,
      response_count: 0,
      record_count: targetIds.length + opportunityIds.length + draftIds.length,
      source_evidence_summary: clean.source_evidence_summary != null
        ? String(clean.source_evidence_summary)
        : null,
      notes: clean.notes != null ? String(clean.notes) : null,
      payload: {
        track_id: trackId,
        eligibility: "error" in eligibility ? { error: eligibility.error } : eligibility,
        target_ids: targetIds,
        opportunity_ids: opportunityIds,
        draft_ids: draftIds,
        shortfalls: clean.shortfalls ?? [],
        actor: attr.actor_kind,
      },
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (bErr) return { status: 500, data: { error: bErr.message } };

  const records: Record<string, unknown>[] = [];
  for (const id of targetIds) {
    records.push({
      batch_id: batch.id,
      record_kind: "sync_target",
      queue_state: "AWAITING_GROK_REVIEW",
      sync_target_id: id,
      dedupe_key: `sync_target:${id}`,
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
      song_dna_version_id: dnaId,
    });
  }
  for (const id of opportunityIds) {
    records.push({
      batch_id: batch.id,
      record_kind: "sync_opportunity",
      queue_state: "AWAITING_GROK_REVIEW",
      sync_opportunity_id: id,
      dedupe_key: `sync_opportunity:${id}`,
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
      song_dna_version_id: dnaId,
    });
  }
  for (const id of draftIds) {
    records.push({
      batch_id: batch.id,
      record_kind: "sync_pitch_draft",
      queue_state: "AWAITING_GROK_REVIEW",
      outreach_draft_id: null,
      dedupe_key: `sync_pitch_draft:${id}`,
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
      drafted_by: attr.actor_kind,
      drafted_by_label: attr.actor_label,
      song_dna_version_id: dnaId,
      packet: { sync_pitch_draft_id: id },
    });
  }
  if (records.length) {
    const { error: rErr } = await sb.from("agh_handoff_records").insert(records);
    if (rErr) return { status: 500, data: { error: rErr.message } };
  }

  // Link rows to batch when ids provided.
  if (targetIds.length) {
    await sb.from("sync_research_targets").update({ batch_id: batch.id }).in("id", targetIds);
  }
  if (opportunityIds.length) {
    await sb
      .from("sync_research_opportunities")
      .update({ batch_id: batch.id })
      .in("id", opportunityIds);
  }
  if (draftIds.length) {
    await sb
      .from("sync_research_pitch_drafts")
      .update({ batch_id: batch.id })
      .in("id", draftIds);
  }

  return {
    status: 200,
    data: {
      ok: true,
      batch,
      delivered_to: "grok_playlist_control",
      queue_state: "AWAITING_GROK_REVIEW",
      eligibility: "error" in eligibility ? null : eligibility,
      drafting_blocked: !("error" in eligibility) && !eligibility.eligible,
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
  if (!unscopedSyncReader(ops)) {
    q = q.eq("discovered_by", ops.kind);
  }
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  return {
    status: 200,
    data: { ok: true, rows: data ?? [], scoped: !unscopedSyncReader(ops) },
  };
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
    case "get_sync_discovery_work":
      return getSyncDiscoveryWork(sb, ops);
    case "submit_sync_research":
      return submitSyncResearch(sb, body, ops);
    case "advance_sync_batch":
      return advanceSyncBatch(sb, body, ops);
    case "list_sync_research_targets": {
      let q = sb
        .from("sync_research_targets")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(Math.min(Number(body.limit) || 50, 200));
      if (!unscopedSyncReader(ops)) {
        q = q.eq("discovered_by", ops.kind);
      }
      const { data, error } = await q;
      if (error) return { status: 500, data: { error: error.message } };
      return {
        status: 200,
        data: { ok: true, rows: data ?? [], scoped: !unscopedSyncReader(ops) },
      };
    }
    case "list_sync_research_opportunities": {
      let q = sb
        .from("sync_research_opportunities")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(Math.min(Number(body.limit) || 50, 200));
      if (!unscopedSyncReader(ops)) {
        q = q.eq("discovered_by", ops.kind);
      }
      if (body.opportunity_type) {
        q = q.eq("opportunity_type", String(body.opportunity_type));
      }
      const { data, error } = await q;
      if (error) return { status: 500, data: { error: error.message } };
      return {
        status: 200,
        data: { ok: true, rows: data ?? [], scoped: !unscopedSyncReader(ops) },
      };
    }
    default:
      return { status: 400, data: { error: `Unknown sync research action: ${action}` } };
  }
}

/** Re-export for MCP / tests. */
export type { SyncEligibilityDecision };
