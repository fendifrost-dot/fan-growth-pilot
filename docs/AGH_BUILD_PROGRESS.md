# AGH / FanFuel Hub — implementation progress (Cursor continuous build)

**Branch:** `cursor/phase0-locked-decisions-02a5`  
**Repo:** `fendifrost-dot/fan-growth-pilot`  
**Production:** do **not** merge, Publish, apply migrations, or redeploy gated senders without separate production authorization.

## Completed in code (commits on this branch)

| Area | Status | Key artifacts |
|------|--------|---------------|
| Phase 0 locks + Control cooldown + campaign gate | done | prior commits through `3b0c5ec` |
| Song DNA schema + Fendi approval workflow + admin UI | done | `20260903000000`, `_shared/song-dna.ts`, `AdminSongDna` |
| Lyrics manual + provider-neutral deferred adapter | done | `20260903100000`, `_shared/lyrics.ts`, `AdminLyrics` |
| Split-sheet generator (incomplete OK) | done | `20260903110000`, `_shared/split-sheets.ts`, `AdminSplitSheets` |
| Sync-register write auth | done | CCA `authorizeAction` on sync actions |
| Playlist-agent + radio path auth | done | CCA `authorizeAction` before dispatch; catalogue writes = admin-write |
| DNA↔playlist genre-fit on shared send gate | done | `_shared/genre-fit.ts` wired into `send-identity-gate` |
| Ops incidents + Press/EPK + private license evidence | done | `20260903200000`, `_shared/ops-press.ts`, admin pages |
| Canonical playlist send gate | done | `execute-pitch` + `send-pitch-email` share `send-identity-gate` + `PITCH_IDENTITY_GATE` |
| Draft/approve identity (no title-only) | done | `outreach_drafts.track_id`, composer campaign picker, approve forwards IDs |
| Playlist category coverage audit | done | `audit_playlist_category_coverage` + `/admin/category-coverage` |

## Migrations to apply (Lovable SQL Editor — order)

1. Campaign stack if missing (`20260718005000` → `20260718000000` → `20260718010000` revised draft seed → `20260902000000` → `20260902120000`)
2. `20260902190000` Control backfill (already applied live; idempotent)
3. `20260902200000` campaign gate require (fails if no `pitch_campaigns`)
4. `20260903000000` Song DNA
5. `20260903100000` Lyrics
6. `20260903110000` Split sheets
7. `20260903200000` Ops / press / private license
8. `20260904000000` outreach_drafts.track_id (+ metadata backfill)

## Atomic send cutover (still blocked live)

See `docs/PHASE0_ATOMIC_CUTOVER.md`. Live still had `pitch_campaigns` / `song_dna_versions` null as of last SQL check. Do not set `PITCH_IDENTITY_GATE=required` or redeploy senders until DNA approvals + active campaigns exist.

## Fendi-only decisions (batched — do not invent)

1. Approve each Song DNA version (genre/lanes/sample) after drafts exist
2. Confirm sample declarations and sync approvals per track
3. Contributor legal names / splits / PRO / IPI for split sheets
4. Private license upload for Neva Too Much Prada (path exists; evidence is Fendi’s)
5. Press kit bio/one-liner copy if not already final
6. Separate budget decision before any lyric vendor
7. Production authorization to apply migrations + arm gate + redeploy

## Checks

Run locally / CI: `npm run typecheck`, vitest suite in `.github/workflows/ci.yml`, Deno edge tests listed there, `npm run build`.
