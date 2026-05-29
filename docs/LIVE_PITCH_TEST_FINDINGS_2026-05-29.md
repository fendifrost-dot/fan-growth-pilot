# Live pitch-loop test findings — 2026-05-29

Captured from production admin UI + CCA at test time. **Code fixes are on `main` through `78e96c3`** — production still needs Lovable redeploy + SQL until ops steps below run.

## What works (unchanged)

- `draft_pitch` → `outreach_drafts` → `/admin/outreach` (Run The Trap TV, `rttsubmit@gmail.com`)
- Lane `pitch_angle` from `artist_config.lanes`
- `list_targets` / `list_drafts` via CCA

## Finding → status

| Priority | Finding at test time | Code on `main` | Production until redeploy |
|----------|----------------------|----------------|---------------------------|
| P0 | `get_pitch_log` unknown action | `e78bb02` + wired in CCA | **Redeploy `control-center-api`** |
| P0 | IG `spotify` / `dailyrapfacts.com` | `contact-extract.ts` + `78e96c3` | **Run backfill SQL** + redeploy + re-enrich |
| P1 | `Lane:` in draft body; no stream link | `f791b36` `buildPitchBody` | Redeploy CCA; **recreate** draft `02a91c55-…` |
| P1 | Unpitchable curators in top results | `0abc779` lane-fit gate + discovery skips (disclaim / casual / micro) | Redeploy **`playlist-research`** |
| P1 | Rap rows stamped `deep_house_groove` | `0abc779` + `20260530_clear_mistagged_lanes.sql` | Run clear-lanes SQL |
| P2 | `follower_count` = 0 | `f791b36` `parseMetricCount` | Redeploy `playlist-research`; re-scrape via research |
| P2 | `Playlist {id}…` names | `f791b36` markdown title parser | Same |
| P6 | Enrich v2 / contact yield | `d385317` + `66826a2` columns | Enrich v2 migration + CCA redeploy + paginated enrich |

## Ops checklist (ordered)

1. **Lovable SQL Editor**
   - `supabase/migrations/20260530_enrich_v2_columns.sql` (if columns missing)
   - `supabase/migrations/20260530_fix_spotify_ig_backfill.sql`
   - `supabase/migrations/20260530_clear_mistagged_lanes.sql`

2. **Lovable one-shot**
   ```text
   Redeploy edge functions control-center-api and playlist-research. Do not modify any code, schema, migration, or other file.
   ```

3. **Lovable Publish** — admin UI (Contact column, Draft/Queue DM gates) if not auto-deployed from GitHub.

4. **Paginated enrich**
   ```bash
   curl -sS -X POST "$SUPABASE/functions/v1/control-center-api" -H "content-type: application/json" \
     -d '{"action":"enrich_curator_contacts","lane":"deep_house_groove","limit":8,"offset":0}'
   ```
   Repeat with `next_offset` until `done: true`.

5. **Full research** (lane-fit + discovery skips)
   ```bash
   curl -sS --max-time 70 -X POST "$SUPABASE/functions/v1/control-center-api" -H "content-type: application/json" \
     -d '{"action":"run_playlist_research","track_name":"Designed For Me (Control)","lane":"deep_house_groove","references":["Kaytranada","Channel Tres","SG Lewis"],"user_vibe":"deep house groove"}'
   ```

6. **Verify**
   ```bash
   export SUPABASE="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"
   curl -sS -X POST "$SUPABASE" -H "content-type: application/json" -d '{"action":"get_pitch_log","limit":5}'
   ```

## Operator decision

Draft `02a91c55-68b1-4842-87cf-939ef8658d81` (Run The Trap TV) — reject, edit, or approve at `/admin/outreach`. Prefer **reject + Draft again** after CCA redeploy so the body has `Stream: https://rnd.fm/runway-music-hlpad6` and no `Lane:` line.

## Commits (reference)

| Commit | Summary |
|--------|---------|
| `f791b36` | Draft body, IG `.` deny, scrape metrics/titles, rank penalties |
| `0abc779` | Lane-fit gate, discovery quality filters, `discovery_skips` |
| `d385317` | Enrich v2: playlist description, web search, empty profiles |
| `78e96c3` | IG chrome hardening, `sanitizeCuratorIgHandle` |

See [MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md](./MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md).
