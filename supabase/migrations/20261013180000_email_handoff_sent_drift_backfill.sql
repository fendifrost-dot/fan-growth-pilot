-- Approve-and-send marked outreach_drafts sent and stored a Resend id, but
-- markLinkedHandoffEmailSent only moved APPROVED_FOR_SEND. Linked email
-- handoffs stayed in AWAITING_GROK_REVIEW, GROK_REVIEWED, or IMPORTED_TO_AGH
-- (the Oct 2026 drift, including imported rows from Sep 11–Oct 3).
--
-- This backfill is safe to run again. A row moves to SENT only when its linked
-- draft status is sent (or it is still the older APPROVED_FOR_SEND match), the
-- pitch_log row is status sent, and a Resend id is present. Bounces
-- (pitch_log.status or placement_status) are stamped outcome=bounced and are
-- not called SENT. Soundplate rows and generated_by='fendi' drafts are not
-- updated. submitted_at is not set, so quota and manual receipts stay put.
begin;

create or replace function public.agh_backfill_email_handoff_sent()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  b int := 0;
begin
  with base as (
    select
      r.id,
      r.queue_state,
      r.submission_channel,
      r.packet,
      r.playlist_target_id,
      r.track_id,
      coalesce(
        r.outreach_draft_id,
        case
          when coalesce(r.packet->>'outreach_draft_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (r.packet->>'outreach_draft_id')::uuid
        end
      ) as draft_id,
      (
        coalesce(t.submission_method, '') ilike 'soundplate'
        or coalesce(r.packet->>'submission_method', '') ilike 'soundplate'
        or coalesce(t.form_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(t.submission_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(t.curator_website, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(r.packet->>'form_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(r.packet->>'submission_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      ) as soundplate
    from public.agh_handoff_records r
    left join public.playlist_targets t on t.playlist_id = r.playlist_target_id
  ),
  matched as (
    select distinct on (b.id)
      b.id as record_id,
      b.queue_state,
      p.id as pitch_log_id,
      p.resend_message_id,
      coalesce(p.sent_at, p.pitched_at) as sent_at
    from base b
    left join public.outreach_drafts d on d.id = b.draft_id
    join public.pitch_log p
      on (
        (
          b.queue_state = 'APPROVED_FOR_SEND'
          and (
            (b.draft_id is not null and p.draft_id = b.draft_id)
            or (
              b.playlist_target_id is not null
              and p.playlist_id = b.playlist_target_id
              and b.track_id is not null
              and (
                p.track_id = b.track_id
                or (
                  p.track_id is null
                  and lower(p.track_name) = (select lower(name) from public.tracks where id = b.track_id)
                )
              )
            )
          )
        )
        or (
          d.id is not null
          and d.status = 'sent'
          and (p.id = d.pitch_log_id or p.draft_id = d.id)
        )
      )
    where lower(coalesce(p.status, '')) = 'sent'
      and lower(coalesce(p.placement_status, '')) is distinct from 'bounced'
      and nullif(trim(p.resend_message_id), '') is not null
      and coalesce(b.submission_channel, 'email') = 'email'
      and (d.id is null or coalesce(nullif(trim(d.channel), ''), 'email') = 'email')
      and not b.soundplate
      and coalesce(d.generated_by, '') is distinct from 'fendi'
      and not exists (
        select 1 from public.outreach_drafts fd
        where fd.generated_by = 'fendi'
          and fd.id in (b.draft_id, p.draft_id)
      )
      and b.queue_state in (
        'AWAITING_GROK_REVIEW',
        'GROK_REVIEWED',
        'APPROVED_FOR_SEND',
        'AWAITING_AGH_IMPORT',
        'IMPORTED_TO_AGH'
      )
      and not exists (
        select 1 from public.pitch_log bp
        where nullif(trim(bp.resend_message_id), '') is not null
          and (
            lower(coalesce(bp.status, '')) = 'bounced'
            or lower(coalesce(bp.placement_status, '')) = 'bounced'
          )
          and b.draft_id is not null
          and (bp.draft_id = b.draft_id or bp.id = d.pitch_log_id)
      )
    order by b.id, coalesce(p.sent_at, p.pitched_at) desc nulls last
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
               'outcome', 'sent',
               'prior_queue_state', r.queue_state,
               'backfill', true
             )
           )
      from matched m
     where r.id = m.record_id
       and r.queue_state = m.queue_state
       and r.queue_state in (
         'AWAITING_GROK_REVIEW',
         'GROK_REVIEWED',
         'APPROVED_FOR_SEND',
         'AWAITING_AGH_IMPORT',
         'IMPORTED_TO_AGH'
       )
    returning r.id
  )
  select count(*) into n from upd;

  with base as (
    select
      r.id,
      r.queue_state,
      r.submission_channel,
      r.packet,
      coalesce(
        r.outreach_draft_id,
        case
          when coalesce(r.packet->>'outreach_draft_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (r.packet->>'outreach_draft_id')::uuid
        end
      ) as draft_id,
      (
        coalesce(t.submission_method, '') ilike 'soundplate'
        or coalesce(r.packet->>'submission_method', '') ilike 'soundplate'
        or coalesce(t.form_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(t.submission_url, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(t.curator_website, '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(r.packet->>'form_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
        or coalesce(r.packet->>'submission_url', '') ~* '(://|\.)soundplate\.com([/:?#]|$)'
      ) as soundplate
    from public.agh_handoff_records r
    left join public.playlist_targets t on t.playlist_id = r.playlist_target_id
  ),
  bounced as (
    select distinct on (b.id)
      b.id as record_id,
      p.id as pitch_log_id,
      p.resend_message_id,
      coalesce(p.sent_at, p.pitched_at) as sent_at
    from base b
    left join public.outreach_drafts d on d.id = b.draft_id
    join public.pitch_log p
      on (
        (b.draft_id is not null and p.draft_id = b.draft_id)
        or (d.pitch_log_id is not null and p.id = d.pitch_log_id)
      )
    where nullif(trim(p.resend_message_id), '') is not null
      and (
        lower(coalesce(p.status, '')) = 'bounced'
        or lower(coalesce(p.placement_status, '')) = 'bounced'
      )
      and coalesce(b.submission_channel, 'email') = 'email'
      and not b.soundplate
      and coalesce(d.generated_by, '') is distinct from 'fendi'
      and not exists (
        select 1 from public.outreach_drafts fd
        where fd.generated_by = 'fendi'
          and fd.id in (b.draft_id, p.draft_id)
      )
      and (
        b.queue_state in (
          'AWAITING_GROK_REVIEW',
          'GROK_REVIEWED',
          'APPROVED_FOR_SEND',
          'AWAITING_AGH_IMPORT',
          'IMPORTED_TO_AGH'
        )
        or b.queue_state = 'SENT'
      )
      and (
        coalesce(b.packet->'email_dispatch'->>'outcome', '') is distinct from 'bounced'
        or coalesce(b.packet->'email_dispatch'->>'resend_message_id', '') is distinct from p.resend_message_id
        or (
          b.queue_state = 'SENT'
          and coalesce(b.packet->'email_dispatch'->>'prior_queue_state', '') in (
            'AWAITING_GROK_REVIEW',
            'GROK_REVIEWED',
            'APPROVED_FOR_SEND',
            'AWAITING_AGH_IMPORT',
            'IMPORTED_TO_AGH'
          )
        )
      )
    order by b.id, coalesce(p.sent_at, p.pitched_at) desc nulls last
  ),
  bounce_upd as (
    update public.agh_handoff_records r
       set queue_state = case
             when r.queue_state = 'SENT'
              and coalesce(r.packet->'email_dispatch'->>'prior_queue_state', '') in (
                'AWAITING_GROK_REVIEW',
                'GROK_REVIEWED',
                'APPROVED_FOR_SEND',
                'AWAITING_AGH_IMPORT',
                'IMPORTED_TO_AGH'
              )
             then r.packet->'email_dispatch'->>'prior_queue_state'
             else r.queue_state
           end,
           updated_at = now(),
           packet = r.packet || jsonb_build_object(
             'email_dispatch', jsonb_strip_nulls(jsonb_build_object(
               'pitch_log_id', m.pitch_log_id,
               'resend_message_id', m.resend_message_id,
               'sent_at', m.sent_at,
               'channel', 'email',
               'outcome', 'bounced',
               'bounced_at', now(),
               'backfill', true,
               'prior_queue_state', nullif(r.packet->'email_dispatch'->>'prior_queue_state', '')
             ))
           )
      from bounced m
     where r.id = m.record_id
    returning r.id
  )
  select count(*) into b from bounce_upd;

  return jsonb_build_object('ok', true, 'updated', coalesce(n, 0), 'bounces_recorded', coalesce(b, 0));
end $$;

revoke all on function public.agh_backfill_email_handoff_sent() from public, anon, authenticated;
grant execute on function public.agh_backfill_email_handoff_sent() to service_role;

select public.agh_backfill_email_handoff_sent();

commit;
