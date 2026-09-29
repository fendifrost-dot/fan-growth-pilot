# Playlist inventory and fit requeue repair — September 29

Follow-up to PR #41. Production deployment is left to Fendi. This change does not
submit outreach, change Song DNA, or merge Spotify aliases.

## Changes

- Discovery subtracts usable unsent inventory from any day, including GROK_REVIEWED
  packets. Future/indefinite/invalid deferrals and route holds do not satisfy supply.
  `usable_inflight_packets` exposes the quantity used. Submission goals still count
  actual evidenced submissions only; inventory is a planning floor, not a delivery promise.
- A fresh explicit record review clears the prior deferral and preserves review history.
- Fit requeue keeps records rejected for additional reasons (e.g. LOW_REACH) out of
  automatic recovery. Structured rejection codes must all be recognized fit codes.
  Legacy prose is accepted only in the known single-reason format from the incident;
  ambiguous legacy text stays rejected for individual review, not silently discarded.
- Requeue checks the existing configured per-song curator cooldown across email,
  shared form, and Instagram identities. It preserves explicit email cooldown expiry.
  No new cross-song cooldown is imposed.
- Repair invocations serialize and lock candidate rows to prevent concurrent review
  changes from being overwritten. Installation itself moves no records.

## Deploy in this order

1. Ensure the September 27 and September 28 migrations from PRs #40/#41 have been
   applied. If not, apply them in chronological order.
2. Apply `supabase/migrations/20260929150000_playlist_inventory_requeue_safety.sql`
   in the Lovable SQL Editor, as a complete transaction. Do not re-run an older
   migration afterward: it would replace these repaired function definitions.
3. Redeploy `mcp-playlist-discovery` and `control-center-api` for this follow-up.
   If PR #41's full deployment is still outstanding, also complete its eleven-function
   deployment list in HANDOFF_PLAYLIST_SEPT28_FINDINGS_2026-09-28.md.
4. Run `select public.agh_fit_rejection_requeue(false);` and inspect the preview.
   Mixed/ambiguous rejections should show `other_or_ambiguous_rejection_reasons`;
   active curator cooldowns should show `curator_cooldown_active`.
   Run the apply variant only after the preview is consistent with the intended repair.
5. Read `get_playlist_discovery_work`: confirm `per_song_funnel` includes
   `usable_inflight_packets` and that deferred records do not cancel today's need.

## Verification

Regression coverage is in playlist-funnel.test.ts and test-daily-ops-migrations.sh:
future/missing/malformed/expired deferrals, older/reviewed inventory, approved holds,
mixed rejection reasons, form/email/IG cooldowns, configured duration, song isolation,
legacy reasons, repeat installation/apply, role grants, and explicit deferral resolution.

The 95 Spotify alias collisions remain a separate deduplication task.
