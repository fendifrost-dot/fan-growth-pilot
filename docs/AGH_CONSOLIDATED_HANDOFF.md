# AGH / FanFuel Hub — consolidated handoff (Cursor continuous build)

**Date:** 2026-09-02  
**Branch:** `cursor/phase0-locked-decisions-02a5`  
**PR:** https://github.com/fendifrost-dot/fan-growth-pilot/pull/8  
**Verdict:** **NOT ready to merge or deploy.** Code backlog for approved operating surfaces is largely implemented in-repo; live DB + Fendi approvals + production authorize remain blockers.

## Features completed (in code)

1. Phase 0 locked decisions, Control UUID cooldown, campaign identity gate, sync_eligible remediation  
2. Shared playlist send gate (`send-identity-gate`) on `execute-pitch` + `send-pitch-email` with `PITCH_IDENTITY_GATE` arming  
3. Song DNA versions + audit + Fendi JWT approve/reject + admin UI + Pitch Portal wiring  
4. DNA↔playlist genre-fit on sends  
5. Lyrics manual transcriptions + deferred provider adapter  
6. Split-sheet generator (incomplete → action items) + HTML document  
7. Ops incidents, Press/EPK, private license evidence vault  
8. Sync/licensing register write auth; playlist-agent + radio CCA auth; catalogue admin-write  
9. Expanded Vitest + Deno CI  

Fan capture / smart-link / truth funnel surfaces were already present on `main` lineage and remain.

## Commit list (since Phase 0 branch start)

```
b54741a fix(auth): gate playlist-agent and radio actions; catalogue admin-write
7fecb31 feat(ops): DNA genre-fit on sends, incidents, press/EPK, license vault
d6f42f7 feat(ops): lyrics manual path, split-sheet generator, sync write auth
d17af74 feat(song-dna): schema, CCA workflow, admin UI, Pitch Portal wiring
3b0c5ec fix(pr8): close remaining Phase 0 send/auth/migration blockers
728d134 fix(pr8): address review — UUID gates, sync gate, campaigns, CI
ff8d440 feat(phase0): lock Fendi decisions — Control cooldown, campaigns, MEDITATE copy
1ed5e92 chore(phase0): commit sync-operator migration + tests already live
```

## Automated checks

- `npm run typecheck` — pass (local)  
- Vitest suite in `.github/workflows/ci.yml` — pass (local + CI on prior commits)  
- Deno edge tests listed in CI — pass (local)  
- `npm run build` — pass (local)  
- CI on `d17af74` / `d6f42f7` — success; follow head commits via Actions  

## New migrations (apply via Lovable SQL Editor only)

Order after campaign stack exists (see `docs/PHASE0_ATOMIC_CUTOVER.md`):

1. `20260902190000_control_pitch_log_track_id_backfill.sql` (already applied live; idempotent)  
2. Campaign stack + `20260902200000_campaign_gate_require_and_control_backfill.sql`  
3. `20260903000000_song_dna_versions.sql`  
4. `20260903100000_lyrics_transcriptions.sql`  
5. `20260903110000_split_sheets.sql`  
6. `20260903200000_ops_incidents_press_license.sql`  

## Remaining Fendi-only decisions

1. Approve Song DNA versions (genre / lanes / sample)  
2. Sync / sample declaration approvals per track  
3. Contributor legal names, splits, PRO, IPI  
4. Upload Neva private license evidence  
5. Final press kit copy  
6. Lyric provider budget (still deferred)  
7. **Production authorization** to apply SQL, arm `PITCH_IDENTITY_GATE=required`, redeploy `execute-pitch` + `send-pitch-email` + `control-center-api`, Publish frontend  

## Deployment sequence (after production authorize)

1. Apply migrations in order (Lovable SQL Editor)  
2. Verify: `pitch_campaigns` exists, DNA table exists, Control leftover = 0, FK present  
3. Fendi creates/approves DNA; creates draft campaigns; activates with JWT  
4. Set secret `PITCH_IDENTITY_GATE=required`  
5. Redeploy together: `execute-pitch`, `send-pitch-email`, `control-center-api`  
6. Lovable Publish frontend  
7. Verify missing credentials / missing campaign_id rejected on both senders; genre-fit refuses mismatch  

## Rollback

- Unset `PITCH_IDENTITY_GATE` (senders 503 fail-closed — stops sends, does not re-open title-only)  
- Do not reverse applied migrations; ship forward remediation SQL if needed  
- Redeploy prior known-good edge function bundle only with explicit production authorize  

## Residual risks

- Live DB may still lack `pitch_campaigns` / `song_dna_versions` until apply  
- Accidental half-redeploy of one sender without arming/secret coordination  
- Scheduler/cron callers must present correct secrets after auth hardening  
- Empty playlist categories fail genre-fit closed (intentional)  

## Merge/deploy readiness

**NO — do not merge or deploy** until production authorization + migration apply + Fendi DNA/campaign activation + gate arming checklist is green.
