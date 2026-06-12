-- Outreach verification gate + categorized playlist targets + test-data isolation.
-- Idempotent.

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

update public.playlist_targets
   set contact_method = submission_method
 where contact_method = 'unknown'
   and submission_method in ('email','web_form','instagram_dm','twitter_dm','tiktok_dm','discord','spotify_for_artists','soundcloud_dm','other');

create index if not exists idx_pt_status_platform on public.playlist_targets (verification_status, platform);
create index if not exists idx_pt_contact_method  on public.playlist_targets (contact_method);

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

create table if not exists public.domain_blocklist (
  domain     text primary key,
  reason     text not null,
  added_at   timestamptz not null default now(),
  added_by   text
);

create table if not exists public.non_curator_domains (
  domain     text primary key,
  category   text,
  notes      text,
  added_at   timestamptz not null default now()
);

grant select on public.domain_blocklist to authenticated;
grant all on public.domain_blocklist to service_role;
grant select on public.non_curator_domains to authenticated;
grant all on public.non_curator_domains to service_role;

insert into public.non_curator_domains (domain, category, notes) values
  ('city.ac.uk',   'academic',    'UK university — academic emails are not playlist curators'),
  ('loanbrook.com','lending',     'Consumer lending business'),
  ('shopoff.com',  'real_estate', 'Commercial real estate firm'),
  ('viberate.com', 'analytics',   'Music data/analytics SaaS, not a curator')
on conflict (domain) do nothing;

insert into public.domain_blocklist (domain, reason) values
  ('noreply.form', 'invalid_tld')
on conflict (domain) do nothing;

update public.playlist_targets pt
   set verification_status = 'manually_verified',
       last_verified_at    = now()
 where verification_status = 'unverified'
   and exists (
     select 1 from public.pitch_log pl
      where pl.playlist_id = pt.playlist_id
        and pl.status = 'sent'
   );

update public.outreach_drafts
   set env = 'test', is_test = true
 where recipient = 'fendifrost@gmail.com'
    or recipient like '%@srv1.mail-tester.com';