-- Rejected and deferred server-side route fetches.
-- Apply via Lovable SQL Editor (paste). Idempotent.
--
-- Expected result: table public.agh_route_fetch_outcomes created
-- (or left in place), indexes and the admin policy replaced, and
-- 0 playlist_targets rows changed. This migration does not insert
-- targets and does not call route-hold or recertify functions.
--
-- A row is a fetch outcome, not a playlist target. Discovery reads
-- the latest row for a route URL and skips a repeat fetch while a
-- rejection is under 7 days old or a deferral is under 30 minutes old.

begin;

create table if not exists public.agh_route_fetch_outcomes (
  id uuid primary key default gen_random_uuid(),
  playlist_id text,
  route_url text not null,
  disposition text not null check (disposition in ('rejected', 'deferred')),
  failure_code text not null,
  http_status integer,
  fetched_at timestamptz not null,
  evidence_summary text,
  created_at timestamptz not null default now(),
  constraint agh_route_fetch_outcomes_route_len check (char_length(route_url) <= 2000),
  constraint agh_route_fetch_outcomes_playlist_len check (
    playlist_id is null or char_length(playlist_id) <= 200
  ),
  constraint agh_route_fetch_outcomes_code_len check (char_length(failure_code) <= 80),
  constraint agh_route_fetch_outcomes_summary_len check (
    evidence_summary is null or char_length(evidence_summary) <= 240
  ),
  constraint agh_route_fetch_outcomes_http_status check (
    http_status is null or (http_status >= 100 and http_status <= 599)
  )
);

create index if not exists agh_route_fetch_outcomes_route_fetched_idx
  on public.agh_route_fetch_outcomes (route_url, fetched_at desc);

create index if not exists agh_route_fetch_outcomes_playlist_idx
  on public.agh_route_fetch_outcomes (playlist_id, fetched_at desc);

comment on table public.agh_route_fetch_outcomes is
  'Rejected and deferred server-side route fetches. Not playlist targets. No page bodies or curator emails.';

comment on column public.agh_route_fetch_outcomes.playlist_id is
  'Curator playlist id the fetch was for. Null when verification had no playlist id.';
comment on column public.agh_route_fetch_outcomes.route_url is
  'Normalized submission route URL (https, no userinfo, no fragment, no tracking or email query params).';
comment on column public.agh_route_fetch_outcomes.disposition is
  'rejected: login wall, paywall, captcha, dead form, follow gate, closed submissions, or SSRF. deferred: timeout, 5xx, or DNS.';
comment on column public.agh_route_fetch_outcomes.failure_code is
  'Machine code: login_required, paywall_or_pay_to_play, captcha, dead, follow_gate, submissions_closed, ssrf_refused, instagram_not_scraped, timeout, dns, http_5xx, network, too_many_redirects.';
comment on column public.agh_route_fetch_outcomes.evidence_summary is
  'Short note: failure code, HTTP status, and a redacted page title. Not the page body.';

alter table public.agh_route_fetch_outcomes enable row level security;

drop policy if exists agh_route_fetch_outcomes_admin_all on public.agh_route_fetch_outcomes;
create policy agh_route_fetch_outcomes_admin_all on public.agh_route_fetch_outcomes
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

revoke all on table public.agh_route_fetch_outcomes from public, anon, authenticated;
grant select on table public.agh_route_fetch_outcomes to authenticated;
grant select, insert on table public.agh_route_fetch_outcomes to service_role;

commit;
