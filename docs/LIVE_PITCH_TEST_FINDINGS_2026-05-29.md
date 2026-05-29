# Live pitch-loop test findings — 2026-05-29

Captured from production admin UI + CCA. Use as deploy checklist after code on `main`.

## What works

- `draft_pitch` → `outreach_drafts` → `/admin/outreach` (tested: Run The Trap TV, `rttsubmit@gmail.com`)
- Lane `pitch_angle` from `artist_config.lanes` fires correctly
- `list_targets` / `list_drafts` via CCA (no-auth POST)

## Ops blockers (not code)

| Issue | Fix |
|-------|-----|
| `get_pitch_log` → Unknown action | Redeploy `control-center-api` (in repo since e78bb02) |
| IG `spotify` / `dailyrapfacts.com` rows | Run `supabase/migrations/20260530_fix_spotify_ig_backfill.sql`, redeploy CCA, re-enrich |

Lovable chat one-shot:

```text
Redeploy edge functions control-center-api and playlist-research. Do not modify any code, schema, migration, or other file.
```

## Code fixes on main (post-findings)

| Fix | File |
|-----|------|
| Draft body: no `Lane:` leak; inline stream link | `playlist-agent-run.ts` `buildPitchBody` |
| `why_it_fits` stays in draft `metadata` only | `buildPitchBody` + `playlist-lanes.ts` |
| IG handles with `.` rejected | `contact-extract.ts` |
| Saves/followers regex; playlist titles from markdown links | `spotify-scrape.ts` |
| Rank penalty: micro-playlists, placeholder names | `playlist-research/index.ts` |

## Pending operator decision

Draft `02a91c55-68b1-4842-87cf-939ef8658d81` (Run The Trap TV) — reject, edit, or approve & send at `/admin/outreach`. **Recreate draft after redeploy** to get updated body (stream link, no Lane line).

## Manual candidates §0 (discovery quality)

Off Label / Mixchelle / Khwezi from playbook §0 are often unpitchable (brand disclaimer, micro saves, casual user). Curator-quality penalties help; disclaimer detection is a follow-up enrich task.

## Verify after deploy

```bash
export SUPABASE="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"
curl -sS -X POST "$SUPABASE" -H "content-type: application/json" \
  -d '{"action":"get_pitch_log","limit":5}'
```

See [MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md](./MANUAL_PITCH_PLAYBOOK_DEEP_HOUSE.md).
