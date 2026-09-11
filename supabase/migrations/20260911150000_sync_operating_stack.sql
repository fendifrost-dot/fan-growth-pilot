-- AGH authenticated sync operating stack.
-- Extends existing sync research / OAuth / stations — does NOT create a parallel system.
-- Apply via Lovable SQL Editor (paste). Idempotent / additive.
-- Does NOT activate tracks for outreach, alter Song DNA, or send sync pitches.

begin;

-- ---------------------------------------------------------------------------
-- 1. Version-control live sync-gate columns on tracks (already present in prod)
-- ---------------------------------------------------------------------------
alter table public.tracks
  add column if not exists aggregator text not null default 'open',
  add column if not exists genre_stamp text not null default 'unknown',
  add column if not exists has_sample text not null default 'unknown',
  add column if not exists is_month1_sync_default boolean not null default false,
  add column if not exists sync_eligible boolean not null default false,
  add column if not exists sync_eligible_blockers text[] not null default '{}',
  add column if not exists sync_eligible_computed_at timestamptz,
  add column if not exists assets_ready boolean not null default false,
  add column if not exists publishing_ready boolean not null default false,
  add column if not exists splits_ready boolean not null default false,
  add column if not exists unresolved_rights_exception boolean not null default false,
  add column if not exists sample_exception_resolved boolean not null default false,
  add column if not exists sample_declaration_approved_at timestamptz,
  add column if not exists sample_declaration_approved_by text,
  add column if not exists sync_approved_at timestamptz,
  add column if not exists sync_approved_by text;

do $$ begin
  alter table public.tracks
    drop constraint if exists tracks_has_sample_check;
  alter table public.tracks
    add constraint tracks_has_sample_check
    check (has_sample in ('yes', 'no', 'unknown'));
exception when others then null;
end $$;

do $$ begin
  alter table public.tracks
    drop constraint if exists tracks_genre_stamp_check;
  alter table public.tracks
    add constraint tracks_genre_stamp_check
    check (genre_stamp in ('hip_hop_rap', 'house_electronic', 'unknown'));
exception when others then null;
end $$;

do $$ begin
  alter table public.tracks
    drop constraint if exists tracks_aggregator_check;
  alter table public.tracks
    add constraint tracks_aggregator_check
    check (aggregator in ('distrokid', 'tunecore', 'orchard', 'open'));
exception when others then null;
end $$;

comment on column public.tracks.sync_eligible is
  'Server-computed sync outreach eligibility. Never trust caller-supplied values.';
comment on column public.tracks.sync_eligible_blockers is
  'Authoritative blocker codes from the last server recompute.';

-- ---------------------------------------------------------------------------
-- 2. Private license evidence + supervisor / licensing registers (if missing)
-- ---------------------------------------------------------------------------
create table if not exists public.private_license_evidence (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  label text not null,
  notes text,
  storage_path text,
  uploaded_by text,
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz not null default now()
);

alter table public.private_license_evidence
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by text;

create index if not exists private_license_evidence_track_idx
  on public.private_license_evidence (track_id, created_at desc);

alter table public.private_license_evidence enable row level security;
drop policy if exists private_license_evidence_admin_all on public.private_license_evidence;
create policy private_license_evidence_admin_all on public.private_license_evidence
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create table if not exists public.music_supervisors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text,
  notes text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.music_supervisors enable row level security;
drop policy if exists music_supervisors_admin_all on public.music_supervisors;
create policy music_supervisors_admin_all on public.music_supervisors
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create table if not exists public.licensing_pitch_log (
  id uuid primary key default gen_random_uuid(),
  supervisor_id uuid references public.music_supervisors(id) on delete set null,
  contact_name text not null,
  contact_email text,
  company text,
  track_id uuid references public.tracks(id) on delete set null,
  track_name text not null,
  pitched_at timestamptz not null default now(),
  status text not null default 'sent',
  reply_received boolean not null default false,
  placed boolean not null default false,
  response_status text not null default 'awaiting',
  response_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.licensing_pitch_log enable row level security;
drop policy if exists licensing_pitch_log_admin_all on public.licensing_pitch_log;
create policy licensing_pitch_log_admin_all on public.licensing_pitch_log
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 3. Operator-controlled sync research campaign config (Meditate-only initial)
-- ---------------------------------------------------------------------------
insert into public.ops_settings (setting_key, setting_value, description) values
(
  'sync_research_config',
  jsonb_build_object(
    'version', 1,
    'default_status', 'inactive',
    'tracks', jsonb_build_object(
      '506ad12f-9e2e-450c-b2e9-f3d10670c015', jsonb_build_object(
        'status', 'active_research',
        'label', 'Meditate',
        'notes', 'First operational sync research campaign'
      ),
      '5d09da7e-98cf-4276-8dca-861d1fbbfa98', jsonb_build_object(
        'status', 'inactive',
        'label', 'Designed For Me (Control)',
        'notes', 'Inactive for sync research'
      ),
      'dc36a2c5-f07e-40da-a1b4-0c46c67fadd8', jsonb_build_object(
        'status', 'blocked',
        'label', 'Neva Too Much Prada',
        'notes', 'Blocked until verified private-license evidence and Fendi approval exist'
      )
    )
  ),
  'Operator-controlled sync research track selection. Status: active_research | inactive | blocked. Change via AGH ops_settings — never hard-code titles in runtime.'
)
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Sync research target / opportunity typing + required provenance fields
-- ---------------------------------------------------------------------------
alter table public.sync_research_targets
  add column if not exists target_type text not null default 'agency_introduction',
  add column if not exists acceptance_policy_status text,
  add column if not exists exclusivity_rights_warnings text,
  add column if not exists compensation_known text,
  add column if not exists associated_track_id uuid references public.tracks(id) on delete set null,
  add column if not exists primary_source_url text,
  add column if not exists verification_timestamp timestamptz;

do $$ begin
  alter table public.sync_research_targets
    drop constraint if exists sync_research_targets_target_type_check;
  alter table public.sync_research_targets
    add constraint sync_research_targets_target_type_check
    check (target_type in ('agency_introduction', 'active_brief_contact'));
exception when others then null;
end $$;

alter table public.sync_research_opportunities
  add column if not exists opportunity_type text not null default 'agency_introduction',
  add column if not exists acceptance_policy_status text,
  add column if not exists exclusivity_rights_warnings text,
  add column if not exists music_requirements text,
  add column if not exists usage_type text,
  add column if not exists associated_track_id uuid references public.tracks(id) on delete set null,
  add column if not exists primary_source_url text,
  add column if not exists verification_timestamp timestamptz,
  add column if not exists compensation_known text;

do $$ begin
  alter table public.sync_research_opportunities
    drop constraint if exists sync_research_opportunities_opportunity_type_check;
  alter table public.sync_research_opportunities
    add constraint sync_research_opportunities_opportunity_type_check
    check (opportunity_type in ('active_brief', 'agency_introduction'));
exception when others then null;
end $$;

-- Backfill primary_source_url from source_url / official_url when empty.
update public.sync_research_opportunities
   set primary_source_url = coalesce(nullif(primary_source_url, ''), source_url)
 where primary_source_url is null and source_url is not null;

update public.sync_research_targets
   set primary_source_url = coalesce(nullif(primary_source_url, ''), official_url)
 where primary_source_url is null and official_url is not null;

-- Pitch draft lifecycle + submission evidence (Grok submit path)
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
  add column if not exists batch_id uuid references public.agh_handoff_batches(id) on delete set null;

do $$ begin
  alter table public.sync_research_pitch_drafts
    drop constraint if exists sync_research_pitch_drafts_status_check;
  alter table public.sync_research_pitch_drafts
    add constraint sync_research_pitch_drafts_status_check
    check (status in (
      'draft', 'superseded', 'approved', 'rejected', 'sent_manual', 'submitted', 'awaiting_response'
    ));
exception when others then null;
end $$;

do $$ begin
  alter table public.sync_research_pitch_drafts
    drop constraint if exists sync_research_pitch_drafts_submission_channel_check;
  alter table public.sync_research_pitch_drafts
    add constraint sync_research_pitch_drafts_submission_channel_check
    check (submission_channel is null or submission_channel in ('email', 'web_form'));
exception when others then null;
end $$;

-- Durable batch counters on sync handoff batches
alter table public.agh_handoff_batches
  add column if not exists track_id uuid references public.tracks(id) on delete set null,
  add column if not exists raw_count int not null default 0,
  add column if not exists verified_count int not null default 0,
  add column if not exists opportunity_count int not null default 0,
  add column if not exists drafted_count int not null default 0,
  add column if not exists approved_count int not null default 0,
  add column if not exists submitted_count int not null default 0,
  add column if not exists rejected_count int not null default 0,
  add column if not exists response_count int not null default 0,
  add column if not exists source_evidence_summary text;

-- ---------------------------------------------------------------------------
-- 5. OAuth: allow sync_discovery scope + claude_sync_discovery actor
-- ---------------------------------------------------------------------------
alter table public.agh_mcp_oauth_tokens
  drop constraint if exists agh_mcp_oauth_tokens_actor_kind_check;

alter table public.agh_mcp_oauth_tokens
  add constraint agh_mcp_oauth_tokens_actor_kind_check
  check (actor_kind in ('claude_playlist_discovery', 'claude_sync_discovery'));

comment on table public.agh_mcp_oauth_tokens is
  'Opaque OAuth tokens for MCP connectors. actor_kind is scope-bound: playlist_discovery→claude_playlist_discovery, sync_discovery→claude_sync_discovery.';

-- Consume code: derive actor from authorized code scope (playlist or sync).
create or replace function public.agh_mcp_consume_oauth_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_expected_challenge text,
  p_access_token_hash text,
  p_refresh_token_hash text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.agh_mcp_oauth_codes%rowtype;
  v_deleted int;
  v_scope text;
  v_actor text;
begin
  if p_code_hash is null or p_client_id is null or p_access_token_hash is null or p_refresh_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'required fields missing');
  end if;

  select * into v_code
    from public.agh_mcp_oauth_codes
   where code_hash = p_code_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code not found or already used');
  end if;

  if v_code.expires_at < now() then
    delete from public.agh_mcp_oauth_codes where code_hash = p_code_hash;
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code expired');
  end if;

  if v_code.client_id is distinct from p_client_id
     or v_code.redirect_uri is distinct from p_redirect_uri then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'client/redirect mismatch');
  end if;

  if p_expected_challenge is not null
     and v_code.code_challenge is distinct from p_expected_challenge then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'pkce_failed');
  end if;

  v_scope := coalesce(nullif(trim(v_code.scope), ''), 'playlist_discovery');
  if v_scope = 'sync_discovery' then
    v_actor := 'claude_sync_discovery';
  elsif v_scope = 'playlist_discovery' then
    v_actor := 'claude_playlist_discovery';
  else
    return jsonb_build_object('ok', false, 'code', 'invalid_scope', 'error', 'unsupported scope');
  end if;

  delete from public.agh_mcp_oauth_codes where code_hash = p_code_hash;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'code already consumed');
  end if;

  insert into public.agh_mcp_oauth_tokens (
    token_hash, refresh_token_hash, client_id, scope, actor_kind,
    authorized_by_user_id, expires_at, refresh_expires_at
  ) values (
    p_access_token_hash, p_refresh_token_hash, p_client_id, v_scope,
    v_actor, v_code.authorized_by_user_id,
    p_access_expires_at, p_refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_code.authorized_by_user_id,
    'scope', v_scope,
    'actor_kind', v_actor
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'error', 'token hash collision');
end;
$$;

revoke all on function public.agh_mcp_consume_oauth_code(
  text, text, text, text, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.agh_mcp_consume_oauth_code(
  text, text, text, text, text, text, timestamptz, timestamptz
) to service_role;

-- Rotate refresh: preserve prior actor_kind + scope from the family.
create or replace function public.agh_mcp_rotate_oauth_refresh(
  p_refresh_token_hash text,
  p_client_id text,
  p_new_access_token_hash text,
  p_new_refresh_token_hash text,
  p_access_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok public.agh_mcp_oauth_tokens%rowtype;
  v_updated int;
begin
  if p_refresh_token_hash is null or p_client_id is null
     or p_new_access_token_hash is null or p_new_refresh_token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request', 'error', 'required fields missing');
  end if;

  select * into v_tok
    from public.agh_mcp_oauth_tokens
   where refresh_token_hash = p_refresh_token_hash
     and revoked_at is null
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh not found or revoked');
  end if;

  if v_tok.client_id is distinct from p_client_id then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'client mismatch');
  end if;

  if v_tok.refresh_expires_at is null or v_tok.refresh_expires_at < now() then
    update public.agh_mcp_oauth_tokens
       set revoked_at = now()
     where token_hash = v_tok.token_hash;
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh_expired');
  end if;

  update public.agh_mcp_oauth_tokens
     set revoked_at = now()
   where token_hash = v_tok.token_hash
     and revoked_at is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'code', 'invalid_grant', 'error', 'refresh already rotated');
  end if;

  insert into public.agh_mcp_oauth_tokens (
    token_hash, refresh_token_hash, client_id, scope, actor_kind,
    authorized_by_user_id, expires_at, refresh_expires_at
  ) values (
    p_new_access_token_hash, p_new_refresh_token_hash, p_client_id, v_tok.scope,
    v_tok.actor_kind, v_tok.authorized_by_user_id,
    p_access_expires_at, v_tok.refresh_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'authorized_by_user_id', v_tok.authorized_by_user_id,
    'refresh_expires_at', v_tok.refresh_expires_at,
    'scope', v_tok.scope,
    'actor_kind', v_tok.actor_kind
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'conflict', 'error', 'token hash collision');
end;
$$;

revoke all on function public.agh_mcp_rotate_oauth_refresh(
  text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.agh_mcp_rotate_oauth_refresh(
  text, text, text, text, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Daily stations: allow grok sync review/send (ledger only; additive)
-- ---------------------------------------------------------------------------
-- Expand station_id check by recreating constraint if present.
do $$ begin
  alter table public.daily_ops_station_runs
    drop constraint if exists daily_ops_station_runs_station_id_check;
exception when others then null;
end $$;

-- Prefer no hard check so new stations can be added via code + ops_settings.
-- Historical rows remain valid.

-- Append grok sync stations into daily_stations setting without clobbering operator edits.
update public.ops_settings
   set setting_value = jsonb_set(
     setting_value,
     '{stations}',
     coalesce(setting_value->'stations', '[]'::jsonb) ||
     jsonb_build_array(
       jsonb_build_object(
         'id', 'grok_sync_review',
         'label', 'Grok sync review',
         'local_time', '13:30',
         'owner', 'grok_playlist_control',
         'requires_upstream_queue_state', 'AWAITING_GROK_REVIEW',
         'batch_kind', 'sync'
       ),
       jsonb_build_object(
         'id', 'grok_sync_send',
         'label', 'Grok sync submit',
         'local_time', '15:30',
         'owner', 'grok_playlist_control',
         'requires_upstream_queue_state', 'APPROVED_FOR_SEND',
         'batch_kind', 'sync'
       )
     )
   ),
   updated_at = now()
 where setting_key = 'daily_stations'
   and not exists (
     select 1
       from jsonb_array_elements(coalesce(setting_value->'stations', '[]'::jsonb)) s
      where s->>'id' = 'grok_sync_review'
   );

commit;
