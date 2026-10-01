# Roadmap

## Open
- [ ] `log-pitch-response` reports `not_configured` even though `PITCH_RESPONSE_LOG_KEY` is saved and the function is deployed (verified after 2 redeploys + a rebind). Function returns that code when the value it can read is missing **or shorter than 24 chars**. Fix = re-enter a 32+ char value in the secure form (`update_secret`). Blocked: user said "do not add or change any secrets" this turn — awaiting go-ahead.

## Done
- [x] Synced working tree to GitHub main @ `10ce0ef` (PRs #43, #44, #45) — tree already matched; only delta was auto-generated `src/integrations/supabase/types.ts` (additive, local-only), left untouched. No code authored, no SQL run.
- [x] Redeployed exactly 13 functions: approve-draft, control-center-api, draft-pitch, enrich-curator-contacts, execute-pitch, log-pitch-response, mcp-playlist-discovery, mcp-sync-discovery, playlist-admin-api, playlist-research, schedule-follow-up, send-pitch-email, update-pitch-status.
- [x] `supabase/config.toml` confirmed identical to main with `[functions.log-pitch-response] verify_jwt = false`; not modified.
- [x] `PITCH_RESPONSE_LOG_KEY` created in Lovable Cloud Secrets via secure form (value never shown in chat); present in store (29 names).
- [x] All 45 edge functions redeployed + frontend published (earlier).

## Held (needs explicit go-ahead)
- [ ] Migration `20260927120000_route_hold_and_candidate_log.sql` (PR #40) — still unapplied; no SQL run.
- [ ] Security review of 45 unresolved critical findings + lockdown migration draft.
