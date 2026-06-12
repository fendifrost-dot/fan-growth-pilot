-- Outreach verification gate + categorized playlist targets + test-data isolation.
--
-- CONTRACT FILE. Deploy source of truth for this project is the Lovable dashboard
-- (see supabase/config.toml), so this file is NOT auto-applied by a push. It is the
-- canonical column/table-name contract that the edge-function + admin-UI code in this
-- same commit is written against. Apply this SQL verbatim in the Lovable SQL editor so
-- the names match; if you rename anything, update the code references too.
--
-- Idempotent: every statement is IF NOT EXISTS / additive. Safe to re-run.
-- NOTE: playlist_targets.platform, .submission_url and .submission_method ALREADY EXIST
-- from earlier migrations — they are intentionally NOT re-added here.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. playlist_targets: categorization + verification state
-- ───────────────────────────────────────────────────────────────────────────
alter table public.playlist_targets
  add column if not exists contact_method      text not null default 'unknown',
  add column if not exists submission_cost     text not null default 'unknown',
  add column if not exists curator_handle      text,
  add column if not exists curator_url         text,
  add column if not exists verification_status text not null default 'unverified',
  add column if not exists verification_notes  text,
  add column if not exists last_verified_at    timestamptz,
  add column if not exists last_bounced_at     timestamptz,
  add column if not exists bounce_count        int  not null default 0;

-- CHECK constraints (added separately so re-runs don't fail if they already exist).
do $$ begin
  alter table public.playlist_targets
    add constraint playlist_targets_contact_method_chk
    check (contact_method in ('email','web_form','instagram_dm','twitter_dm','tiktok_dm','discord','spotify_for_artists','soundcloud_dm','other','unknown'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.playlist_targets
    add constraint playlist_targets_submission_cost_chk
    check (submission_cost in ('free','paid','tip_appreciated','unknown'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.playlist_targets
    add constraint playlist_targets_verification_status_chk
    check (verification_status in ('unverified','auto_verified','manually_verified','rejected','bounced','spam_flagged'));
exception when duplicate_object then null; end $$;

-- Seed contact_method from the pre-existing submission_method where possible (overlapping field).
update public.playlist_targets
   set contact_method = submission_method
 where contact_method = 'unknown'
   and submission_method in ('email','web_form','instagram_dm','twitter_dm','tiktok_dm','discord','spotify_for_artists','soundcloud_dm','other');

create index if not exists idx_pt_status_platform on public.playlist_targets (verification_status, platform);
create index if not exists idx_pt_contact_method  on public.playlist_targets (contact_method);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. outreach_drafts: denormalized platform + env / test isolation
-- ───────────────────────────────────────────────────────────────────────────
alter table public.outreach_drafts
  add column if not exists platform       text,
  add column if not exists streaming_link text,
  add column if not exists is_test        boolean not null default false,
  add column if not exists env            text    not null default 'production';

do $$ begin
  alter table public.outreach_drafts
    add constraint outreach_drafts_env_chk check (env in ('production','staging','test'));
exception when duplicate_object then null; end $$;

create index if not exists idx_od_env_status on public.outreach_drafts (env, status);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Blocklist + non-curator domain tables
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.domain_blocklist (
  domain     text primary key,
  reason     text not null,            -- invalid_tld | bounce | spam_flag | non_curator | manual
  added_at   timestamptz not null default now(),
  added_by   text
);

create table if not exists public.non_curator_domains (
  domain     text primary key,
  category   text,                     -- lending | real_estate | analytics | academic | ...
  notes      text,
  added_at   timestamptz not null default now()
);

-- Seed from the 6/12 audit.
insert into public.non_curator_domains (domain, category, notes) values
  ('city.ac.uk',   'academic',    'UK university — academic emails are not playlist curators'),
  ('loanbrook.com','lending',     'Consumer lending business'),
  ('shopoff.com',  'real_estate', 'Commercial real estate firm'),
  ('viberate.com', 'analytics',   'Music data/analytics SaaS, not a curator')
on conflict (domain) do nothing;

insert into public.domain_blocklist (domain, reason) values
  ('noreply.form', 'invalid_tld')
on conflict (domain) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Backfill verification_status for existing rows
--    Genuine curators (a successful send in pitch_log) → manually_verified.
--    Everything else stays unverified and flows through the review queue.
-- ───────────────────────────────────────────────────────────────────────────
update public.playlist_targets pt
   set verification_status = 'manually_verified',
       last_verified_at    = now()
 where verification_status = 'unverified'
   and exists (
     select 1 from public.pitch_log pl
      where pl.playlist_id = pt.playlist_id
        and pl.status = 'sent'
   );

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Move existing test/dev drafts out of the production queue
-- ───────────────────────────────────────────────────────────────────────────
update public.outreach_drafts
   set env = 'test', is_test = true
 where recipient = 'fendifrost@gmail.com'
    or recipient like '%@srv1.mail-tester.com';
