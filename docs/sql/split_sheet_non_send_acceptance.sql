-- Non-send acceptance checks for authoritative split sheets + master-owner immutability.
-- Paste into Lovable → SQL Editor AFTER applying:
--   20260911160000_authoritative_split_sheets.sql
--   20260912010000_split_sheet_master_owner_immutability.sql
-- Do NOT send pitches or deliver documents. Read-only / safe probes only.

-- 1) Objects present
select to_regprocedure(
  'public.create_split_sheet_version(uuid, jsonb, jsonb, text, text, boolean, boolean, boolean, text)'
) is not null as create_rpc_present;
select to_regprocedure('public.finalize_split_sheet_version(uuid, text)') is not null as finalize_rpc_present;
select exists (
  select 1 from pg_trigger
  where tgname = 'split_sheet_master_owners_final_immutable'
) as master_owner_immutable_trigger;
select exists (
  select 1 from storage.buckets where id = 'rights-documents' and coalesce(public, false) = false
) as rights_documents_private;

-- 2) Legacy provenance columns
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'tracks'
  and column_name in (
    'splits_ready', 'splits_ready_legacy', 'splits_ready_source',
    'current_split_sheet_id', 'split_sheet_delivery_policy'
  )
order by column_name;

-- 3) No track should be sync-ready on unverified_legacy alone
-- (informational — expect zero rows with authoritative readiness falsely derived)
select id, title, splits_ready, splits_ready_source, splits_ready_legacy
from public.tracks
where splits_ready = true
  and coalesce(splits_ready_source, '') <> 'authoritative_final'
limit 50;
