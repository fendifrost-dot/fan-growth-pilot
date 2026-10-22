-- Roll agh_handoff_batches to SENT when every record is already SENT.
--
-- Apply via Lovable SQL Editor (paste). Do not run this from the Supabase CLI.
-- This file does not send email, does not insert pitch_log, and does not update
-- agh_handoff_records or outreach_drafts. submitted_at is not set, so quota and
-- manual receipts stay put. Safe to run again: a batch already at SENT is left
-- alone, including its sent_by.
--
-- sent_by comes from the records' approver, then the linked draft approver, then
-- the pitch_log row named by packet.email_dispatch. A route name stored in
-- dispatched_via (execute-pitch, send-pitch-email, log_pitch_sent,
-- submit_sync_outreach) is not an actor. generated_by='fendi' drafts are not
-- touched, and a batch that includes one is not rolled.
--
-- Batches this backfill moves, as of 2026-10-22. Every record in each is SENT.
--   APPROVED_FOR_SEND:
--     0332f2aa-da2b-4530-be35-85d086341649
--     94dd3881-fab2-4096-a2a5-3f565593cc0e
--     89302ebe-9f40-415a-8aa3-bae47ca82282
--     a5b61bee-88e9-426a-9e28-baa2288f67c5
--     4f2bbad3-496a-4f3b-9b3d-663a732620cb
--     d7af2f98-5955-4611-b7ad-4706afa99d29
--     addd70ff-17c1-4363-b884-a3dd5a9a8bd6
--   IMPORTED_TO_AGH:
--     219b7c3f-7c16-4106-9210-0bbeedc13fe5
--     8129e879-c814-4a51-aa73-9c57f5a44408
--     f4229e77-9fe6-4271-bf3d-f5dc457c33f9
begin;

create or replace function public.agh_backfill_handoff_batch_sent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ids jsonb := '[]'::jsonb;
begin
  with linked as (
    select
      r.batch_id,
      r.updated_at,
      r.approved_by,
      r.approved_by_label,
      coalesce(
        r.outreach_draft_id,
        case
          when coalesce(r.packet->>'outreach_draft_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (r.packet->>'outreach_draft_id')::uuid
        end
      ) as draft_id,
      case
        when coalesce(r.packet->'email_dispatch'->>'pitch_log_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (r.packet->'email_dispatch'->>'pitch_log_id')::uuid
      end as dispatch_pitch_id
    from public.agh_handoff_records r
  ),
  actors as (
    select
      l.batch_id,
      l.updated_at,
      coalesce(
        nullif(trim(l.approved_by), ''),
        nullif(trim(d.approved_by), ''),
        nullif(trim(p.approved_by), ''),
        case
          when nullif(trim(p.dispatched_via), '') in (
            'execute-pitch',
            'send-pitch-email',
            'log_pitch_sent',
            'submit_sync_outreach'
          ) then null
          else nullif(trim(p.dispatched_via), '')
        end
      ) as sent_by,
      coalesce(
        nullif(trim(l.approved_by_label), ''),
        nullif(trim(l.approved_by), ''),
        nullif(trim(d.approved_by), ''),
        nullif(trim(p.approved_by), ''),
        case
          when nullif(trim(p.dispatched_via), '') in (
            'execute-pitch',
            'send-pitch-email',
            'log_pitch_sent',
            'submit_sync_outreach'
          ) then null
          else nullif(trim(p.dispatched_via), '')
        end
      ) as sent_by_label
    from linked l
    left join public.outreach_drafts d on d.id = l.draft_id
    left join public.pitch_log p on p.id = l.dispatch_pitch_id
  ),
  chosen as (
    select distinct on (batch_id)
      batch_id,
      sent_by,
      sent_by_label
    from actors
    where sent_by is not null
    order by batch_id, updated_at desc nulls last
  ),
  eligible as (
    select b.id
    from public.agh_handoff_batches b
    where b.queue_state is distinct from 'SENT'
      and exists (select 1 from linked l where l.batch_id = b.id)
      and not exists (
        select 1 from public.agh_handoff_records r
        where r.batch_id = b.id
          and r.queue_state is distinct from 'SENT'
      )
      and not exists (
        select 1
        from linked l
        join public.outreach_drafts d on d.id = l.draft_id
        where l.batch_id = b.id
          and trim(d.generated_by) = 'fendi'
      )
  ),
  upd as (
    update public.agh_handoff_batches b
       set queue_state = 'SENT',
           sent_by = coalesce(nullif(trim(b.sent_by), ''), c.sent_by),
           sent_by_label = coalesce(nullif(trim(b.sent_by_label), ''), c.sent_by_label, c.sent_by),
           updated_at = now()
      from eligible e
      left join chosen c on c.batch_id = e.id
     where b.id = e.id
       and b.queue_state is distinct from 'SENT'
    returning b.id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into ids from upd;

  return jsonb_build_object(
    'ok', true,
    'updated', jsonb_array_length(ids),
    'batch_ids', ids
  );
end $$;

comment on function public.agh_backfill_handoff_batch_sent() is
  'Set agh_handoff_batches to SENT when every record is already SENT. Copies sent_by from record approver or email_dispatch. Does not send and does not rewrite records or drafts.';

revoke all on function public.agh_backfill_handoff_batch_sent() from public, anon, authenticated;
grant execute on function public.agh_backfill_handoff_batch_sent() to service_role;

select public.agh_backfill_handoff_batch_sent();

commit;
