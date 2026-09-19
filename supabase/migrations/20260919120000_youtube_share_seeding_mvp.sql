-- YouTube native share seeding pilot — modular schema (MVP).
-- Apply via Lovable SQL Editor (paste, don't type). Idempotent / additive.
--
-- Separate from playlist/sync/DNA/licensing/press. Reuses shared infra
-- (public.has_role, admin RLS pattern) but creates NO parallel outreach system.
-- Validates whether YouTube-native share seeding moves impressions/views.
--
-- North star: a share counts only when VERIFIED. Measurement labels
-- "Observed Lift", never "Views Generated" — no causal attribution is asserted.

begin;

-- ---------------------------------------------------------------------------
-- 1. Campaigns — one per track/video lane (A / B / C).
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_campaigns (
  id uuid primary key default gen_random_uuid(),
  track_label text not null,
  -- Soft link to catalogue track (extension point) — nullable so the pilot
  -- never blocks on catalogue state and never disturbs the catalogue.
  track_id uuid references public.tracks(id) on delete set null,
  campaign_type text not null default 'catalog_resurface',
  youtube_video_id text,
  status text not null default 'disabled',
  -- Cultural-topical guardrails live with the campaign so operators see them
  -- every time they work the lane (no tragedy bait / misleading claims).
  content_guardrails text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_share_campaigns_type_check
    check (campaign_type in ('catalog_resurface', 'cultural_topical', 'current_release')),
  constraint youtube_share_campaigns_status_check
    check (status in ('active', 'paused', 'disabled')),
  -- Never let a campaign go active without a video to seed.
  constraint youtube_share_campaigns_active_needs_video
    check (status <> 'active' or (youtube_video_id is not null and length(btrim(youtube_video_id)) > 0))
);

create index if not exists youtube_share_campaigns_status_idx
  on public.youtube_share_campaigns (status, campaign_type);

alter table public.youtube_share_campaigns enable row level security;
drop policy if exists youtube_share_campaigns_admin_all on public.youtube_share_campaigns;
create policy youtube_share_campaigns_admin_all on public.youtube_share_campaigns
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_campaigns is
  'YouTube native share seeding lanes (A catalog_resurface / B cultural_topical / C current_release). Separate from playlist pitching.';

-- ---------------------------------------------------------------------------
-- 2. Targets — candidate creators/channels to ask for a share.
--    Score dimensions stored SEPARATELY. Do not overweight subscriber count.
--    funnel_stage is the authoritative pipeline position; qualification is a
--    distinct quality-gate axis so both can be filtered independently.
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_targets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.youtube_share_campaigns(id) on delete cascade,
  channel_name text not null,
  channel_url text,
  channel_youtube_id text,
  category text,
  subscriber_count integer,
  -- Score dimensions (0-100) stored separately, never collapsed to one number.
  audience_fit_score integer,
  activity_score integer,
  authenticity_score integer,
  share_probability_score integer,
  estimated_impact_score integer,
  -- Quality gate (distinct from pipeline position).
  qualification_status text not null default 'pending',
  disqualified_reason text,
  -- Authoritative 10-stage pipeline.
  funnel_stage text not null default 'discovered',
  notes text,
  discovered_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_share_targets_qualification_check
    check (qualification_status in ('pending', 'qualified', 'disqualified')),
  constraint youtube_share_targets_funnel_check
    check (funnel_stage in (
      'discovered', 'qualified', 'outreach_ready', 'contacted', 'responded',
      'agreed', 'shared', 'verified', 'performance_window', 'retest_candidate'
    )),
  constraint youtube_share_targets_score_ranges check (
    (audience_fit_score is null or audience_fit_score between 0 and 100) and
    (activity_score is null or activity_score between 0 and 100) and
    (authenticity_score is null or authenticity_score between 0 and 100) and
    (share_probability_score is null or share_probability_score between 0 and 100) and
    (estimated_impact_score is null or estimated_impact_score between 0 and 100)
  )
);

create index if not exists youtube_share_targets_campaign_idx
  on public.youtube_share_targets (campaign_id, funnel_stage);
create index if not exists youtube_share_targets_qualification_idx
  on public.youtube_share_targets (campaign_id, qualification_status);
create index if not exists youtube_share_targets_category_idx
  on public.youtube_share_targets (campaign_id, category);

alter table public.youtube_share_targets enable row level security;
drop policy if exists youtube_share_targets_admin_all on public.youtube_share_targets;
create policy youtube_share_targets_admin_all on public.youtube_share_targets
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_targets is
  'Share-seeding candidates. Scores stored separately; subscriber_count is one weak signal. funnel_stage = pipeline, qualification_status = quality gate.';

-- ---------------------------------------------------------------------------
-- 3. Moments — recommended timestamps + suggested post angles/captions.
--    Extension seam for moment intelligence:
--    Track → Video → Moment → Audience → Creator → Caption → Result.
--    Captions are SUGGESTIONS.
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_moments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.youtube_share_campaigns(id) on delete cascade,
  timestamp_seconds integer,
  timestamp_label text,
  angle text,
  suggested_caption text,
  why_audience_cares text,
  -- Audience segment this moment targets — extension point (nullable).
  audience_segment text,
  is_primary boolean not null default false,
  sort_rank integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_share_moments_ts_check
    check (timestamp_seconds is null or timestamp_seconds >= 0)
);

create index if not exists youtube_share_moments_campaign_idx
  on public.youtube_share_moments (campaign_id, sort_rank);

alter table public.youtube_share_moments enable row level security;
drop policy if exists youtube_share_moments_admin_all on public.youtube_share_moments;
create policy youtube_share_moments_admin_all on public.youtube_share_moments
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_moments is
  'Recommended timestamps + suggested angles/captions per campaign video. Captions are suggestions. Extension seam for moment intelligence.';

-- ---------------------------------------------------------------------------
-- 4. Outreach — the ask ("would you share this with your YouTube audience?").
--    NOT a playlist add. Optionally references a specific moment.
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_outreach (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.youtube_share_targets(id) on delete cascade,
  campaign_id uuid not null references public.youtube_share_campaigns(id) on delete cascade,
  moment_id uuid references public.youtube_share_moments(id) on delete set null,
  channel text not null default 'community_post',
  offer_type text not null default 'audience_share',
  suggested_caption text,
  message_body text,
  status text not null default 'draft',
  contacted_at timestamptz,
  responded_at timestamptz,
  response_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_share_outreach_status_check
    check (status in ('draft', 'ready', 'contacted', 'responded', 'agreed', 'declined'))
);

create index if not exists youtube_share_outreach_target_idx
  on public.youtube_share_outreach (target_id, created_at desc);
create index if not exists youtube_share_outreach_campaign_idx
  on public.youtube_share_outreach (campaign_id, status);

alter table public.youtube_share_outreach enable row level security;
drop policy if exists youtube_share_outreach_admin_all on public.youtube_share_outreach;
create policy youtube_share_outreach_admin_all on public.youtube_share_outreach
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_outreach is
  'Share asks (audience_share offer, not playlist add). References a moment when one is chosen.';

-- ---------------------------------------------------------------------------
-- 5. Events — the verification ledger. A share COUNTS ONLY WHEN VERIFIED.
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_events (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.youtube_share_targets(id) on delete cascade,
  campaign_id uuid not null references public.youtube_share_campaigns(id) on delete cascade,
  moment_id uuid references public.youtube_share_moments(id) on delete set null,
  share_type text not null default 'community_post',
  share_url text,
  verification_status text not null default 'pending',
  observed_at timestamptz,
  verified_at timestamptz,
  verified_by text,
  verified_by_label text,
  rejected_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint youtube_share_events_type_check
    check (share_type in ('community_post', 'timestamp_share', 'creator_share', 'comment', 'other')),
  constraint youtube_share_events_verification_check
    check (verification_status in ('pending', 'verified', 'rejected'))
);

create index if not exists youtube_share_events_campaign_idx
  on public.youtube_share_events (campaign_id, verification_status);
create index if not exists youtube_share_events_target_idx
  on public.youtube_share_events (target_id, created_at desc);

alter table public.youtube_share_events enable row level security;
drop policy if exists youtube_share_events_admin_all on public.youtube_share_events;
create policy youtube_share_events_admin_all on public.youtube_share_events
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_events is
  'Share verification ledger. verification_status=verified is the only state that counts as a real share.';

-- ---------------------------------------------------------------------------
-- 6. Metrics — baselines + measurement windows. Observed Lift, not attribution.
-- ---------------------------------------------------------------------------
create table if not exists public.youtube_share_metrics (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.youtube_share_campaigns(id) on delete cascade,
  target_id uuid references public.youtube_share_targets(id) on delete set null,
  share_event_id uuid references public.youtube_share_events(id) on delete set null,
  window_label text not null,
  captured_at timestamptz not null default now(),
  impressions bigint,
  views bigint,
  likes bigint,
  comments bigint,
  source text not null default 'manual',
  notes text,
  created_at timestamptz not null default now(),
  constraint youtube_share_metrics_window_check
    check (window_label in ('baseline', 'plus_24h', 'plus_72h', 'plus_7d'))
);

create index if not exists youtube_share_metrics_campaign_idx
  on public.youtube_share_metrics (campaign_id, window_label, captured_at desc);

alter table public.youtube_share_metrics enable row level security;
drop policy if exists youtube_share_metrics_admin_all on public.youtube_share_metrics;
create policy youtube_share_metrics_admin_all on public.youtube_share_metrics
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

comment on table public.youtube_share_metrics is
  'Baseline + +24h/+72h/+7d capture windows. UI computes Observed Lift (window vs baseline). No causal attribution is asserted.';

-- ---------------------------------------------------------------------------
-- 7. Seed the three pilot campaigns (idempotent — guarded by NOT EXISTS).
--    Track C (current_release) stays disabled with null video: outreach blocked.
-- ---------------------------------------------------------------------------
insert into public.youtube_share_campaigns (track_label, campaign_type, youtube_video_id, status, notes)
select 'Exhausting', 'catalog_resurface', 'KHkEVlc_Z4w', 'active',
       'Track A — catalog resurface pilot.'
where not exists (
  select 1 from public.youtube_share_campaigns where campaign_type = 'catalog_resurface'
);

insert into public.youtube_share_campaigns (track_label, campaign_type, youtube_video_id, status, content_guardrails, notes)
select 'The Real Die Young', 'cultural_topical', 'qjEjPEc798A', 'active',
       'Chicago music history / Young Pappy-adjacent interest / nostalgia / reaction. NO tragedy bait, misleading claims, artificial controversy, or disrespectful memorial marketing.',
       'Track B — cultural topical pilot.'
where not exists (
  select 1 from public.youtube_share_campaigns where campaign_type = 'cultural_topical'
);

insert into public.youtube_share_campaigns (track_label, campaign_type, youtube_video_id, status, notes)
select 'Current Video', 'current_release', null, 'disabled',
       'Track C — disabled placeholder until an AVT MV is assigned. Outreach blocked while disabled / no video.'
where not exists (
  select 1 from public.youtube_share_campaigns where campaign_type = 'current_release'
);

commit;
