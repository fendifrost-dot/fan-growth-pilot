# HANDOFF → CURSOR

**Repo:** `fendifrost-dot/fan-growth-pilot`
**Written:** 2026-09-05 by Claude (execution / catalog-preparation operator)
**Received + actioned by Cursor:** 2026-09-05
**Baseline at handoff:** `origin/main` @ `6d864c9`

See also:

- `docs/CURSOR_GAP5_song_dna_rls_lockout.md` — **P0** (applied live)
- `docs/CURSOR_AUDIT_gap2_stale_drafts.md` — **P1 / P2**
- `docs/CURSOR_TASK_pitch_copy_decoupling.md` — complete

## Live state (Claude, 2026-09-05 01:24 UTC)

Enforcement is **live** after Lovable redeploy 2026-09-04 23:37 UTC. Shadow mode is gone.

| | |
|---|---|
| `song_dna_versions` | Was 0 rows + RLS write-lock for owner |
| Approved drafts with old house copy | 1,551 · **709 Meditate (wrong)** · 842 Designed For Me (correct for that song) |
| Next scheduled run | ~15:20 UTC daily |

## Cursor status after this branch

1. **P0 RLS** — policies swapped to `public.has_role(auth.uid(), 'admin')`; applied in production via Lovable. Migration `20260905140000_fix_dna_rls_use_has_role.sql`.
2. **P1 stale drafts** — `execute-pitch` / `send-pitch-email` require approved `draft_id`, verify `pitch_copy_hash` / body containment, refuse mismatch with 422. Hub action `invalidate_stale_drafts` (dry-run default). **Still needs Lovable edge redeploy of this branch.**
3. **P2** — `{{fit_reason}}` removed from template placeholders; IG queue requires `track_id`. Fan DM templates remain (lower priority).

## Not Cursor's

Do not seed Song DNA / short_pitch / reference_artists for other tracks; leave `sample_declaration=unknown` and `sync_recommendation=blocked`; do not rewrite historical `pitch_log` rows or lane assignments.
