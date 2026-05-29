# FanFuel Hub (Supabase backend)

This directory is the **only** home for FanFuel Hub Edge Functions and their SQL migrations. It is part of [Artist Growth Hub](https://github.com/fendifrost-dot/artistgrowthhub) and must not be mixed with Credit Compass (`fendi-fight-plan`) or Fendi Control Center.

## Where Supabase runs

The live Supabase project is managed **in Lovable**.

| Edited in GitHub (syncs to Lovable) | Edited in Lovable only |
|-------------------------------------|-------------------------|
| `supabase/functions/*` | Schema, RLS, triggers, data |
| `src/`, `config.toml`, types | **Migrations** (run migration tool) |

`supabase/migrations/*.sql` is **documentation/version control** — copy into Lovable's migration tool to apply. See [`lovable-migrations/`](./lovable-migrations/).

**Scheduled internal stats:** `refresh-platform-stats` → [`DEPLOY.md`](./DEPLOY.md).

**Full function list, Meta CAPI vs Marketing API, SoundCloud OAuth, and DB tables:** see [`PROJECT_INVENTORY.md`](./PROJECT_INVENTORY.md).

## Functions (31 edge functions)

| Function | Purpose |
|----------|---------|
| `playlist-research` | POST `{ track_name, user_vibe }` → ranked `playlists[]` (catalog + optional Spotify live search). Auth: `FANFUEL_HUB_KEY`. |
| `playlist-batch` | POST `{ playlist_ids }` → `playlist_targets` rows in order. |
| `execute-pitch` | Send or route a pitch for a track × playlist. |
| `update-pitch-status` | Mark responded / rejected on `pitch_log`. |
| `pitch-status` | Recent `pitch_log` entries (optional `track_name` filter). |
| `send-campaign-email` / `unsubscribe` | Email campaigns (RUNWAY, admin). |
| `telegram-webhook` / `telegram-signup-redirect` / `telegram-send-campaign` | Inner Circle Telegram. |

**Generated types:** `supabase/types/database.ts` (synced from Lovable).

## Env (set in Supabase project secrets)

- `FANFUEL_HUB_KEY` — shared secret; Control Center sends it as `x-api-key` / `Authorization` / `apikey`.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — standard service role (functions use these).
- `FIRECRAWL_API_KEY` — required for Spotify web discovery in `playlist-research` and curator enrichment.
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — OAuth refresh for `spotify-stats` (not used for playlist discovery).
- `FRONTEND_URL` — required for `soundcloud-callback` post-OAuth redirect (see inventory).
- `META_CONVERSIONS_API_TOKEN` — CAPI only (`meta-conversions`); not Marketing API.

## Migrations

Apply in order on the **FanFuel Hub** Supabase project (`playlist_targets`, `pitch_log`, `follower_snapshots`, etc.). Prerequisites: existing `playlist_targets` table as described in `001_playlist_catalog_migration.sql`.
