-- Non-send acceptance checks for authoritative split sheets + delivery truth.
-- Paste into Lovable → SQL Editor AFTER applying (in order, skip already-applied):
--   supabase/migrations/20260911150000_sync_operating_stack.sql
--   supabase/migrations/20260911160000_authoritative_split_sheets.sql
--   supabase/migrations/20260912010000_split_sheet_master_owner_immutability.sql
--   supabase/migrations/20260913120000_sync_split_delivery_corrections.sql
-- Do NOT send pitches, finalize sheets, deliver documents, or mutate campaigns.

-- 1) RPCs present
select to_regprocedure(
  'public.create_split_sheet_version(uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text)'
) is not null as create_rpc_present;

select to_regprocedure(
  'public.finalize_split_sheet_version(uuid, text, text, text, text, text, text, text, boolean)'
) is not null as finalize_rpc_present;

-- 2) Required tables
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'split_sheets',
    'split_sheet_contributors',
    'split_sheet_master_owners',
    'split_sheet_evidence',
    'split_sheet_deliveries',
    'rights_document_audit_events',
    'sync_research_pitch_drafts',
    'ops_settings'
  )
order by table_name;

-- 3) Required columns
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'tracks' and column_name in (
      'splits_ready', 'splits_ready_legacy', 'splits_ready_source',
      'current_split_sheet_id', 'split_sheet_delivery_policy', 'name'
    ))
    or (table_name = 'split_sheets' and column_name in (
      'document_hash', 'document_kind', 'document_storage_path', 'document_mime',
      'generated_html', 'is_current', 'finalized_at', 'finalized_by',
      'one_stop_master', 'publishing_controlled', 'master_controlled'
    ))
    or (table_name = 'split_sheet_evidence' and column_name in (
      'verification_status', 'document_hash', 'storage_path',
      'signer_contributor_id', 'object_bytes_sha256', 'verified_at', 'verified_by'
    ))
    or (table_name = 'split_sheet_deliveries' and column_name in (
      'delivery_result', 'provider_message_id', 'provider_response',
      'idempotency_key', 'requested_by', 'authorized_by', 'document_hash'
    ))
    or (table_name = 'sync_research_pitch_drafts' and column_name in (
      'send_idempotency_key', 'provider_response', 'send_attempted_at', 'status'
    ))
    or (table_name = 'licensing_pitch_log' and column_name in (
      'approved_by', 'sent_by', 'resend_message_id', 'from_address',
      'draft_id', 'dispatched_via', 'song_dna_version_id'
    ))
  )
order by table_name, column_name;

-- 4) Immutability + protection triggers
select tgname
from pg_trigger
where not tgisinternal
  and tgname in (
    'split_sheets_final_immutable',
    'split_sheet_contributors_final_immutable',
    'split_sheet_master_owners_final_immutable',
    'split_sheet_evidence_protect_verified'
  )
order by tgname;

-- 5) Check constraints
select conname
from pg_constraint
where conname in (
  'split_sheets_document_kind_check',
  'split_sheet_deliveries_delivery_result_check',
  'tracks_splits_ready_source_check',
  'tracks_split_sheet_delivery_policy_check',
  'sync_research_pitch_drafts_status_check'
)
order by conname;

-- 6) Unique constraints / indexes
select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'split_sheets_one_current_per_track',
    'split_sheet_deliveries_idempotency_uidx',
    'sync_research_pitch_drafts_send_idempotency_uidx',
    'licensing_pitch_log_draft_id_uidx'
  )
order by indexname;

-- 7) Foreign keys
select conname
from pg_constraint
where contype = 'f'
  and conname in (
    'split_sheet_master_owners_split_sheet_id_fkey',
    'split_sheet_evidence_split_sheet_id_fkey',
    'split_sheet_deliveries_split_sheet_id_fkey',
    'split_sheet_deliveries_track_id_fkey'
  )
order by conname;

-- 8) Private rights-documents bucket
select exists (
  select 1 from storage.buckets
  where id = 'rights-documents' and coalesce(public, false) = false
) as rights_documents_private;

-- 9) RLS enabled
select c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'split_sheets',
    'split_sheet_contributors',
    'split_sheet_master_owners',
    'split_sheet_evidence',
    'split_sheet_deliveries',
    'rights_document_audit_events'
  )
order by c.relname;

-- 10) RPC execute grants (service_role yes; anon no)
select
  has_function_privilege('service_role', 'public.create_split_sheet_version(uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text)', 'execute')
    as service_role_can_create,
  has_function_privilege('anon', 'public.create_split_sheet_version(uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text, text, text, text, text)', 'execute')
    as anon_can_create,
  has_function_privilege('service_role', 'public.finalize_split_sheet_version(uuid, text, text, text, text, text, text, text, boolean)', 'execute')
    as service_role_can_finalize,
  has_function_privilege('anon', 'public.finalize_split_sheet_version(uuid, text, text, text, text, text, text, text, boolean)', 'execute')
    as anon_can_finalize;

-- 11) Informational: no false readiness from unverified legacy alone
-- Expect zero rows. If rows appear, report — do not mutate.
-- Column is tracks.name (not title).
select id, name, splits_ready, splits_ready_source, splits_ready_legacy
from public.tracks
where splits_ready = true
  and coalesce(splits_ready_source, '') <> 'authoritative_final'
limit 50;

-- 12) Informational: signed-kind current finals without verified evidence
-- Expect zero rows for sync-ready claims. Do not mutate.
select s.id, s.track_id, s.document_kind, s.status, t.splits_ready, t.splits_ready_source
from public.split_sheets s
join public.tracks t on t.id = s.track_id
where s.is_current = true
  and s.document_kind in ('uploaded_signed', 'provider_signed', 'verified_signed')
  and t.splits_ready = true
  and not exists (
    select 1 from public.split_sheet_evidence e
    where e.split_sheet_id = s.id
      and e.verification_status = 'verified'
  )
limit 50;

-- 13) Delivery honesty: no row marked sent without provider id unless manual evidence
select id, delivery_channel, delivery_result, provider_message_id
from public.split_sheet_deliveries
where delivery_result = 'sent'
  and provider_message_id is null
  and coalesce(delivery_channel, '') = 'email'
limit 50;
