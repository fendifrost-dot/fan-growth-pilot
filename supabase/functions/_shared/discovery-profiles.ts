/**
 * Database-managed discovery profiles — replaces hardcoded RAP/HOUSE subgenre
 * arrays and fixed rap/house allocation in runtime decision code.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";

export const DISCOVERY_PROFILE_ACTIONS = [
  "list_discovery_profiles",
  "upsert_discovery_profile",
  "deactivate_discovery_profile",
  "approve_discovery_profile",
] as const;

export function isDiscoveryProfileAction(action: string): boolean {
  return (DISCOVERY_PROFILE_ACTIONS as readonly string[]).includes(action);
}

export type DiscoveryProfile = {
  id: string;
  profile_key: string;
  label: string;
  is_active: boolean;
  approval_status: string;
  genre_family: string | null;
  included_search_terms: string[];
  excluded_search_terms: string[];
  reference_artists: string[];
  compatible_target_category_slugs: string[];
  search_weight: number;
  approved_lanes: string[];
  excluded_lanes: string[];
  matching_expression: string | null;
  allocation_share: number | null;
};

type Result = { status: number; data: Record<string, unknown> };

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function requireAdmin(actor: Actor | null): Result | null {
  if (!actor || actor.kind !== "user" || !actor.isAdmin) {
    return {
      status: 401,
      data: { error: "Discovery profile writes require Fendi’s authenticated admin JWT." },
    };
  }
  return null;
}

/** Validate matching_expression before save — invalid must not disable protections. */
export function validateMatchingExpression(expr: string | null | undefined): string | null {
  const raw = (expr ?? "").trim();
  if (!raw) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(raw, "i");
    return null;
  } catch (e) {
    return `Invalid matching_expression: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function loadActiveDiscoveryProfiles(
  sb: SupabaseClient,
  opts?: { requireApproved?: boolean },
): Promise<DiscoveryProfile[]> {
  let q = sb
    .from("discovery_profiles")
    .select(
      "id, profile_key, label, is_active, approval_status, genre_family, included_search_terms, excluded_search_terms, reference_artists, compatible_target_category_slugs, search_weight, approved_lanes, excluded_lanes, matching_expression, allocation_share",
    )
    .eq("is_active", true)
    .order("profile_key");
  if (opts?.requireApproved) {
    q = q.eq("approval_status", "approved");
  }
  const { data, error } = await q;
  if (error) {
    console.error("loadActiveDiscoveryProfiles:", error.message);
    return [];
  }
  return (data ?? []) as DiscoveryProfile[];
}

export function profilesToSweepBuckets(profiles: DiscoveryProfile[]): {
  rapTerms: string[];
  houseTerms: string[];
  rapShare: number;
  laneGenre: Record<string, "rap" | "house">;
  laneBlockPatterns: Record<string, string>;
} {
  const rap: string[] = [];
  const house: string[] = [];
  let rapWeight = 0;
  let houseWeight = 0;
  const laneGenre: Record<string, "rap" | "house"> = {};
  const laneBlockPatterns: Record<string, string> = {};

  for (const p of profiles) {
    const family = (p.genre_family ?? "").toLowerCase();
    const terms = p.included_search_terms ?? [];
    const share = Number(p.allocation_share ?? p.search_weight ?? 1) || 1;
    if (family === "rap" || family === "hip-hop" || family === "hiphop") {
      rap.push(...terms);
      rapWeight += share;
    } else if (family === "house" || family === "electronic") {
      house.push(...terms);
      houseWeight += share;
    } else {
      // Unknown family — still contribute terms to rap bucket by weight neutrality
      rap.push(...terms);
      house.push(...terms);
    }
    for (const lane of p.approved_lanes ?? []) {
      if (family === "rap" || family === "hip-hop" || family === "hiphop") {
        laneGenre[lane] = "rap";
      } else if (family === "house" || family === "electronic") {
        laneGenre[lane] = "house";
      }
    }
    if (p.matching_expression) {
      for (const lane of p.approved_lanes ?? []) {
        laneBlockPatterns[lane] = p.matching_expression;
      }
    }
  }

  const total = rapWeight + houseWeight;
  const rapShare = total > 0 ? rapWeight / total : 0.5;

  return {
    rapTerms: [...new Set(rap)],
    houseTerms: [...new Set(house)],
    rapShare,
    laneGenre,
    laneBlockPatterns,
  };
}

async function audit(
  sb: SupabaseClient,
  entry: {
    profileId: string;
    eventType: string;
    actor: Actor | null;
    previous?: unknown;
    next?: unknown;
    reason?: string;
  },
): Promise<void> {
  await sb.from("discovery_profile_audit_events").insert({
    discovery_profile_id: entry.profileId,
    event_type: entry.eventType,
    actor_user_id: entry.actor?.kind === "user" ? entry.actor.userId : null,
    previous_value: entry.previous ?? null,
    new_value: entry.next ?? null,
    reason: entry.reason ?? null,
  });
  await sb.from("agh_config_audit_events").insert({
    entity_type: "discovery_profile",
    entity_id: entry.profileId,
    event_type: entry.eventType,
    actor_user_id: entry.actor?.kind === "user" ? entry.actor.userId : null,
    previous_value: entry.previous ?? null,
    new_value: entry.next ?? null,
    reason: entry.reason ?? null,
  });
}

export async function handleDiscoveryProfileAction(
  sb: SupabaseClient,
  action: string,
  body: Record<string, unknown>,
  actor: Actor | null,
): Promise<Result> {
  if (action === "list_discovery_profiles") {
    const { data, error } = await sb.from("discovery_profiles").select("*").order("profile_key");
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { profiles: data ?? [] } };
  }

  const denied = requireAdmin(actor);
  if (denied) return denied;

  if (action === "upsert_discovery_profile") {
    const profileKey = String(body.profile_key ?? "").trim();
    if (!profileKey) return { status: 400, data: { error: "profile_key required" } };
    const exprErr = validateMatchingExpression(
      body.matching_expression == null ? null : String(body.matching_expression),
    );
    if (exprErr) return { status: 400, data: { error: exprErr } };

    const row = {
      profile_key: profileKey,
      label: String(body.label ?? profileKey).trim(),
      is_active: body.is_active !== false,
      genre_family: body.genre_family == null ? null : String(body.genre_family).trim(),
      included_search_terms: asStringArray(body.included_search_terms),
      excluded_search_terms: asStringArray(body.excluded_search_terms),
      reference_artists: asStringArray(body.reference_artists),
      compatible_target_category_slugs: asStringArray(body.compatible_target_category_slugs),
      search_weight: Number(body.search_weight ?? 1) || 1,
      approved_lanes: asStringArray(body.approved_lanes),
      excluded_lanes: asStringArray(body.excluded_lanes),
      matching_expression: body.matching_expression == null
        ? null
        : String(body.matching_expression).trim() || null,
      allocation_share: body.allocation_share == null ? null : Number(body.allocation_share),
      editor_user_id: actor!.kind === "user" ? actor!.userId : null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await sb
      .from("discovery_profiles")
      .select("*")
      .eq("profile_key", profileKey)
      .maybeSingle();

    const { data, error } = await sb
      .from("discovery_profiles")
      .upsert(
        {
          ...(existing?.id ? { id: existing.id } : {}),
          ...row,
          // Never silently approve via upsert
          approval_status: existing?.approval_status ?? "pending_fendi_review",
        },
        { onConflict: "profile_key" },
      )
      .select("*")
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    await audit(sb, {
      profileId: String(data!.id),
      eventType: existing ? "update" : "create",
      actor,
      previous: existing,
      next: data,
      reason: String(body.reason ?? "").trim() || undefined,
    });
    return { status: 200, data: { profile: data } };
  }

  if (action === "deactivate_discovery_profile") {
    const id = String(body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "id required" } };
    const { data: existing } = await sb.from("discovery_profiles").select("*").eq("id", id).maybeSingle();
    if (!existing) return { status: 404, data: { error: "profile not found" } };
    const { data, error } = await sb
      .from("discovery_profiles")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    await audit(sb, {
      profileId: id,
      eventType: "deactivate",
      actor,
      previous: existing,
      next: data,
      reason: String(body.reason ?? "deactivated"),
    });
    return { status: 200, data: { profile: data } };
  }

  if (action === "approve_discovery_profile") {
    const id = String(body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "id required" } };
    const { data: existing } = await sb.from("discovery_profiles").select("*").eq("id", id).maybeSingle();
    if (!existing) return { status: 404, data: { error: "profile not found" } };
    const { data, error } = await sb
      .from("discovery_profiles")
      .update({
        approval_status: "approved",
        approved_by: actor!.kind === "user" ? actor!.userId : null,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    await audit(sb, {
      profileId: id,
      eventType: "approve",
      actor,
      previous: existing,
      next: data,
      reason: String(body.reason ?? "fendi_approved"),
    });
    return { status: 200, data: { profile: data } };
  }

  return { status: 400, data: { error: `Unknown discovery profile action: ${action}` } };
}
