-- Free/Paid placement support for playlist_targets.
--
-- `submission_cost` (text: 'free' | 'paid' | 'tip_appreciated' | 'unknown') was
-- added in 20260612_outreach_verification_gate.sql. This migration adds `is_paid`
-- as a STORED generated column derived from submission_cost so the two can never
-- drift: enrichment writes submission_cost, is_paid follows automatically.
--
--   paid              -> true
--   free | tip        -> false
--   unknown | null    -> null  (not yet determined)
--
-- Idempotent.

alter table public.playlist_targets
  add column if not exists is_paid boolean
    generated always as (
      case
        when submission_cost = 'paid' then true
        when submission_cost in ('free', 'tip_appreciated') then false
        else null
      end
    ) stored;

create index if not exists idx_playlist_targets_is_paid
  on public.playlist_targets (is_paid)
  where is_active = true;

comment on column public.playlist_targets.is_paid is
  'Generated from submission_cost: true=curator charges a placement fee, false=free/tip, null=unknown. Set submission_cost (not is_paid) during enrichment.';
