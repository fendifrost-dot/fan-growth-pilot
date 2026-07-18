-- Global deliverability rationing + first-class rationing outcomes.
--
-- The ceiling is a DOMAIN-HEALTH cap, not a product limit: it exists because a
-- warming sending domain can only absorb so much volume per day. It is meant to
-- RISE over time, so it lives in a table with an effective_from date rather
-- than being hardcoded in a function.
--
-- There is deliberately NO per-campaign aggregate cap. A campaign's only
-- self-imposed limit is its daily_target. Everything else is global.
--
-- Run this in the Lovable SQL Editor AFTER 20260718020000_pitch_taxonomy_and_runs.sql.

create table if not exists public.outreach_capacity_config (
  id uuid primary key default gen_random_uuid(),
  daily_ceiling integer not null check (daily_ceiling >= 0),
  effective_from date not null default current_date,
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (effective_from)
);

comment on table public.outreach_capacity_config is
  'Global daily deliverability ceiling by effective date. Raise as the sending domain warms; the row with the greatest effective_from <= today wins.';

-- Resolves today's ceiling. Falls back to a conservative 200/day if unset, so
-- a missing config row can never mean "unlimited".
create or replace function public.current_outreach_ceiling(_on date default current_date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select daily_ceiling
       from public.outreach_capacity_config
      where effective_from <= _on
      order by effective_from desc
      limit 1),
    200
  );
$$;

insert into public.outreach_capacity_config (daily_ceiling, effective_from, reason)
values (200, current_date, 'Initial ceiling while the sending domain warms.')
on conflict (effective_from) do nothing;

-- ---------------------------------------------------------------------------
-- Rationing is an OUTCOME, not a failure
-- ---------------------------------------------------------------------------
-- A campaign that got fewer sends because the global ceiling was hit is
-- operating correctly. Recording that as a failure would make a healthy,
-- rationed day indistinguishable from a broken one — so the outcome vocabulary
-- separates the two, and is_failure() is the single place that decides.

alter table public.pitch_runs drop constraint if exists pitch_runs_outcome_code_check;
alter table public.pitch_runs
  add constraint pitch_runs_outcome_code_check
  check (outcome_code is null or outcome_code in (
    'completed',
    'global_ceiling_reached',
    'insufficient_verified_supply',
    'all_targets_in_cooldown',
    'send_window_closed',
    'error'
  ));

alter table public.pitch_run_campaigns drop constraint if exists pitch_run_campaigns_outcome_code_check;
alter table public.pitch_run_campaigns
  add constraint pitch_run_campaigns_outcome_code_check
  check (outcome_code is null or outcome_code in (
    'completed',
    'global_ceiling_reached',
    'rationed',
    'insufficient_verified_supply',
    'all_targets_in_cooldown',
    'send_window_closed',
    'error'
  ));

-- Fair-allocation bookkeeping: how many passes the round-robin gave this
-- campaign, and whether it was cut short by the ceiling rather than by supply.
alter table public.pitch_run_campaigns
  add column if not exists rationed_by_ceiling boolean not null default false,
  add column if not exists allocation_passes integer not null default 0;

create or replace function public.outreach_outcome_is_failure(_code text)
returns boolean
language sql
immutable
as $$
  -- Only a true error is a failure. Ceiling rationing, empty supply, cooldown
  -- and a closed send window are all normal, explainable quiet days.
  select _code = 'error';
$$;
