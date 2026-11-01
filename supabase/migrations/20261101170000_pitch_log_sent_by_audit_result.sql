-- Incident 75091b14 (2026-11-01): successful execute-pitch sends must record
-- who sent the pitch and the pre-send gate decision.
--
-- Apply via Lovable SQL Editor (paste, don't type). Do not apply via supabase CLI.
-- Apply this migration before or together with the execute-pitch deploy.
-- The function inserts sent_by and audit_result; those inserts fail if the
-- columns are not present yet.

alter table public.pitch_log
  add column if not exists sent_by text,
  add column if not exists audit_result text;

comment on column public.pitch_log.sent_by is
  'Acting agent on a successful execute-pitch send. The function only sees the shared hub key, so this is the server-sealed outreach_drafts.approved_by.';
comment on column public.pitch_log.audit_result is
  'Pre-send gate decision on a successful send. PASS when gateEmailDispatch returned sendable.';

-- Backfill only the row PLC flagged, and only while both new fields are still null.
update public.pitch_log
   set sent_by = 'grok_playlist_control',
       audit_result = 'PASS'
 where id = 'fa9972ad-40fd-4b40-9e0f-fd1d9678992e'::uuid
   and sent_by is null
   and audit_result is null;
