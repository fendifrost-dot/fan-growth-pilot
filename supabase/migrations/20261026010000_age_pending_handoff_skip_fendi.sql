-- Hourly pending-review aging must leave Fendi-authored drafts alone.
--
-- Apply via Lovable SQL Editor (paste). Do not run this from the Supabase CLI.
-- This file only replaces public.agh_age_pending_handoff_records. It does not
-- insert, update, or delete handoff records, batches, or outreach drafts, and
-- it does not move record 79fd174a (or any other row) back.
--
-- pg_cron job 3 (agh-handoff-backlog-maintenance, 15 * * * *) calls
-- agh_handoff_backlog_maintenance, which calls this function with dry_run
-- false. On 2026-10-16 that sweep moved handoff record 79fd174a into a
-- ROUTE_HOLD repair batch. That record is linked to outreach draft 1c91b9c8
-- (generated_by = 'fendi'). Fendi-authored drafts and their records are not
-- automation work.
--
-- Selection is otherwise the same as
-- 20261013150000_handoff_backlog_rollup_promotion.sql: playlist batches,
-- AWAITING_GROK_REVIEW, not yet submitted, older than p_max_age (default 7
-- days). A missing draft, or a draft whose generated_by is anything other
-- than fendi, is still eligible. Dry-run still writes nothing.
--
-- Preview only (does not move rows):
--   select public.agh_age_pending_handoff_records(true);
-- Fendi-linked rows in that result are a failure. This lists the ones that
-- must stay out of record_ids:
--   select r.id
--     from public.agh_handoff_records r
--     join public.agh_handoff_batches b on b.id = r.batch_id
--     join public.outreach_drafts d on d.id = r.outreach_draft_id
--    where b.batch_kind = 'playlist'
--      and r.queue_state = 'AWAITING_GROK_REVIEW'
--      and r.submitted_at is null
--      and r.created_at < now() - interval '7 days'
--      and d.generated_by = 'fendi';

begin;

create or replace function public.agh_age_pending_handoff_records(
  p_dry_run boolean default true,
  p_max_age interval default interval '7 days'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_ids jsonb;
  v_batches jsonb;
  v_hold jsonb;
  v_count int;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'record_id', r.id,
           'code', 'pending_review_aged',
           'reason', 'Pending review longer than 7 days; returned for route re-verification'
         ) order by r.created_at), '[]'::jsonb),
         coalesce(jsonb_agg(r.id order by r.created_at), '[]'::jsonb),
         coalesce(jsonb_agg(distinct r.batch_id), '[]'::jsonb),
         count(*)
    into v_items, v_ids, v_batches, v_count
    from public.agh_handoff_records r
    join public.agh_handoff_batches b on b.id = r.batch_id
    left join public.outreach_drafts d on d.id = r.outreach_draft_id
   where b.batch_kind = 'playlist'
     and r.queue_state = 'AWAITING_GROK_REVIEW'
     and r.submitted_at is null
     and r.created_at < now() - p_max_age
     and coalesce(d.generated_by,'') <> 'fendi';

  if not p_dry_run and v_items <> '[]'::jsonb then
    v_hold := public.agh_route_hold_records(v_items, 'pending_review_age');
    if coalesce((v_hold->>'ok')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'dry_run', false, 'error', v_hold, 'pending_records', v_count);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'max_age', p_max_age,
    'pending_records', v_count,
    'record_ids', v_ids,
    'batch_ids', v_batches,
    'held', case when p_dry_run then '[]'::jsonb else coalesce(v_hold->'held', '[]'::jsonb) end,
    'note', 'Aged records go to a CLAUDE_BATCH_READY repair batch. They are not rejected and not approved.'
  );
end;
$$;

revoke all on function public.agh_age_pending_handoff_records(boolean, interval) from public, anon, authenticated;
grant execute on function public.agh_age_pending_handoff_records(boolean, interval) to service_role;

commit;
