## Plan

1. Apply migration `supabase/migrations/20260612_outreach_verification_gate.sql` as-written (idempotent, no edits).
2. Redeploy these 8 edge functions in one batch:
   - execute-pitch
   - resend-webhook
   - playlist-admin-api
   - draft-pitch
   - approve-draft
   - schedule-follow-up
   - control-center-api
   - enrich-curator-contacts

No source code changes. No other functions touched.