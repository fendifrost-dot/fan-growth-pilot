# Organic growth workflow (no ads)

## Best strategy for existing Spotify placements

Playlists that **already feature your music** are warmer than cold discovery:

1. **Find playlists with my music** (`discover_spotify_placements`) — Firecrawl search + playlist verify
2. **Enrich contacts** — IG handles, emails
3. **Queue 10 IG DMs** (`queue_ig_outreach_batch`) — unique thank-you + cross-pitch per curator, **10/day UTC cap**
4. **IG queue** — copy, send manually, **Mark sent**
5. Optional: **Set email** → **Draft** → **Approve & send** for email-first curators

Mix (recommended):

| Channel | When |
|---------|------|
| IG thank + new track | Curator has IG, you want relationship + low friction |
| Email cross-pitch | Curator has email, formal submission |
| Follow (manual) | After DM — do not automate follows |

## Admin paths

- **Send center:** `/admin/send` — all channels
- **Placements:** `/admin/playlists` — Find playlists with my music
- **IG:** `/admin/ig-queue` — daily queue with cap display

## Deploy

Redeploy **control-center-api** after pulling. Actions: `discover_spotify_placements`, `queue_ig_outreach_batch`, `mark_social_queue_sent`.
