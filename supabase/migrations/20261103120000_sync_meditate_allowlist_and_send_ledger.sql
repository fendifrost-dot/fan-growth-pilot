-- Sync lane: one song allowlist, pay-to-play backstop, and a playlist-style send ledger.
--
-- Apply via Lovable SQL Editor (paste, don't type). Do not apply via supabase CLI.
-- Apply this migration BEFORE redeploying control-center-api and mcp-sync-discovery.
-- Those functions insert terms_status_at_send, fee_status_at_send, and audit_result,
-- and they write approval columns on sync_research_pitch_drafts.
--
-- ops_settings.sync_song_allowlist is the only song list. It is seeded with
-- Meditate. Fendi adds a song by editing that JSON array (names or track ids).
-- An empty array pauses sync. A missing row falls back to Meditate.
-- Unknown submission terms are not a hold. Positive fee evidence is.
-- generated_by = 'fendi' drafts cannot be updated or deleted.

begin;

-- ---------------------------------------------------------------------------
-- Ledger columns the Hub send path writes. Additive.
-- ---------------------------------------------------------------------------
alter table public.licensing_pitch_log
  add column if not exists approved_by text,
  add column if not exists approved_by_label text,
  add column if not exists approved_at timestamptz,
  add column if not exists sent_by text,
  add column if not exists sent_by_label text,
  add column if not exists sent_at timestamptz,
  add column if not exists resend_message_id text,
  add column if not exists draft_id uuid,
  add column if not exists subject text,
  add column if not exists email_body text,
  add column if not exists from_address text,
  add column if not exists dispatched_via text,
  add column if not exists song_dna_version_id uuid,
  add column if not exists terms_status_at_send text,
  add column if not exists fee_status_at_send text,
  add column if not exists audit_result text;

alter table public.licensing_pitch_log
  drop constraint if exists licensing_pitch_log_terms_status_at_send_chk;
alter table public.licensing_pitch_log
  add constraint licensing_pitch_log_terms_status_at_send_chk
  check (terms_status_at_send is null or terms_status_at_send in ('free', 'unknown'));

alter table public.licensing_pitch_log
  drop constraint if exists licensing_pitch_log_fee_status_at_send_chk;
alter table public.licensing_pitch_log
  add constraint licensing_pitch_log_fee_status_at_send_chk
  check (fee_status_at_send is null or fee_status_at_send in ('no_positive_fee'));

comment on column public.licensing_pitch_log.terms_status_at_send is
  'Submission terms at Hub send time: free or unknown. Unknown is not a hold.';
comment on column public.licensing_pitch_log.fee_status_at_send is
  'no_positive_fee when the send passed the positive-fee gate. Paid rows are not sends.';
comment on column public.licensing_pitch_log.audit_result is
  'PASS when submit_sync_outreach accepted the pre-send checks. Same meaning as pitch_log.audit_result.';
comment on column public.licensing_pitch_log.sent_by is
  'Server-stamped sender. Never caller-supplied.';
comment on column public.licensing_pitch_log.approved_by is
  'Server-stamped approver of the sync draft.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'licensing_pitch_log_draft_id_fkey'
  ) then
    alter table public.licensing_pitch_log
      add constraint licensing_pitch_log_draft_id_fkey
      foreign key (draft_id) references public.sync_research_pitch_drafts(id)
      on delete set null;
  end if;
exception
  when undefined_table or undefined_column then
    raise notice 'licensing_pitch_log draft_id FK deferred';
end $$;

create unique index if not exists licensing_pitch_log_draft_id_uidx
  on public.licensing_pitch_log (draft_id)
  where draft_id is not null;

-- ---------------------------------------------------------------------------
-- Draft / target / opportunity columns the research and approve paths write.
-- ---------------------------------------------------------------------------
alter table public.sync_research_pitch_drafts
  add column if not exists approved_by text,
  add column if not exists approved_by_label text,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_by_label text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists submitted_by text,
  add column if not exists submitted_by_label text,
  add column if not exists submitted_at timestamptz,
  add column if not exists submission_channel text,
  add column if not exists submission_evidence text,
  add column if not exists submission_message_id text,
  add column if not exists response_status text,
  add column if not exists response_notes text,
  add column if not exists response_checked_at timestamptz,
  add column if not exists response_checked_by text,
  add column if not exists response_checked_by_label text,
  add column if not exists escalated_to_fendi boolean not null default false,
  add column if not exists escalation_reason text,
  add column if not exists batch_id uuid,
  add column if not exists send_idempotency_key text,
  add column if not exists provider_response jsonb,
  add column if not exists send_attempted_at timestamptz,
  add column if not exists generated_by text;

comment on column public.sync_research_pitch_drafts.generated_by is
  'Pipeline author. The literal fendi marks copy written outside the Hub and is immutable. Hub drafts use the actor kind (fendi_hub when Fendi creates one in the Hub).';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'sync_research_pitch_drafts_batch_id_fkey'
  ) then
    alter table public.sync_research_pitch_drafts
      add constraint sync_research_pitch_drafts_batch_id_fkey
      foreign key (batch_id) references public.agh_handoff_batches(id)
      on delete set null;
  end if;
exception
  when undefined_table or undefined_column then
    raise notice 'sync draft batch_id FK deferred';
end $$;

alter table public.sync_research_pitch_drafts
  drop constraint if exists sync_research_pitch_drafts_status_check;
alter table public.sync_research_pitch_drafts
  add constraint sync_research_pitch_drafts_status_check
  check (status in (
    'pending', 'draft', 'superseded', 'approved', 'rejected',
    'sent_manual', 'submitted', 'awaiting_response',
    'awaiting_manual_submission', 'send_failed'
  ));

alter table public.sync_research_pitch_drafts
  drop constraint if exists sync_research_pitch_drafts_submission_channel_check;
alter table public.sync_research_pitch_drafts
  add constraint sync_research_pitch_drafts_submission_channel_check
  check (submission_channel is null or submission_channel in ('email', 'web_form'));

alter table public.sync_research_targets
  add column if not exists target_type text not null default 'agency_introduction',
  add column if not exists acceptance_policy_status text,
  add column if not exists exclusivity_rights_warnings text,
  add column if not exists compensation_known text,
  add column if not exists associated_track_id uuid,
  add column if not exists primary_source_url text,
  add column if not exists verification_timestamp timestamptz;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'sync_research_targets_associated_track_id_fkey'
  ) then
    alter table public.sync_research_targets
      add constraint sync_research_targets_associated_track_id_fkey
      foreign key (associated_track_id) references public.tracks(id) on delete set null;
  end if;
exception
  when undefined_column or duplicate_object then
    null;
end $$;

alter table public.sync_research_targets
  drop constraint if exists sync_research_targets_target_type_check;
alter table public.sync_research_targets
  add constraint sync_research_targets_target_type_check
  check (target_type in ('agency_introduction', 'active_brief_contact'));

alter table public.sync_research_opportunities
  add column if not exists opportunity_type text not null default 'agency_introduction',
  add column if not exists acceptance_policy_status text,
  add column if not exists exclusivity_rights_warnings text,
  add column if not exists music_requirements text,
  add column if not exists usage_type text,
  add column if not exists associated_track_id uuid,
  add column if not exists primary_source_url text,
  add column if not exists verification_timestamp timestamptz,
  add column if not exists compensation_known text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'sync_research_opportunities_associated_track_id_fkey'
  ) then
    alter table public.sync_research_opportunities
      add constraint sync_research_opportunities_associated_track_id_fkey
      foreign key (associated_track_id) references public.tracks(id) on delete set null;
  end if;
exception
  when undefined_column or duplicate_object then
    null;
end $$;

alter table public.sync_research_opportunities
  drop constraint if exists sync_research_opportunities_opportunity_type_check;
alter table public.sync_research_opportunities
  add constraint sync_research_opportunities_opportunity_type_check
  check (opportunity_type in ('active_brief', 'agency_introduction'));

-- ---------------------------------------------------------------------------
-- Allowlist. One setting. Seed Meditate only when the row is absent.
-- ---------------------------------------------------------------------------
insert into public.ops_settings (setting_key, setting_value, description)
values (
  'sync_song_allowlist',
  '["Meditate"]'::jsonb,
  'Songs approved for sync. JSON array of track names or track ids. Edit this one value to add a song. An empty array pauses sync.'
)
on conflict (setting_key) do nothing;

create or replace function public.agh_sync_song_allowlist()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw jsonb;
begin
  select setting_value into raw
    from public.ops_settings
   where setting_key = 'sync_song_allowlist';
  if raw is null then
    return array['Meditate'];
  end if;
  if jsonb_typeof(raw) = 'array' then
    return coalesce(array(select jsonb_array_elements_text(raw)), array[]::text[]);
  end if;
  if jsonb_typeof(raw) = 'object' and jsonb_typeof(raw -> 'songs') = 'array' then
    return coalesce(array(select jsonb_array_elements_text(raw -> 'songs')), array[]::text[]);
  end if;
  return array[]::text[];
end;
$$;

create or replace function public.agh_sync_track_allowlisted(p_track_id uuid, p_track_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  names text[];
  tname text;
  entry text;
begin
  names := public.agh_sync_song_allowlist();
  if p_track_id is not null then
    select name into tname from public.tracks where id = p_track_id;
  end if;
  tname := coalesce(tname, p_track_name, '');
  if names is null then
    return false;
  end if;
  foreach entry in array names loop
    if btrim(coalesce(tname, '')) <> '' and lower(btrim(entry)) = lower(btrim(tname)) then
      return true;
    end if;
    if p_track_id is not null and lower(btrim(entry)) = lower(p_track_id::text) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function public.agh_sync_assert_track_allowlisted(p_track_id uuid, p_track_name text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.agh_sync_track_allowlisted(p_track_id, p_track_name) then
    raise exception 'sync_song_not_allowlisted' using errcode = 'P0001';
  end if;
end;
$$;

-- Positive fee evidence for a sync target. Unknown / blank cost is not evidence.
-- Playlist helpers supply SubmitHub-style hosts. Taxi, MusicXray, Broadjam,
-- paid Patreon, and Songtradr paid tiers are checked here.
create or replace function public.agh_sync_target_positive_fee(
  p_policy text,
  p_compensation text,
  p_evidence text,
  p_url text,
  p_contact text,
  p_company text
) returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  policy text := lower(btrim(coalesce(p_policy, '')));
  comp text := lower(btrim(coalesce(p_compensation, '')));
  cost text := '';
  email text := null;
  contact_url text := null;
  blob text;
  clause text;
begin
  if policy in ('paid', 'pay_to_play', 'paid_submission', 'fee_required') or comp in ('paid', 'pay_to_play', 'tip_appreciated') then
    cost := 'paid';
  elsif policy = 'free' or policy like 'free_%' or policy like 'free %' or comp = 'free' or comp like 'free %' then
    cost := 'free';
  elsif comp in ('', 'unknown', 'n/a', 'none') then
    cost := 'unknown';
  end if;
  if coalesce(p_contact, '') like '%@%' and coalesce(p_contact, '') not like 'http%' then
    email := p_contact;
  elsif coalesce(p_contact, '') like 'http%' then
    contact_url := p_contact;
  end if;
  if public.agh_positive_submission_fee(
    cost,
    null,
    null,
    case when policy = 'pay_to_play' then 'pay_to_play' else null end,
    null,
    p_url,
    contact_url,
    p_url,
    email,
    concat_ws(' ', p_evidence, p_policy, p_compensation, p_company)
  ) then
    return true;
  end if;
  blob := lower(concat_ws(' ', p_evidence, p_policy, p_compensation, p_url, p_contact, p_company));
  if blob ~ '(taxi\.com|musicxray\.com|broadjam\.com)' then
    return true;
  end if;
  if blob ~ 'patreon\.com' or blob ~ 'paid[[:space:]]+patreon' then
    return true;
  end if;
  if blob ~ 'songtradr' and blob ~ '(premium[[:space:]]+tier|pro[[:space:]]+tier|paid[[:space:]]+tier|buy[[:space:]]+credits|credits[[:space:]]+(required|to[[:space:]]+submit)|submission[[:space:]]+fee|pay[- ]to[- ]submit)' then
    return true;
  end if;
  for clause in
    select btrim(part)
    from regexp_split_to_table(blob, '[.;' || chr(10) || ']+') as part
  loop
    if clause ~ 'pay[- ]to[- ]play'
       and clause !~ '\m(no|not|none|without|never)\M' then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function public.agh_sync_draft_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.agh_sync_assert_track_allowlisted(new.track_id, null);
  return new;
end;
$$;

create or replace function public.agh_sync_target_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.associated_track_id is not null then
    perform public.agh_sync_assert_track_allowlisted(new.associated_track_id, null);
  end if;
  if coalesce(new.status, '') not in ('rejected', 'archived')
     and public.agh_sync_target_positive_fee(
       new.submission_policy,
       new.compensation_known,
       new.source_evidence,
       coalesce(new.primary_source_url, new.official_url),
       new.verified_contact_path,
       new.company_name
     ) then
    raise exception 'sync_positive_fee' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.agh_sync_opportunity_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
begin
  if new.associated_track_id is not null then
    perform public.agh_sync_assert_track_allowlisted(new.associated_track_id, null);
  end if;
  if new.recommended_track_ids is not null then
    foreach tid in array new.recommended_track_ids loop
      perform public.agh_sync_assert_track_allowlisted(tid, null);
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.agh_sync_licensing_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.agh_sync_assert_track_allowlisted(new.track_id, new.track_name);
  return new;
end;
$$;

create or replace function public.agh_reject_fendi_sync_draft_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(btrim(coalesce(old.generated_by, ''))) = 'fendi' then
    raise exception 'fendi_authored_immutable' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_research_pitch_drafts_allowlist on public.sync_research_pitch_drafts;
create trigger sync_research_pitch_drafts_allowlist
  before insert or update on public.sync_research_pitch_drafts
  for each row execute function public.agh_sync_draft_allowlist();

drop trigger if exists sync_research_pitch_drafts_fendi_immutable on public.sync_research_pitch_drafts;
create trigger sync_research_pitch_drafts_fendi_immutable
  before update or delete on public.sync_research_pitch_drafts
  for each row execute function public.agh_reject_fendi_sync_draft_mutation();

drop trigger if exists sync_research_targets_guard on public.sync_research_targets;
create trigger sync_research_targets_guard
  before insert or update on public.sync_research_targets
  for each row execute function public.agh_sync_target_guard();

drop trigger if exists sync_research_opportunities_allowlist on public.sync_research_opportunities;
create trigger sync_research_opportunities_allowlist
  before insert or update on public.sync_research_opportunities
  for each row execute function public.agh_sync_opportunity_allowlist();

drop trigger if exists licensing_pitch_log_allowlist on public.licensing_pitch_log;
create trigger licensing_pitch_log_allowlist
  before insert or update on public.licensing_pitch_log
  for each row execute function public.agh_sync_licensing_allowlist();

do $$ declare r record; begin
  for r in
    select oid::regprocedure as signature
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in (
         'agh_sync_song_allowlist',
         'agh_sync_track_allowlisted',
         'agh_sync_assert_track_allowlisted',
         'agh_sync_target_positive_fee',
         'agh_sync_draft_allowlist',
         'agh_sync_target_guard',
         'agh_sync_opportunity_allowlist',
         'agh_sync_licensing_allowlist',
         'agh_reject_fendi_sync_draft_mutation'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
