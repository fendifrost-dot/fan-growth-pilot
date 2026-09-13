-- Corrective invariants for sync + authoritative split-sheet delivery.
-- Additive. Does not change campaign statuses or Song DNA.
-- Apply via Lovable SQL Editor (paste). Required objects fail the transaction
-- visibly — no "exception when others then null" around constraints.

begin;

-- ---------------------------------------------------------------------------
-- 1. Honest document kinds + delivery results
-- ---------------------------------------------------------------------------
alter table public.rights_document_audit_events
  drop constraint if exists rights_document_audit_events_event_kind_check;
alter table public.rights_document_audit_events
  add constraint rights_document_audit_events_event_kind_check
  check (event_kind in (
    'view', 'download', 'delivery', 'create_version', 'finalize',
    'supersede', 'confirm', 'dispute', 'evidence_upload', 'eligibility_recompute',
    'delivery_authorization_request', 'delivery_authorization_granted',
    'evidence_verify', 'evidence_reject', 'manual_submission'
  ));

alter table public.split_sheets
  drop constraint if exists split_sheets_document_kind_check;
alter table public.split_sheets
  add constraint split_sheets_document_kind_check
  check (document_kind in (
    'agh_generated_summary',
    'contributor_confirmed',
    'uploaded_signed',
    'provider_signed',
    'verified_signed'
  ));

alter table public.split_sheet_deliveries
  drop constraint if exists split_sheet_deliveries_delivery_result_check;
alter table public.split_sheet_deliveries
  add constraint split_sheet_deliveries_delivery_result_check
  check (delivery_result in (
    'logged',
    'awaiting_manual_submission',
    'sent',
    'failed',
    'blocked'
  ));

alter table public.split_sheets
  add column if not exists document_storage_path text,
  add column if not exists document_mime text,
  add column if not exists generated_html text;

alter table public.split_sheet_deliveries
  add column if not exists provider_message_id text,
  add column if not exists provider_response jsonb,
  add column if not exists requested_by text,
  add column if not exists authorized_by text,
  add column if not exists idempotency_key text,
  add column if not exists document_storage_path text;

create unique index if not exists split_sheet_deliveries_idempotency_uidx
  on public.split_sheet_deliveries (idempotency_key)
  where idempotency_key is not null;

alter table public.split_sheet_evidence
  add column if not exists signer_contributor_id uuid
    references public.split_sheet_contributors(id) on delete set null,
  add column if not exists object_bytes_sha256 text;

-- Sync outreach send truth
alter table public.sync_research_pitch_drafts
  add column if not exists send_idempotency_key text,
  add column if not exists provider_response jsonb,
  add column if not exists send_attempted_at timestamptz;

do $$ begin
  alter table public.sync_research_pitch_drafts
    drop constraint if exists sync_research_pitch_drafts_status_check;
  alter table public.sync_research_pitch_drafts
    add constraint sync_research_pitch_drafts_status_check
    check (status in (
      'draft', 'superseded', 'approved', 'rejected',
      'sent_manual', 'submitted', 'awaiting_response',
      'awaiting_manual_submission', 'send_failed'
    ));
end $$;

create unique index if not exists sync_research_pitch_drafts_send_idempotency_uidx
  on public.sync_research_pitch_drafts (send_idempotency_key)
  where send_idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 2. Final-document immutability — every material field
-- ---------------------------------------------------------------------------
create or replace function public._split_sheet_prevent_final_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'final' then
      raise exception 'finalized split sheets are immutable — create a new version';
    end if;
    return old;
  end if;
  if old.status = 'final' then
    -- Allow only is_current / superseded_by / status→superseded when a newer version replaces it.
    if new.status is distinct from old.status
       and not (old.status = 'final' and new.status = 'superseded') then
      raise exception 'finalized split sheets are immutable — create a new version';
    end if;
    if new.generated_html is distinct from old.generated_html
       or new.document_hash is distinct from old.document_hash
       or new.document_kind is distinct from old.document_kind
       or new.document_storage_path is distinct from old.document_storage_path
       or new.document_mime is distinct from old.document_mime
       or new.composition_total_percent is distinct from old.composition_total_percent
       or new.master_total_percent is distinct from old.master_total_percent
       or new.track_id is distinct from old.track_id
       or new.version_number is distinct from old.version_number
       or new.title is distinct from old.title
       or new.notes is distinct from old.notes
       or new.one_stop_master is distinct from old.one_stop_master
       or new.publishing_controlled is distinct from old.publishing_controlled
       or new.master_controlled is distinct from old.master_controlled
       or new.confirmation_summary is distinct from old.confirmation_summary
       or new.rights_readiness is distinct from old.rights_readiness
       or new.finalized_at is distinct from old.finalized_at
       or new.finalized_by is distinct from old.finalized_by
       or new.fendi_approved_at is distinct from old.fendi_approved_at
       or new.fendi_approved_by is distinct from old.fendi_approved_by
    then
      raise exception 'finalized split sheets are immutable — create a new version';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists split_sheets_final_immutable on public.split_sheets;
create trigger split_sheets_final_immutable
  before update or delete on public.split_sheets
  for each row execute function public._split_sheet_prevent_final_mutation();

-- Evidence: verified rows cannot be rewritten; rejection is allowed (status only).
create or replace function public._split_sheet_evidence_protect_verified()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.verification_status = 'verified' then
      raise exception 'verified evidence is append-only — reject it instead of deleting';
    end if;
    return old;
  end if;
  if old.verification_status = 'verified'
     and new.verification_status = 'verified' then
    if new.storage_path is distinct from old.storage_path
       or new.document_hash is distinct from old.document_hash
       or new.object_bytes_sha256 is distinct from old.object_bytes_sha256
       or new.evidence_kind is distinct from old.evidence_kind
       or new.signer_contributor_id is distinct from old.signer_contributor_id
    then
      raise exception 'verified evidence bytes/identity are immutable';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists split_sheet_evidence_protect_verified on public.split_sheet_evidence;
create trigger split_sheet_evidence_protect_verified
  before update or delete on public.split_sheet_evidence
  for each row execute function public._split_sheet_evidence_protect_verified();

-- ---------------------------------------------------------------------------
-- 3. Operating scope key — copy existing active_research ids; do not retitle
-- ---------------------------------------------------------------------------
update public.ops_settings
   set setting_value = case
     when setting_value ? 'operating_scope_track_ids' then setting_value
     else jsonb_set(
       setting_value,
       '{operating_scope_track_ids}',
       coalesce((
         select jsonb_agg(key)
           from jsonb_each(coalesce(setting_value->'tracks', '{}'::jsonb))
          where value->>'status' = 'active_research'
       ), '[]'::jsonb),
       true
     )
   end,
   updated_at = now()
 where setting_key = 'sync_research_config';

comment on column public.split_sheet_deliveries.delivery_result is
  'Honest transport result. signed URL mint ≠ sent. Manual packets stay awaiting_manual_submission until Grok records external confirmation.';

-- Fendi-controlled delivery policy: request_only (default) | proactive_allowed.
-- Older labels remain readable but are remapped without changing campaign status.
update public.tracks
   set split_sheet_delivery_policy = case
         when split_sheet_delivery_policy = 'opportunity_required' then 'proactive_allowed'
         when split_sheet_delivery_policy in ('fendi_authorized') then 'request_only'
         else split_sheet_delivery_policy
       end
 where split_sheet_delivery_policy is not null
   and split_sheet_delivery_policy not in ('request_only', 'proactive_allowed');

alter table public.tracks
  drop constraint if exists tracks_split_sheet_delivery_policy_check;
alter table public.tracks
  add constraint tracks_split_sheet_delivery_policy_check
  check (split_sheet_delivery_policy in ('request_only', 'proactive_allowed'));

commit;
