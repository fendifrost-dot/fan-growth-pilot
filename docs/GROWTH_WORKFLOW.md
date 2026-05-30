# Organic growth workflow (no ads)

## Best strategy for existing Spotify placements

Playlists that **already feature your music** are warmer than cold discovery:

1. **Import Spotify for Artists CSV** (`import_spotify_for_artists_csv`) — export Playlists report from SFA, upload at `/admin/playlists` (re-upload weekly)
2. **Find playlists with my music** (`discover_spotify_placements`) — optional Firecrawl verify for Spotify URLs
3. **Enrich contacts** — IG handles, emails (resolves `spotify:sfa:*` rows by playlist name when possible)
4. **IG roster** — `/admin/ig-roster` — sync handles, mark **I follow** + **Follows me** (mutual required)
5. **Queue 10 IG DMs** (`queue_ig_outreach_batch`) — operator brief + clean paste message, **mutual-only**, **10/day UTC cap**
6. **IG queue** — copy **message only**, use brief for identity check, **Mark sent**
7. Optional: **Draft email** on placement rows — same identity block in subject/body via `draft_pitch`

### SFA CSV format

Columns: `title`, `author`, `listeners`, `streams`, `date_added` (standard Spotify for Artists export).

CLI (after deploy):

```bash
FANFUEL_HUB_URL=... FANFUEL_HUB_KEY=... ./scripts/import-sfa-placements.sh ~/Downloads/Fendi\ Frost-playlists-1year.csv 1year
```

Mix (recommended):

| Channel | When |
|---------|------|
| IG thank + new track | Curator is **mutual** on roster; brief confirms @handle + playlist |
| Email cross-pitch | Curator has email; placement drafts include REF + mutual line |
| Follow (manual) | After DM — do not automate follows |

## IG identity layers

| Layer | Where | Purpose |
|-------|--------|---------|
| Roster | `instagram_curator_roster` | Stable @handle + follow flags as followers fluctuate |
| Operator brief | `social_engagement_queue.operator_brief` | REF, mutual status, playlist, spun track, pitch track — **do not paste into IG** |
| DM body | `social_engagement_queue.draft_text` | Short message only — **paste this** |
| DM ref | `dm_ref` e.g. `FF-IG-20260531-003` | Tie queue row to email draft metadata |

## Admin paths

- **Send center:** `/admin/send` — all channels
- **Placements:** `/admin/playlists` — Find playlists with my music
- **IG roster:** `/admin/ig-roster` — mutual verification
- **IG queue:** `/admin/ig-queue` — brief vs message split

## API (control-center-api)

- `import_spotify_for_artists_csv`, `discover_spotify_placements`, `queue_ig_outreach_batch` (`require_mutual`, `auto_match_track`)
- `list_ig_roster`, `patch_ig_roster`, `import_ig_roster`, `sync_ig_roster_from_targets`
- `list_social_queue`, `mark_social_queue_sent`

## Deploy

1. Run migration `20260531_ig_roster_and_dm_brief.sql` in Lovable SQL Editor
2. Redeploy **control-center-api** after pulling
