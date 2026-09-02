// Frontend client for the authenticated opportunities-api Edge Function.
//
// Unlike the old hubApi "URL secrecy" client, callHubFn now attaches the
// signed-in user's Supabase JWT so campaign writes can enforce admin role
// and derive Fendi activation identity server-side.

import { supabase } from "@/integrations/supabase/client";
import type { OpportunityStatus } from "@/lib/opportunities/types";

const BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function fnUrl(path: string): string {
  if (!BASE) throw new Error("VITE_SUPABASE_URL missing");
  return `${BASE.replace(/\/$/, "")}/functions/v1/opportunities-api${path}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ANON) headers["apikey"] = ANON;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function req<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(fnUrl(path), {
    method,
    headers: await authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
  return data as T;
}

// ---- Types mirrored from the API (kept minimal for the UI) ----------------
export interface OpportunityEntity {
  id: string;
  entity_type: string;
  name: string;
  canonical_url: string | null;
  platform: string | null;
  location: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Opportunity {
  id: string;
  entity_id: string;
  source_platform: string | null;
  opportunity_type: string;
  source_url: string | null;
  title: string;
  why_discovered: string | null;
  discovery_evidence: Record<string, unknown> | null;
  audience_match_score: number | null;
  relationship_score: number | null;
  reach_score: number | null;
  response_probability: number | null;
  conversion_probability: number | null;
  effort_score: number | null;
  risk_score: number | null;
  lifetime_value_score: number | null;
  opportunity_score: number | null;
  score_overridden: boolean;
  manual_score: number | null;
  recommended_song_id: string | null;
  recommended_start_seconds: number | null;
  recommended_end_seconds: number | null;
  recommended_action: string | null;
  generated_message: string | null;
  status: OpportunityStatus;
  discovered_at: string;
  snoozed_until: string | null;
  entity?: OpportunityEntity | null;
}

export interface RelationshipSummary {
  score: number;
  events: number;
  contacted: number;
  replied: number;
  positive: number;
  negative: number;
  placements: number;
  lastEventAt: string | null;
}

export interface ListResult {
  rows: Opportunity[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpportunityStats {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  avg_score: number | null;
}

export interface ListParams {
  status?: string[];
  opportunity_type?: string;
  source_platform?: string;
  entity_type?: string;
  song?: string;
  min_score?: number;
  max_risk?: number;
  min_relationship?: number;
  search?: string;
  order?: "score" | "recent";
  limit?: number;
  offset?: number;
}

function qs(params: ListParams): string {
  const p = new URLSearchParams();
  if (params.status?.length) p.set("status", params.status.join(","));
  if (params.opportunity_type) p.set("opportunity_type", params.opportunity_type);
  if (params.source_platform) p.set("source_platform", params.source_platform);
  if (params.entity_type) p.set("entity_type", params.entity_type);
  if (params.song) p.set("song", params.song);
  if (params.min_score != null) p.set("min_score", String(params.min_score));
  if (params.max_risk != null) p.set("max_risk", String(params.max_risk));
  if (params.min_relationship != null) p.set("min_relationship", String(params.min_relationship));
  if (params.search) p.set("search", params.search);
  if (params.order) p.set("order", params.order);
  if (params.limit != null) p.set("limit", String(params.limit));
  if (params.offset != null) p.set("offset", String(params.offset));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const opportunitiesApi = {
  list: (params: ListParams = {}) => req<ListResult>(`/opportunities${qs(params)}`),
  stats: () => req<OpportunityStats>(`/opportunities/stats`),
  get: (id: string) =>
    req<{ opportunity: Opportunity; relationship: RelationshipSummary | null }>(
      `/opportunities/${id}`,
    ),
  patch: (id: string, patch: Partial<Opportunity>) =>
    req<Opportunity>(`/opportunities/${id}`, "PATCH", patch),
  approve: (id: string) => req<Opportunity>(`/opportunities/${id}/approve`, "POST", {}),
  reject: (id: string) => req<Opportunity>(`/opportunities/${id}/reject`, "POST", {}),
  snooze: (id: string, until: string | null) =>
    req<Opportunity>(`/opportunities/${id}/snooze`, "POST", { snoozed_until: until }),
  setStatus: (id: string, to: OpportunityStatus) =>
    req<Opportunity>(`/opportunities/${id}/status`, "POST", { to }),
  generateAction: (id: string) =>
    req<Opportunity>(`/opportunities/${id}/generate-action`, "POST", {}),
  recordOutcome: (id: string, outcome: Record<string, unknown>) =>
    req<{ outcome: unknown; score: number | null }>(
      `/opportunities/${id}/record-outcome`,
      "POST",
      outcome,
    ),
  overrideScore: (id: string, manual_score: number, reason: string) =>
    req<Opportunity>(`/opportunities/${id}/override-score`, "POST", { manual_score, reason }),
};
