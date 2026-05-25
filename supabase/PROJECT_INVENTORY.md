# Supabase project inventory (Lovable → repo sync)

**Last reconciled:** 2026-05-24. **Project ref:** `vsemrziqxrrfcquxfnwd`.  
**Handoff index (audit + stats pipeline):** `Fan Fuel Hub/supabase-handoff.md` (slim). Full code dump: `supabase-handoff-full-export-2026-05-24.md`.

Use this file to stop guessing between GitHub, Cursor, and Lovable. When Lovable changes functions or secrets, update this doc in the same PR as `config.toml`.

---

## 1. Edge functions (31 in repo; GitHub → Lovable sync)

| Function | Auth | Notes |
|----------|------|--------|
| `control-center-api` | `FANFUEL_HUB_KEY` | Bridge for Control Center |
| `execute-pitch` | `FANFUEL_HUB_KEY` | |
| `fan-intelligence` | In-code auth | `verify_jwt = false` in Lovable (validates in function) |
| `fetch-public-spotify-data` | none | `verify_jwt` off |
| `get-og-metadata` | none | SmartLink / worker |
| `healthcheck` | none | |
| `instagram-messaging` | `INSTAGRAM_MESSAGING_API_TOKEN` | Graph API |
| `meta-conversions` | none | CAPI; pixel `788829401662107` in code |
| `pitch-status` | `FANFUEL_HUB_KEY` | |
| `playlist-batch` | `FANFUEL_HUB_KEY` | |
| `playlist-research` | `FANFUEL_HUB_KEY` | Spotify live search; Lovable may also wire SoundCloud secrets |
| `project-stats` | none | Table row counts only — **does not refresh platform stats** |
| `refresh-platform-stats` | `STATS_CRON_SECRET` / hub key / service role | Chains scrape-chartmetric → fan-intelligence; **use for daily cron** |
| `scrape-chartmetric` | In-code auth + Firecrawl | `verify_jwt = false` in Lovable (validates in function) |
| `send-campaign-email` | `FANFUEL_HUB_KEY` | Resend; RUNWAY / admin campaigns |
| `send-pitch-email` | `FANFUEL_HUB_KEY` | Resend |
| `shopify-order-webhook` | HMAC `SHOPIFY_WEBHOOK_SECRET` | |
| `soundcloud-auth` | none | OAuth start |
| `soundcloud-callback` | none | Needs **`FRONTEND_URL`** secret |
| `soundcloud-stats` | none | Tokens in `platform_connections` |
| `spotify-auth` / `spotify-callback` / `spotify-stats` | none / OAuth | |
| `telegram-send-campaign` | `FANFUEL_HUB_KEY` | Inner Circle broadcast |
| `telegram-webhook` | `INNER_CIRCLE_WEBHOOK_SECRET` | **New bot only** — not FendiAIbot |
| `telegram-signup-redirect` | Public GET | Smart link → `t.me` token |
| `unsubscribe` | token query | Email list-unsubscribe |
| `update-pitch-status` | `FANFUEL_HUB_KEY` | |
| `youtube-auth` / `youtube-callback` / `youtube-stats` | OAuth + API key | `Fendi_Youtube_API_Key_1` |

**Stale config:** `[functions.ogmetadata]` in Lovable `config.toml` if present — remove (no function dir).

---

## 2. Meta: CAPI vs Marketing API

- **CAPI:** `META_CONVERSIONS_API_TOKEN`, function `meta-conversions` — events e.g. PageView, EmailSignup, AccordionOpen; dedup with `event_id`.
- **Marketing API (ads insights, campaign edit):** **Not configured** in this project — no `ads_read` / management token or functions.

---

## 3. SoundCloud

- Secrets: `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET`.
- Tokens: `platform_connections` (`platform = 'soundcloud'`) per `user_id`.
- **Action:** Set Supabase secret **`FRONTEND_URL`** (e.g. production Lovable app URL) for `soundcloud-callback` redirect after OAuth.

Legacy unused secret name (per Lovable): `Fendi_SoundCloud_API`.

---

## 4. Database (Supabase Postgres — not Prisma `artistgrowthhub` local schema)

Lovable lists: `playlist_targets`, `pitch_log`, `follower_snapshots`, `artist_config`, `platform_connections`, `fan_profiles`, `fan_events`, `fan_data`, `smart_links`, `smart_link_leads`, `link_analytics`, `analytics_snapshots`, `momentum_events`, `marketing_actions`, `profiles`, `system_logs`.

**Not in this DB:** `bot_settings`, `tasks`, `sessions` (those belong to **Fendi Control Center**’s Supabase, not this Hub project).

---

## 5. Scheduled jobs

- **Recommended:** Edge Function schedule on `refresh-platform-stats` (daily `0 6 * * *`, header `x-stats-cron-secret`).
- **Optional:** `lovable-migrations/20260525120001_stats_refresh_cron.sql` via Lovable migration tool.
- `pg_cron` + `pg_net` extensions enabled; no other cron jobs in repo before stats bundle.

---

## 6. Repo vs Lovable

- **`supabase/functions/*`**, **`migrations/*`**, and **`config.toml`** are synced from the Lovable handoff (`supabase-handoff.md`).
- **`supabase/types/database.ts`** — generated DB types (from Lovable `src/integrations/supabase/types.ts`).
- **Supplemental SQL** (not in Lovable migration chain): `migrations/001_playlist_catalog_migration.sql`, `migrations/003_pitch_log_cooldown_nullable.sql` — apply only if not already applied in production.
- **Fendi Control Center** still hosts its own UI/bot; it calls **this** project via `FANFUEL_HUB_URL` + hub-key functions.

---

## 7. Applied in Lovable (reconciled with this repo)

1. **`verify_jwt = false`** for `execute-pitch`, `pitch-status`, `playlist-batch`, `update-pitch-status` (plus existing FanFuel entries).  
2. **`FRONTEND_URL`** = `https://fan-growth-pilot.lovable.app` (SoundCloud OAuth redirect).  
3. **Stale `ogmetadata`** config entry removed.  
4. **`fan-intelligence`** and **`scrape-chartmetric`**: `verify_jwt = false` in production — auth handled inside the function; GitHub matches.

**Superset rule:** Lovable may deploy more functions than this repo lists; any function present in GitHub `config.toml` should match Lovable for `verify_jwt`.

---

## 8. Platform stats (audit 2026-05-24)

**Writers:** `scrape-chartmetric`, `youtube-stats`, `soundcloud-stats`, `fetch-public-spotify-data` → `fan_data`.  
**Readers:** `control-center-api` (`get_platform_metrics`), `fan-intelligence` (snapshots/momentum), Lovable UI.  
**Not a writer:** `spotify-stats` (ephemeral `/me` JSON), `project-stats` (table counts).

**Fixes shipped in repo:** CC API scoped by `ARTIST_USER_ID` or first profile; full `fan_identifier` list; scrape upsert errors surfaced; fetch-public-spotify-data no stale defaults; YouTube Chartmetric fallback in fan-intelligence.

**Optional env:** `ARTIST_USER_ID` — UUID of the artist profile when multiple `profiles` rows exist.

**Lovable migration:** `lovable-migrations/20260525120000_fan_data_unique.sql` (dedupe + unique index).

**New secrets:** `STATS_CRON_SECRET`, optional `ARTIST_USER_ID`.
