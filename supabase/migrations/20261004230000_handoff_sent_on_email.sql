-- Email sends wrote pitch_log and left agh_handoff_records at APPROVED_FOR_SEND.
-- SENT is the post-send record state. submitted_at is not set: the manual-submit
-- trigger would insert a second pitch_log and a receipt and double-count quota.
-- Backfill moves only APPROVED email records that already have a matching
-- pitch_log row with status sent and a resend_message_id. Bounces, web forms,
-- and Instagram DMs stay put. Safe to run again.
begin;

do $$
declare
  c record;
  allows_sent boolean := false;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.agh_handoff_records'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%APPROVED_FOR_SEND%'
  loop
    if c.def ilike '%''SENT''%' then
      allows_sent := true;
    else
      execute format('alter table public.agh_handoff_records drop constraint %I', c.conname);
    end if;
  end loop;
  if not allows_sent then
    alter table public.agh_handoff_records
      add constraint agh_handoff_records_queue_state_check
      check (queue_state in (
        'CLAUDE_BATCH_READY',
        'CLAUDE_PLAYLIST_COMPLETE',
        'AWAITING_GROK_REVIEW',
        'GROK_REVIEWED',
        'APPROVED_FOR_SEND',
        'REJECTED_BY_GROK',
        'AWAITING_AGH_IMPORT',
        'IMPORTED_TO_AGH',
        'SENT'
      ));
  end if;
end $$;

create or replace function public.agh_backfill_email_handoff_sent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with matched as (
    select distinct on (r.id)
      r.id as record_id,
      p.id as pitch_log_id,
      p.resend_message_id,
      coalesce(p.sent_at, p.pitched_at) as sent_at
    from public.agh_handoff_records r
    join public.pitch_log p
      on lower(coalesce(p.status, '')) = 'sent'
     and nullif(trim(p.resend_message_id), '') is not null
     and (
       (r.outreach_draft_id is not null and p.draft_id = r.outreach_draft_id)
       or (
         r.playlist_target_id is not null
         and p.playlist_id = r.playlist_target_id
         and r.track_id is not null
         and (
           p.track_id = r.track_id
           or (
             p.track_id is null
             and lower(p.track_name) = (select lower(name) from public.tracks where id = r.track_id)
           )
         )
       )
     )
    where r.queue_state = 'APPROVED_FOR_SEND'
      and coalesce(r.submission_channel, 'email') = 'email'
    order by r.id, coalesce(p.sent_at, p.pitched_at) desc nulls last
  ),
  upd as (
    update public.agh_handoff_records r
       set queue_state = 'SENT',
           updated_at = now(),
           packet = r.packet || jsonb_build_object(
             'email_dispatch', jsonb_build_object(
               'pitch_log_id', m.pitch_log_id,
               'resend_message_id', m.resend_message_id,
               'sent_at', m.sent_at,
               'channel', 'email',
               'backfill', true
             )
           )
      from matched m
     where r.id = m.record_id
       and r.queue_state = 'APPROVED_FOR_SEND'
    returning r.id
  )
  select count(*) into n from upd;
  return jsonb_build_object('ok', true, 'updated', coalesce(n, 0));
end $$;

revoke all on function public.agh_backfill_email_handoff_sent() from public, anon, authenticated;
grant execute on function public.agh_backfill_email_handoff_sent() to service_role;

select public.agh_backfill_email_handoff_sent();

commit;
