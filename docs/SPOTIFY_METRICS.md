# Spotify metrics — how they update (root cause + fix)

## Symptom (reported)

> "Spotify numbers not consistently updating."

The dashboard **Refresh Stats** button never updated Spotify monthly listeners
or followers, so the numbers looked stale/frozen.

## Root cause

The artist dashboard reads Spotify/Instagram/Facebook/YouTube/SoundCloud
metrics from the `fan_data` table (rows keyed by `fan_identifier`, e.g.
`spotify_artist_stats`). See `src/hooks/useArtistStats.ts`.

The **refresh** path was broken. The old `useArtistStats` refresh mutation
called the `fetch-public-spotify-data` edge function **with no request body**:

```ts
supabase.functions.invoke("fetch-public-spotify-data") // no body
```

But `supabase/functions/fetch-public-spotify-data/index.ts` **requires** the
metric values to be passed in the body (`spotify_followers`,
`monthly_listeners`, `ig_followers`, `fb_followers`) — it's a "manual push"
function that writes whatever the caller already fetched from Chartmetric. With
an empty body it returns **HTTP 400 "Missing stats in request body"** every
time, so the refresh always failed and the Spotify numbers never changed.

The *real* source of artist metrics is `scrape-chartmetric`
(`supabase/functions/scrape-chartmetric/index.ts`): it scrapes Chartmetric via
Firecrawl and upserts all platform rows into `fan_data`. Crucially, it accepts a
**signed-in user's JWT** and writes rows for that user (see the `else` branch in
its auth block), so it can be driven straight from the dashboard.

Two secondary issues:

- `useSpotifyStats.ts` (a separate, unused hook) called `spotify-stats`, which
  returns the *connected user's* `/me` data and fabricates play counts with
  `Math.floor(Math.random() * 100000)`. It was dead code and has been removed to
  prevent anyone wiring fake numbers into the UI.
- There is **no scheduled job** invoking `refresh-platform-stats` /
  `scrape-chartmetric`, so even the correct path only ran when a client happened
  to trigger it. See "Recommended: schedule automatic refresh" below.

## Fix (this PR — frontend only, no edge redeploy)

`src/hooks/useArtistStats.ts` now refreshes via `scrape-chartmetric`:

```ts
const results = await Promise.allSettled([
  supabase.functions.invoke("scrape-chartmetric", { body: {} }), // Spotify/IG/FB
  supabase.functions.invoke("youtube-stats", { body: {} }),      // OAuth
  supabase.functions.invoke("soundcloud-stats", { body: {} }),   // OAuth
]);
```

- A hard failure of the primary (Chartmetric) source is surfaced to the UI so it
  can toast the error; YouTube/SoundCloud depend on optional OAuth connections,
  so their failures stay non-fatal.
- The Spotify section (`/hub/spotify`) shows a **Last updated** indicator sourced
  from `fan_data.updated_at`, so staleness is visible at a glance.

No edge function code changed, so **no edge redeploy is required** for the fix.

## Recommended: schedule automatic refresh (operator follow-up)

To make the numbers refresh *on their own* (not just on button press), schedule
`refresh-platform-stats` (it chains `scrape-chartmetric` → `fan-intelligence`)
on a cron. There is currently **no** such schedule. Add one via the Lovable SQL
Editor (pg_cron is already enabled). Example — every 6 hours:

```sql
select cron.schedule(
  'refresh-platform-stats-6h',
  '0 */6 * * *',
  $$
  select net.http_post(
    url    := 'https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/refresh-platform-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-stats-cron-secret', '<STATS_CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Requires `STATS_CRON_SECRET` (and `FIRECRAWL_API_KEY`, `ARTIST_USER_ID`) to be
configured for the edge functions. This is an operator action in Lovable — it is
**not** applied by this PR.
