// Opportunity Engine — shared types for the Phase-1 service layer.
//
// Runtime-agnostic: no imports from the browser Supabase client, no DOM, no Deno
// globals. This lets the SAME module be consumed by Vite (frontend), vitest
// (Node tests), and the Deno `opportunities-api` Edge Function — one source of
// truth for the deterministic logic, no drift.

export const ENTITY_TYPES = [
  "playlist",
  "creator",
  "conversation",
  "dj",
  "radio_station",
  "radio_program",
  "publication",
  "journalist",
  "newsletter",
  "podcast",
  "event",
  "venue",
  "community",
  "brand",
  "collaborator",
  "fan",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = [
  "new",
  "reviewing",
  "approved",
  "rejected",
  "snoozed",
  "in_progress",
  "contacted",
  "responded",
  "converted",
  "closed",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

// Opportunity types are intentionally open (new channels arrive in Phase 2-6),
// so this is a documented convention list rather than a closed union.
export const KNOWN_OPPORTUNITY_TYPES = [
  "playlist_pitch",
  "creator_collab",
  "radio_play",
  "dj_support",
  "press_feature",
  "event_booking",
  "conversation_reply",
  "fan_activation",
  "referral",
  "newsletter_feature",
  "podcast_feature",
] as const;

export interface ScoreComponents {
  audience_match_score: number;
  relationship_score: number;
  reach_score: number;
  response_probability: number;
  conversion_probability: number;
  effort_score: number;
  lifetime_value_score: number;
  risk_score: number;
}

export type ScoreComponentKey = keyof ScoreComponents;

export type ScoreWeights = ScoreComponents;

/**
 * Signals fed to the deterministic scorer. All optional — the scorer degrades to
 * documented neutral defaults when a signal is absent, and never invents data.
 */
export interface ScoreInput {
  /** 0..1 audience/creative fit (e.g. from creative-match). */
  audienceFit?: number | null;
  /** Existing relationship strength 0..100 (RIE score or aggregated events). */
  relationshipScore?: number | null;
  /** Raw audience size (followers/subscribers/reach). */
  audienceSize?: number | null;
  /** 0..1 how warm/known the contact is (drives response probability). */
  warmth?: number | null;
  /** 0..1 historic conversion rate for this channel/type. */
  historicConversion?: number | null;
  /** 0..1 how much manual effort the play needs (1 = very high effort). */
  effort?: number | null;
  /** 0..1 risk that acting harms us (fraud, pay-to-play, ToS). 1 = very risky. */
  risk?: number | null;
  /** Rough monetary/lifetime value ceiling in dollars, if known. */
  valueCeiling?: number | null;
  /** Do we actually have a way to contact them? Missing contact raises effort. */
  hasContact?: boolean | null;
}

export interface GrowthEntityInput {
  entity_type: EntityType;
  name: string;
  canonical_url?: string | null;
  platform?: string | null;
  platform_external_id?: string | null;
  description?: string | null;
  location?: string | null;
  metadata?: Record<string, unknown>;
  playlist_target_id?: string | null;
  radio_target_id?: string | null;
  relationship_id?: string | null;
}

export interface GrowthOpportunityInput {
  entity_id: string;
  source_platform?: string | null;
  opportunity_type: string;
  source_url?: string | null;
  title: string;
  why_discovered?: string | null;
  discovery_evidence?: Record<string, unknown>;
  recommended_song_id?: string | null;
  recommended_start_seconds?: number | null;
  recommended_end_seconds?: number | null;
  recommended_action?: string | null;
  generated_message?: string | null;
  /** Optional precomputed signals; if omitted the repository scores neutrally. */
  scoreInput?: ScoreInput;
}

export interface RelationshipEvent {
  event_type: string;
  direction?: "inbound" | "outbound" | "system";
  weight?: number;
  occurred_at?: string;
}

export interface RelationshipSummary {
  score: number; // 0..100
  events: number;
  contacted: number;
  replied: number;
  positive: number;
  negative: number;
  placements: number;
  lastEventAt: string | null;
}

export interface OutcomeRow {
  outcome_type: string;
  succeeded?: boolean | null;
  response_received?: boolean | null;
  converted?: boolean | null;
  conversion_value?: number | null;
  responded_at?: string | null;
  converted_at?: string | null;
  created_at?: string | null;
}

export interface OutcomeState {
  contacted: boolean;
  responded: boolean;
  converted: boolean;
  conversionValue: number;
  latestOutcomeAt: string | null;
  /** Suggested opportunity status derived from the outcome timeline. */
  derivedStatus: OpportunityStatus | null;
}

export interface SongProfileLike {
  mood_tags?: string[] | null;
  genre_tags?: string[] | null;
  sonic_descriptors?: string[] | null;
  similar_artists?: string[] | null;
  energy?: number | null;
}

export interface EntityMatchLike {
  entity_type?: string | null;
  metadata?: Record<string, unknown> | null;
}
