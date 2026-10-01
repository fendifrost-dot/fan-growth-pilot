# Roadmap

## Open
- [ ] Sync working tree to GitHub main @ `10ce0ef` (PRs #43, #44, #45) — no code authored by me, no SQL, no secret changes.
- [ ] Redeploy exactly 13 edge functions: approve-draft, control-center-api, draft-pitch, enrich-curator-contacts, execute-pitch, log-pitch-response (new; keep `verify_jwt = false` per supabase/config.toml), mcp-playlist-discovery, mcp-sync-discovery, playlist-admin-api, playlist-research, schedule-follow-up, send-pitch-email, update-pitch-status.
- [ ] Report which functions were redeployed.

## Done
- [x] `PITCH_RESPONSE_LOG_KEY` created in Lovable Cloud Secrets via secure form (value never shown in chat).
- [x] All 45 edge functions redeployed + frontend published (previous turn).
- [x] Migration `20260927120000_route_hold_and_candidate_log.sql` — awaiting explicit go-ahead, still unapplied (not part of this request; do not run SQL).
