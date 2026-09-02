# AGH / FanFuel Hub — consolidated handoff (Cursor continuous build)

**Date:** 2026-09-02  
**Branch:** `cursor/phase0-locked-decisions-02a5`  
**Head:** `ecdddc1`  
**PR:** https://github.com/fendifrost-dot/fan-growth-pilot/pull/8  
**Verdict:** **NOT ready to Publish or redeploy gated senders.** Approved operating-surface code is implemented in-repo and CI is green; live Lovable DB + Fendi approvals + production authorize remain the cutover blockers.

## Features completed (in code)

1. Phase 0 locked decisions, Control UUID cooldown, campaign identity gate, sync_eligible remediation  
2. Shared playlist send gate (`send-identity-gate`) on `execute-pitch` + `send-pitch-email` with `PITCH_IDENTITY_GATE` arming  
3. Song DNA versions + audit + Fendi JWT approve/reject + admin UI + Pitch Portal wiring  
4. DNA↔playlist genre-fit on sends  
5. Lyrics manual transcriptions + deferred provider adapter  
6. Split-sheet generator (incomplete → action items) + HTML document  
7. Ops incidents, Press/EPK, private license evidence vault + admin UI  
8. Sync/licensing register write auth; playlist-agent + radio CCA auth; catalogue admin-write  
9. Draft/approve identity (no title-only): `outreach_drafts.track_id`, composer campaign picker, follow-up cron  
10. Playlist category coverage audit (`audit_playlist_category_coverage` + `/admin/category-coverage`)  
11. Sync eligibility persistence from DNA + Fendi/ops gates (`/admin/sync-gate`; Neva needs private license)  
12. Fan leads/stats admin UI; pitch log shows `track_id`/`campaign_id`  
13. Supabase types refreshed for AGH tables/columns; catalogue deep-links  
14. Expanded Vitest + Deno CI  

Fan capture / smart-link / truth funnel surfaces were already present on `main` lineage and remain. Lyric vendor remains deferred (Phase 0 §6).

## Recent commits (this continuous-build loop)

```
ecdddc1 chore(types): add pitch_campaigns, lyrics, and split-sheet tables
d82d50b chore(types): refresh AGH schema types + catalogue deep-links
91753df feat(sync): persist sync_eligible from DNA + Fendi gates
53c4cc9 feat(admin): private license vault, fan leads, pitch-log identity
d803189 feat(outreach): require draft campaign identity + category coverage audit
```

## Automated checks

- `npm run typecheck` — pass  
- Vitest suite in `.github/workflows/ci.yml` — pass  
- Deno edge tests listed in CI — pass  
- `npm run build` — pass  
- GitHub Actions on branch — green through `d82d50b` / `91753df`; follow head via Actions  

## Migrations to apply (Lovable SQL Editor only)

Order after campaign stack exists (see `docs/PHASE0_ATOMIC_CUTOVER.md`):

1. `20260902190000_control_pitch_log_track_id_backfill.sql` (already applied live; idempotent)  
2. Campaign stack + `20260902200000_campaign_gate_require_and_control_backfill.sql`  
3. `20260903000000_song_dna_versions.sql`  
4. `20260903100000_lyrics_transcriptions.sql`  
5. `20260903110000_split_sheets.sql`  
6. `20260903200000_ops_incidents_press_license.sql`  
7. `20260904000000_outreach_drafts_track_id.sql`  
8. `20260904100000_track_sync_gate_columns.sql`  

## Remaining Fendi-only decisions

1. Approve Song DNA versions (genre / lanes / sample)  
2. Sync / sample declaration approvals per track (via Sync gate)  
3. Contributor legal names, splits, PRO, IPI  
4. Upload Neva private license evidence  
5. Final press kit copy  
6. Lyric provider budget (still deferred)  
7. **Production authorization** to apply SQL, arm `PITCH_IDENTITY_GATE=required`, redeploy `execute-pitch` + `send-pitch-email` + `control-center-api`, Publish frontend  

## Deployment sequence (after production authorize)

1. Apply migrations in order (Lovable SQL Editor)  
2. Verify: `pitch_campaigns` exists, DNA table exists, Control leftover = 0, FK present, sync-gate columns present  
3. Run category coverage audit; fill empty playlist categories  
4. Fendi creates/approves DNA; sets sync-gate flags; creates draft campaigns; activates with JWT  
5. Set secret `PITCH_IDENTITY_GATE=required`  
6. Redeploy together: `execute-pitch`, `send-pitch-email`, `control-center-api`  
7. Lovable Publish frontend  
8. Verify missing credentials / missing campaign_id rejected on both senders; genre-fit refuses mismatch  

## Rollback

- Unset `PITCH_IDENTITY_GATE` (senders 503 fail-closed — stops sends, does not re-open title-only)  
- Do not reverse applied migrations; ship forward remediation SQL if needed  
- Redeploy prior known-good edge function bundle only with explicit production authorize  

## Residual risks

- Live DB may still lack `pitch_campaigns` / `song_dna_versions` / sync-gate columns until apply  
- Accidental half-redeploy of one sender without arming/secret coordination  
- Scheduler/cron callers must present correct secrets after auth hardening  
- Empty playlist categories fail genre-fit closed (intentional)  

## Merge/deploy readiness

**NO — do not Publish or redeploy gated playlist senders** until production authorization + migration apply + Fendi DNA/campaign/sync activation + category coverage + gate arming checklist is green.
