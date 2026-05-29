# Playlist discovery — current status (2026-05-29)

Use this doc before opening a new handoff. **Do not re-debug Spotify OAuth for playlist search** — it does not unlock `/v1/search?type=playlist` on standard Spotify apps (403 / extended-access gate since Nov 2024).

## What works today

| Step | Mechanism | Status |
|------|-----------|--------|
| Lane scoring + ranking | `playlist-lanes.ts` + `playlist-research` | Working |
| Draft pitch copy | `draft_pitch` → `outreach_drafts` | Working |
| Approve + send email | `approve_draft` + `send-pitch-email` (Resend) | Working when `curator_email` is set |
| Web discovery | Firecrawl → `open.spotify.com/search/.../playlists` | Experimental — slow (30–60s), needs `FIRECRAWL_API_KEY` |
| Contact enrich v2 | Linktree + IG HTML/mailto + Hunter (opt-in) | 8 rows/call; see `20260530_enrich_v2_columns.sql` |
| Spotify OAuth | `connect_spotify_*` | **Optional** — for `spotify-stats` only, not playlist discovery |

## Fastest path to a real pitch (same day)

See **[PLAYLIST_PITCH_FAST_PATH.md](./PLAYLIST_PITCH_FAST_PATH.md)**.

Summary: seed or research → **paste email** (`patch_target`) → Draft → Approve on `/admin/outreach` → Send.

## Deploy checklist

After any edge change:

1. Lovable chat: `Redeploy edge functions control-center-api and playlist-research. Do not modify any code.`
2. Secrets: `FIRECRAWL_API_KEY`, `FANFUEL_HUB_KEY`, Resend keys for send.
3. SQL (once): `supabase/migrations/20260525_artist_config_lanes.sql` in Lovable SQL Editor.

## Smoke script

```bash
export CCA="https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api"
./scripts/smoke-playlist-pipeline.sh
```

## Commit map (avoid re-litigating)

| Commit | What it did |
|--------|-------------|
| (latest) | IG denylist + `bio_links`-only scrape — fixes `curator_instagram = spotify` |
| `b5fbd35` | Fixed rap regex; reference-first search terms (API path) |
| `05cfe33` | User OAuth for playlist-research (API still 403 for search) |
| `217eba2` | `connect_spotify` admin flow |
| `af07966` | Firecrawl web discovery + enrich rewrite |
