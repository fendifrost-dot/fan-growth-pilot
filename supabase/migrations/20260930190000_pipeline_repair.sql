-- Pipeline repair: forward-only. Existing pitch/handoff rows are never backfilled.
begin;
create or replace function public.agh_contact_policy(p_target text,p_track uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare t playlist_targets%rowtype; ids text[]; expiry timestamptz;
begin
 select * into t from playlist_targets where playlist_id=p_target;
 if not found or p_track is null then return jsonb_build_object('ok',false,'code','identity_required'); end if;
 select array_agg(p.playlist_id) into ids from playlist_targets p where
 regexp_replace(p.playlist_id,'^spotify:(playlist:)?','')=regexp_replace(t.playlist_id,'^spotify:(playlist:)?','')
 or (nullif(trim(t.curator_email),'') is not null and lower(trim(p.curator_email))=lower(trim(t.curator_email)))
 or (agh_curator_form_key(t.form_url) is not null and agh_curator_form_key(p.form_url)=agh_curator_form_key(t.form_url))
 or (nullif(lower(ltrim(t.ig_curator_account,'@')),'') is not null and lower(ltrim(p.ig_curator_account,'@'))=lower(ltrim(t.ig_curator_account,'@')));
 if t.is_active is false then return jsonb_build_object('ok',false,'code','inactive_target'); end if;
 if exists(select 1 from playlist_targets where playlist_id=any(ids) and submission_cost='paid') then
 return jsonb_build_object('ok',false,'code','paid_curator'); end if;
 if exists(select 1 from playlist_targets p join domain_blocklist b on
 lower(split_part(p.curator_email,'@',2))=lower(trim(b.domain))
 or lower(split_part(p.curator_email,'@',2)) like '%.'||lower(trim(b.domain))
 where p.playlist_id=any(ids)) then return jsonb_build_object('ok',false,'code','blocked_domain'); end if;
 if exists(select 1 from playlist_targets where playlist_id=any(ids) and (bounce_count>0 or verification_status in ('bounced','blocked','invalid'))) then
 return jsonb_build_object('ok',false,'code','suppressed_curator'); end if;
 select max(u) into expiry from (
 select greatest(cooldown_until,coalesce(sent_at,pitched_at)+interval '90 days') u from pitch_log l
 where (l.playlist_id=any(ids) or (nullif(trim(t.curator_email),'') is not null and lower(trim(l.curator_email))=lower(trim(t.curator_email))))
 and (cooldown_until is not null or resend_message_id is not null or status in ('sent','responded','replied','rejected'))
 union all select submitted_at+interval '90 days' from agh_handoff_records where playlist_target_id=any(ids) and submitted_at is not null
 ) c;
 if expiry>now() then return jsonb_build_object('ok',false,'code','curator_cooldown','cooldown_until',expiry); end if;
 return jsonb_build_object('ok',true,'code','eligible');
end $$;

create or replace function public.agh_guard_draft_policy() returns trigger
language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
 if TG_OP='UPDATE' and new.status is not distinct from old.status then return new; end if;
 if TG_OP='UPDATE' and new.status not in ('pending','approved') then return new; end if;
 if TG_OP='UPDATE' and new.status='approved' and new.generated_by='fendi' then raise exception 'ATTRIBUTION_GAP: existing attribution hold'; end if;
 v:=agh_contact_policy(new.playlist_id,new.track_id);
 if not coalesce((v->>'ok')::boolean,false) then raise exception 'playlist_policy:%',v->>'code'; end if;
 return new;
end $$;
create trigger agh_guard_draft_policy before insert or update of status on outreach_drafts
for each row execute function agh_guard_draft_policy();

create or replace function public.agh_record_can_approve(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare r agh_handoff_records%rowtype; t playlist_targets%rowtype; d song_dna_versions%rowtype; v jsonb;
begin
 select * into r from agh_handoff_records where id=p_id;
 if not found or r.queue_state<>'GROK_REVIEWED' or r.submitted_at is not null then return jsonb_build_object('ok',false,'code','review_required'); end if;
 if r.packet ? 'route_hold' or r.packet ? 'review_defer' then return jsonb_build_object('ok',false,'code','record_held'); end if;
 if exists(select 1 from outreach_drafts where id=r.outreach_draft_id and generated_by='fendi') then return jsonb_build_object('ok',false,'code','ATTRIBUTION_GAP'); end if;
 select * into t from playlist_targets where playlist_id=r.playlist_target_id;
 select sd.* into d from tracks tr join song_dna_versions sd on sd.id=tr.approved_song_dna_version_id where tr.id=r.track_id and sd.approval_state='approved';
 if d.id is null or d.id is distinct from r.song_dna_version_id or
 not coalesce(lower(trim(t.lane))=any(d.approved_lanes),false) or coalesce(lower(trim(t.lane))=any(d.excluded_lanes),false) then
 return jsonb_build_object('ok',false,'code','dna_gate'); end if;
 if t.path_verified is not true then return jsonb_build_object('ok',false,'code','route_unverified'); end if;
 return agh_contact_policy(r.playlist_target_id,r.track_id);
end $$;

create table public.agh_manual_submission_receipts(
 id uuid primary key default gen_random_uuid(),handoff_record_id uuid not null unique references agh_handoff_records(id),
 pitch_log_id uuid not null unique references pitch_log(id),evidence jsonb not null,
 actor text not null,created_at timestamptz not null default now()
);
alter table agh_manual_submission_receipts enable row level security;
revoke all on agh_manual_submission_receipts from anon,authenticated;
grant all on agh_manual_submission_receipts to service_role;
create or replace function public.agh_log_manual_submission() returns trigger
language plpgsql security definer set search_path=public as $$
declare e jsonb; t playlist_targets%rowtype; d song_dna_versions%rowtype; v jsonb; pl uuid; title text;
begin
 if new.submitted_at is null or old.submitted_at is not null then return new; end if;
 if new.manual_submit_channel not in ('web_form','instagram_dm') or new.manual_submit_channel is distinct from new.submission_channel
 or new.queue_state<>'APPROVED_FOR_SEND' or new.packet->'grok_review'->>'verdict' is distinct from 'PASS'
 or coalesce(new.submitted_by,'') not in ('fendi','grok_playlist_control') then raise exception 'pass_approval_required'; end if;
 if new.packet ? 'route_hold' or new.packet ? 'review_defer' then raise exception 'record_held'; end if;
 e:=new.packet->'submission_evidence';
 if e->>'result' is distinct from 'submitted' or nullif(trim(e->>'reference'),'') is null
 or nullif(trim(e->>'notes'),'') is null or (e->>'submitted_at')::timestamptz is distinct from new.submitted_at
 or new.submitted_at>now()+interval '1 minute' then raise exception 'submission_evidence_required'; end if;
 select * into t from playlist_targets where playlist_id=new.playlist_target_id;
 perform pg_advisory_xact_lock(hashtextextended(coalesce(nullif(lower(trim(t.curator_email)),''),agh_curator_form_key(t.form_url),t.playlist_id),0));
 select sd.* into d from tracks tr join song_dna_versions sd on sd.id=tr.approved_song_dna_version_id
 where tr.id=new.track_id and sd.approval_state='approved';
 if d.id is null or d.id is distinct from new.song_dna_version_id or
 not coalesce(lower(trim(t.lane))=any(d.approved_lanes),false) or coalesce(lower(trim(t.lane))=any(d.excluded_lanes),false) then raise exception 'dna_gate'; end if;
 v:=agh_contact_policy(new.playlist_target_id,new.track_id);
 if not coalesce((v->>'ok')::boolean,false) then raise exception 'playlist_policy:%',v->>'code'; end if;
 select name into title from tracks where id=new.track_id;
 insert into pitch_log(playlist_id,track_id,track_name,curator_email,method,status,sent_at,pitched_at,cooldown_until,
 song_dna_version_id,approved_by,approved_at,response_notes,dispatched_via)
 values(new.playlist_target_id,new.track_id,title,t.curator_email,new.manual_submit_channel,'sent',new.submitted_at,new.submitted_at,
 new.submitted_at+interval '90 days',d.id,new.approved_by,now(),e->>'notes','manual_evidence') returning id into pl;
 insert into agh_manual_submission_receipts(handoff_record_id,pitch_log_id,evidence,actor) values(new.id,pl,e,new.submitted_by);
 new.packet:=new.packet||jsonb_build_object('submission_receipt',jsonb_build_object('pitch_log_id',pl,'evidence',e));
 return new;
end $$;
create trigger agh_log_manual_submission before update of submitted_at on agh_handoff_records
for each row execute function agh_log_manual_submission();

create table public.agh_pitch_response_events(
 id uuid primary key default gen_random_uuid(),pitch_log_id uuid not null references pitch_log(id),
 actor text not null,previous_value jsonb not null,requested_change jsonb not null,applied_change jsonb not null,
 created_at timestamptz not null default now()
);
alter table agh_pitch_response_events enable row level security;
revoke all on agh_pitch_response_events from anon,authenticated;
grant all on agh_pitch_response_events to service_role;
create or replace function public.agh_preserve_pitch_response() returns trigger
language plpgsql security definer set search_path=public as $$
declare requested jsonb:=to_jsonb(new); actor text:=coalesce(nullif(current_setting('agh.response_actor',true),''),'unattributed:'||session_user);
begin
 if old.response_notes is distinct from new.response_notes then
 if nullif(trim(new.response_notes),'') is null then new.response_notes:=old.response_notes;
 elsif nullif(old.response_notes,'') is not null and left(new.response_notes,length(old.response_notes))<>old.response_notes then
 new.response_notes:=old.response_notes||E'\n['||now()::text||' '||actor||'] '||new.response_notes; end if; end if;
 if old.placement_status in ('accepted_free_promo','paid_solicitation_no_engage','declined_paid_solicitation','declined','blocked','placed')
 and new.placement_status is distinct from old.placement_status then
 new.placement_status:=old.placement_status;new.placed:=old.placed;end if;
 if old.status='sent' and new.status in ('responded','replied','rejected') then new.status:=old.status;end if;
 if old.reply_received is true then new.reply_received:=true;end if;
 if requested is distinct from to_jsonb(old) then
 insert into agh_pitch_response_events(pitch_log_id,actor,previous_value,requested_change,applied_change)
 values(old.id,actor,to_jsonb(old),requested,to_jsonb(new));end if;
 return new;
end $$;
create trigger agh_preserve_pitch_response before update on pitch_log for each row execute function agh_preserve_pitch_response();

create or replace function public.agh_pipeline_quota(p_track uuid default null) returns jsonb
language sql stable security definer set search_path=public as $$
 with day as(select (now() at time zone 'America/Chicago')::date ct), totals as(
 select t.id track_id,t.name title,day.ct business_date_ct,
 (select count(*) from pitch_log l where l.track_id=t.id and l.status='sent' and l.resend_message_id is not null and (l.sent_at at time zone 'America/Chicago')::date=day.ct) submissions_email_today,
 (select count(*) from agh_manual_submission_receipts mr join pitch_log l on l.id=mr.pitch_log_id where l.track_id=t.id and l.status='sent' and (l.sent_at at time zone 'America/Chicago')::date=day.ct) submissions_manual_today,
 (select count(*) from outreach_drafts od where od.track_id=t.id and od.status='pending') drafts_awaiting_review,
 (select count(*) from outreach_drafts od where od.track_id=t.id and od.status='pending' and (od.created_at at time zone 'America/Chicago')::date=day.ct) drafts_awaiting_review_today
 from tracks t cross join day where t.status='active' and (p_track is null or t.id=p_track))
 select coalesce(jsonb_agg(to_jsonb(totals)||jsonb_build_object('objective_submissions',30,
 'submissions_today',submissions_email_today+submissions_manual_today,
 'submission_shortfall',greatest(0,30-submissions_email_today-submissions_manual_today))), '[]'::jsonb) from totals;
$$;
create or replace function public.agh_pipeline_health() returns jsonb
language sql stable security definer set search_path=public as $$
 select jsonb_build_object('version','2026-09-30.2',
 'record_review',to_regprocedure('public.agh_review_handoff_records(uuid,jsonb,text,text)') is not null,
 'manual_receipts',to_regclass('public.agh_manual_submission_receipts') is not null,
 'response_audit',to_regclass('public.agh_pitch_response_events') is not null);
$$;

create or replace function public.agh_review_handoff_records(
  p_batch_id uuid,
  p_decisions jsonb,       -- [{record_id, decision: reviewed|reject|defer, reason_codes[], reason, retry_after, song_fit}]
  p_actor text,
  p_actor_label text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.agh_handoff_batches%rowtype;
  v_item jsonb;
  v_rec public.agh_handoff_records%rowtype;
  v_dec text;
  v_codes jsonb;
  v_reason text;
  v_text text;
  v_hist jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_total int;
  v_awaiting int;
  v_reviewed int;
  v_rejected int;
  v_counts jsonb;
  v_policy jsonb;
begin
  if p_batch_id is null or p_decisions is null or jsonb_typeof(p_decisions) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'batch_id and decisions array required');
  end if;
  if coalesce(p_actor, '') = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'actor required');
  end if;

  select * into v_batch from public.agh_handoff_batches where id = p_batch_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'batch_not_found', 'error', 'batch not found');
  end if;
  if v_batch.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
    return jsonb_build_object('ok', false, 'code', 'batch_not_in_review',
      'error', format('batch is %s; record review needs AWAITING_GROK_REVIEW or GROK_REVIEWED', v_batch.queue_state));
  end if;

  for v_item in select * from jsonb_array_elements(p_decisions)
  loop
    begin
      select * into v_rec from public.agh_handoff_records
       where id = (v_item->>'record_id')::uuid and batch_id = p_batch_id
       for update;
    exception when invalid_text_representation then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_item->>'record_id', 'reason', 'invalid_record_id'));
      continue;
    end;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_item->>'record_id', 'reason', 'not_in_batch'));
      continue;
    end if;
    if v_rec.submitted_at is not null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'already_submitted'));
      continue;
    end if;

    v_dec := lower(coalesce(v_item->>'decision', ''));
    v_codes := case when jsonb_typeof(v_item->'reason_codes') = 'array' then v_item->'reason_codes' else '[]'::jsonb end;
    v_reason := nullif(trim(coalesce(v_item->>'reason', '')), '');
    v_text := nullif(concat_ws(': ',
      nullif((select string_agg(value, ', ') from jsonb_array_elements_text(v_codes)), ''),
      v_reason), '');
    v_hist := jsonb_build_object(
      'decision', v_dec, 'reason_codes', v_codes, 'reason', v_reason,
      'by', p_actor, 'by_label', p_actor_label, 'at', now(),
      'from_state', v_rec.queue_state, 'song_fit', v_item->'song_fit');

    if v_dec = 'reviewed' then
      if v_rec.queue_state <> 'AWAITING_GROK_REVIEW' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_awaiting_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      update public.agh_handoff_records
         set queue_state = 'GROK_REVIEWED',
             reviewed_by = coalesce(reviewed_by, p_actor),
             reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             packet = (packet - 'review_defer') || jsonb_build_object('review_history',
               coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    elsif v_dec = 'approve' then
      v_policy := public.agh_record_can_approve(v_rec.id);
      if coalesce(p_actor,'') not in ('fendi','grok_playlist_control') or v_item->>'verdict' is distinct from 'PASS'
         or v_reason is null or not coalesce((v_policy->>'ok')::boolean,false) then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id',v_rec.id,'reason',coalesce(v_policy->>'code','pass_review_required')));
        continue;
      end if;
      update public.agh_handoff_records set queue_state='APPROVED_FOR_SEND',approved_by=p_actor,approved_by_label=p_actor_label,
        packet=packet||jsonb_build_object('grok_review',jsonb_build_object('verdict','PASS','reason',v_reason,'actor',p_actor,'at',now()),
        'review_history',coalesce(packet->'review_history','[]'::jsonb)||jsonb_build_array(v_hist)),updated_at=now()
      where id=v_rec.id;
    elsif v_dec = 'reject' then
      if v_rec.queue_state not in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_in_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      if v_text is null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'reason_required'));
        continue;
      end if;
      update public.agh_handoff_records
         set queue_state = 'REJECTED_BY_GROK',
             reviewed_by = coalesce(reviewed_by, p_actor),
             reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             rejected_by = p_actor,
             rejected_by_label = p_actor_label,
             rejection_reason = v_text,
             packet = packet || jsonb_build_object(
               'rejection', jsonb_build_object('reason_codes', v_codes, 'reason', v_reason, 'by', p_actor, 'at', now()),
               'review_history', coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    elsif v_dec = 'defer' then
      if v_rec.queue_state <> 'AWAITING_GROK_REVIEW' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'not_awaiting_review', 'queue_state', v_rec.queue_state));
        continue;
      end if;
      update public.agh_handoff_records
         set packet = packet || jsonb_build_object(
               'review_defer', jsonb_build_object('reason_codes', v_codes, 'reason', v_reason,
                 'retry_after', v_item->>'retry_after', 'by', p_actor, 'at', now()),
               'review_history', coalesce(packet->'review_history', '[]'::jsonb) || jsonb_build_array(v_hist)),
             updated_at = now()
       where id = v_rec.id;
    else
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'reason', 'unknown_decision'));
      continue;
    end if;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('record_id', v_rec.id, 'decision', v_dec, 'from_state', v_rec.queue_state));
  end loop;

  -- Batch state follows its records and never moves backwards.
  select count(*),
         count(*) filter (where queue_state = 'AWAITING_GROK_REVIEW'),
         count(*) filter (where queue_state = 'GROK_REVIEWED'),
         count(*) filter (where queue_state = 'REJECTED_BY_GROK')
    into v_total, v_awaiting, v_reviewed, v_rejected
    from public.agh_handoff_records where batch_id = p_batch_id;

  if v_total > 0 and v_awaiting = 0 then
    if v_rejected = v_total and v_batch.queue_state in ('AWAITING_GROK_REVIEW', 'GROK_REVIEWED') then
      update public.agh_handoff_batches
         set queue_state = 'REJECTED_BY_GROK',
             reviewed_by = coalesce(reviewed_by, p_actor), reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             rejected_by = coalesce(rejected_by, p_actor), rejected_by_label = coalesce(rejected_by_label, p_actor_label),
             notes = coalesce(notes, 'All records rejected at record level (see each record''s rejection_reason).'),
             updated_at = now()
       where id = p_batch_id;
    elsif v_reviewed > 0 and v_batch.queue_state = 'AWAITING_GROK_REVIEW' then
      update public.agh_handoff_batches
         set queue_state = 'GROK_REVIEWED',
             reviewed_by = coalesce(reviewed_by, p_actor), reviewed_by_label = coalesce(reviewed_by_label, p_actor_label),
             updated_at = now()
       where id = p_batch_id;
    end if;
  end if;

  select coalesce(jsonb_object_agg(queue_state, n), '{}'::jsonb) into v_counts
    from (select queue_state, count(*) as n from public.agh_handoff_records where batch_id = p_batch_id group by 1) s;

  return jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'batch_queue_state', (select queue_state from public.agh_handoff_batches where id = p_batch_id),
    'record_counts', v_counts,
    'applied', v_applied,
    'applied_count', jsonb_array_length(v_applied),
    'skipped', v_skipped);
end;
$$;

revoke all on function public.agh_review_handoff_records(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.agh_review_handoff_records(uuid, jsonb, text, text) to service_role;




do $$ declare r record;begin
for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
and proname in ('agh_contact_policy','agh_guard_draft_policy','agh_record_can_approve','agh_log_manual_submission','agh_preserve_pitch_response','agh_pipeline_quota','agh_pipeline_health') loop
execute format('revoke all on function %s from public,anon,authenticated',r.signature);
execute format('grant execute on function %s to service_role',r.signature);end loop;end $$;
notify pgrst,'reload schema';
commit;
