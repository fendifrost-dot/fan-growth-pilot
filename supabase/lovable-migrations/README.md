# Lovable migration tool — paste these SQL files

GitHub `supabase/migrations/*.sql` is **version control only**. Schema changes must be applied in **Lovable → Database → Migrations** (or Supabase SQL editor).

## Apply in order

| File | Purpose |
|------|---------|
| `20260525120000_fan_data_unique.sql` | Dedupe `fan_data`, add unique index |
| `20260525120001_stats_refresh_cron.sql` | Optional `pg_cron` job (see below) |

## Preferred: Supabase Edge Function schedule (no SQL secrets)

After edge functions sync from GitHub:

1. Supabase Dashboard → **Edge Functions** → `refresh-platform-stats` → **Schedules**
2. Cron: `0 6 * * *` (daily 06:00 UTC)
3. HTTP headers: `x-stats-cron-secret: <same as STATS_CRON_SECRET env>`
4. Method: POST, body: `{}`

Set secrets in Lovable/Supabase:

- `STATS_CRON_SECRET` — `openssl rand -hex 32`
- `FIRECRAWL_API_KEY` — required for scrape step
- `ARTIST_USER_ID` — optional; pin Fendi profile UUID if multiple `profiles` rows

## Alternative: pg_cron SQL migration

Use `20260525120001_stats_refresh_cron.sql` only if Edge Function Schedules are unavailable. You must replace `YOUR_STATS_CRON_SECRET` in Lovable before running.
