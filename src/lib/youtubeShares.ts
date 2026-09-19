// Shared types + constants for the YouTube native share-seeding pilot.
// Mirrors supabase/functions/_shared/youtube-shares.ts. Kept in one place so the
// admin surfaces stay consistent with the edge handlers.

export const YT_CAMPAIGN_TYPES = ["catalog_resurface", "cultural_topical", "current_release"] as const;
export type YtCampaignType = (typeof YT_CAMPAIGN_TYPES)[number];

export const YT_CAMPAIGN_STATUSES = ["active", "paused", "disabled"] as const;
export type YtCampaignStatus = (typeof YT_CAMPAIGN_STATUSES)[number];

export const YT_QUALIFICATION = ["pending", "qualified", "disqualified"] as const;
export type YtQualification = (typeof YT_QUALIFICATION)[number];

// Discovered → Qualified → Outreach Ready → Contacted → Responded → Agreed →
// Shared → Verified → Performance Window → Retest Candidate
export const YT_FUNNEL_STAGES = [
  "discovered",
  "qualified",
  "outreach_ready",
  "contacted",
  "responded",
  "agreed",
  "shared",
  "verified",
  "performance_window",
  "retest_candidate",
] as const;
export type YtFunnelStage = (typeof YT_FUNNEL_STAGES)[number];

export const YT_OUTREACH_STATUSES = ["draft", "ready", "contacted", "responded", "agreed", "declined"] as const;
export type YtOutreachStatus = (typeof YT_OUTREACH_STATUSES)[number];

export const YT_SHARE_TYPES = ["community_post", "timestamp_share", "creator_share", "comment", "other"] as const;
export type YtShareType = (typeof YT_SHARE_TYPES)[number];

export const YT_METRIC_WINDOWS = ["baseline", "plus_24h", "plus_72h", "plus_7d"] as const;
export type YtMetricWindow = (typeof YT_METRIC_WINDOWS)[number];

export const YT_SCORE_FIELDS = [
  { key: "audience_fit_score", label: "Audience fit" },
  { key: "activity_score", label: "Activity" },
  { key: "authenticity_score", label: "Authenticity" },
  { key: "share_probability_score", label: "Share prob." },
  { key: "estimated_impact_score", label: "Est. impact" },
] as const;

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const WINDOW_LABEL: Record<YtMetricWindow, string> = {
  baseline: "Baseline",
  plus_24h: "+24h",
  plus_72h: "+72h",
  plus_7d: "+7d",
};

export type YtCampaign = {
  id: string;
  track_label: string;
  track_id: string | null;
  campaign_type: YtCampaignType;
  youtube_video_id: string | null;
  status: YtCampaignStatus;
  content_guardrails: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type YtTarget = {
  id: string;
  campaign_id: string;
  channel_name: string;
  channel_url: string | null;
  channel_youtube_id: string | null;
  category: string | null;
  subscriber_count: number | null;
  audience_fit_score: number | null;
  activity_score: number | null;
  authenticity_score: number | null;
  share_probability_score: number | null;
  estimated_impact_score: number | null;
  qualification_status: YtQualification;
  disqualified_reason: string | null;
  funnel_stage: YtFunnelStage;
  notes: string | null;
  discovered_by: string | null;
  created_at: string;
  updated_at: string;
};

export type YtMoment = {
  id: string;
  campaign_id: string;
  timestamp_seconds: number | null;
  timestamp_label: string | null;
  angle: string | null;
  suggested_caption: string | null;
  why_audience_cares: string | null;
  audience_segment: string | null;
  is_primary: boolean;
  sort_rank: number;
};

export type YtEvent = {
  id: string;
  target_id: string;
  campaign_id: string;
  moment_id: string | null;
  share_type: YtShareType;
  share_url: string | null;
  verification_status: "pending" | "verified" | "rejected";
  observed_at: string | null;
  verified_at: string | null;
  verified_by_label: string | null;
  rejected_reason: string | null;
  notes: string | null;
  created_at: string;
};

export type YtMeasurementWindow = {
  window_label: string;
  present: boolean;
  captured_at: string | null;
  impressions: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  observed_lift: {
    impressions: number | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
  };
};
