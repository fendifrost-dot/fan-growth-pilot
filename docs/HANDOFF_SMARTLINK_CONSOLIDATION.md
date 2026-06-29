# Handoff — Smart Link Multi-Platform Consolidation

**For:** a Claude Code / Cursor session with deploy + GitHub credentials, plus access to
the Lovable SQL editor.
**Date:** 2026-06-29
**Companion doc:** `docs/SMARTLINK_CONSOLIDATION_ASSESSMENT.md` (full reasoning).

---

## 0. Naming — read this first (it's the whole source of confusion)

**"FanFuel Hub" is the product name of the ONE real app.** That app is the main **Vite**
project:
- GitHub `fendifrost-dot/fan-growth-pilot` · local `~/artistgrowthhub-repo`
- Lovable project *displayed* as "FanFuel Hub", URL slug `fan-growth-pilot.lovable.app`
- Serves the live links at `links.fendifrost.com/{slug}`

There is a **separate stray Next.js repo** — `fendifrost-dot/artistgrowthhub` (local
`~/artistgrowthhub`) — that *also* calls itself "FanFuel Hub backend" in its README. It
was created by a prior AI session, serves **no live traffic**, and is the thing to
retire. Do **not** confuse it with the real app.

Both repos point at the **same Supabase** `vsemrziqxrrfcquxfnwd`, so data is shared, not
misrouted.

---

## 1. What we uncovered

1. **The live links are served by the Vite app, not the Next.js repo.**
   `links.fendifrost.com/{slug}` → Cloudflare Worker (`public/cloudflare-worker.js`) →
   origin `fan-growth-pilot.lovable.app/{slug}` → OG tags injected via the
   `get-og-metadata` edge function.

2. **The multi-platform chooser already existed in the Vite app.**
   `src/pages/SmartLinkPage.tsx` ("Multi-DSP buttons (Phase 2)", commit `80c33d6`, on
   `main`) already renders a Spotify-first button stack from a link's `metadata`, with
   per-platform `CTAClick` tracking. The Next.js repo re-built the same feature
   needlessly.

3. **Data-shape mismatch is why the new links look broken.**
   - Vite app (live) reads **flat keys**: `metadata.spotify_url`, `apple_music_url`,
     `soundcloud_url`, `youtube_url`, `tidal_url`, `even_url`.
   - The Next.js repo wrote an **array**: `metadata.platforms = [{key,label,url}, ...]`.
   - The `nutrition` and `heartchakra` rows were created with `metadata.platforms[]`,
     which the live app does **not** read → their buttons don't render (they fall back to
     the single `destination_url`).

4. **Already done in this session:**
   - Added SoundCloud to the live app's DSP stack — commit **`e94d350`** on
     `fan-growth-pilot` `main` (pushed). Render order is now
     **Spotify → Apple → SoundCloud → YouTube → Tidal → EVEN** (each shows only if its
     `*_url` is set).
   - The stray Next.js repo got an unrelated chooser commit (`255ecca`) earlier — it is
     **moot**; do not publish/deploy that repo.

---

## 2. What to do — in order

### Step A — Publish the Vite app (makes the SoundCloud button live)
Commit `e94d350` is already on `fan-growth-pilot` `main`. In the Lovable **FanFuel Hub**
project: **Publish** to ship the frontend. (Edge functions are unaffected here, so no
edge redeploy needed for this change.)

### Step B — Run the data fix in the Lovable SQL editor
Open Lovable → **SQL editor** for the FanFuel Hub project and run these **in order**.

**B1 — Inspect first (check the platform `key` values before mutating):**
```sql
select slug, destination_url, jsonb_pretty(metadata) as metadata
from smart_links
where slug in ('nutrition','heartchakra');
```
Look at the `key` of each entry in `metadata.platforms`. The transform below maps the
common variants (`spotify`, `appleMusic`/`apple_music`/`apple`, `soundcloud`,
`youtube`/`youtubeMusic`, `tidal`, `even`). If you see a different key, adjust the
`filter (where k in (...))` lists accordingly.

**B2 — Convert `metadata.platforms[]` → flat `*_url` keys (non-destructive, idempotent):**
```sql
with p as (
  select sl.id,
         lower(trim(elem->>'key')) as k,
         elem->>'url'              as url
  from smart_links sl
  cross join lateral jsonb_array_elements(sl.metadata->'platforms') as elem
  where sl.slug in ('nutrition','heartchakra')
    and jsonb_typeof(sl.metadata->'platforms') = 'array'
),
flat as (
  select id,
    max(url) filter (where k = 'spotify')                            as spotify_url,
    max(url) filter (where k in ('applemusic','apple_music','apple')) as apple_music_url,
    max(url) filter (where k = 'soundcloud')                         as soundcloud_url,
    max(url) filter (where k in ('youtube','youtubemusic'))          as youtube_url,
    max(url) filter (where k = 'tidal')                             as tidal_url,
    max(url) filter (where k in ('even','evenbiz'))                  as even_url
  from p group by id
)
update smart_links sl
set metadata = sl.metadata || jsonb_strip_nulls(jsonb_build_object(
    'spotify_url',     f.spotify_url,
    'apple_music_url', f.apple_music_url,
    'soundcloud_url',  f.soundcloud_url,
    'youtube_url',     f.youtube_url,
    'tidal_url',       f.tidal_url,
    'even_url',        f.even_url
  ))
from flat f
where sl.id = f.id;
```

**B3 — Verify the flat keys now exist:**
```sql
select slug,
       metadata->>'spotify_url'     as spotify,
       metadata->>'apple_music_url' as apple,
       metadata->>'soundcloud_url'  as soundcloud,
       metadata->>'even_url'        as even
from smart_links
where slug in ('nutrition','heartchakra');
```

**Pending data:** `heartchakra` has no Spotify URL yet (Odesli hadn't indexed it). When
Fendi provides it, add it (Spotify renders first):
```sql
update smart_links
set metadata = metadata || jsonb_build_object('spotify_url','<HEART_CHAKRA_SPOTIFY_URL>')
where slug = 'heartchakra';
```

### Step C — Verify live
- Visit `links.fendifrost.com/nutrition` → Spotify + Apple buttons render.
- Visit `links.fendifrost.com/heartchakra` → Apple + SoundCloud + EVEN render (Spotify
  once added). Each button navigates to the right URL and fires a platform-tagged
  `CTAClick`. With no flat keys present, the page safely falls back to the single
  `destination_url`.

### Step D — Retire the stray Next.js repo
Once C is green:
- Archive `fendifrost-dot/artistgrowthhub` on GitHub:
  `gh repo archive fendifrost-dot/artistgrowthhub --yes`
- Rename the local clone so it can't be confused again:
  `mv ~/artistgrowthhub ~/artistgrowthhub-ARCHIVED-nextjs-duplicate`
- If that repo has any standalone Lovable/host deployment, archive it too. **Leave the
  FanFuel Hub Lovable project (= the Vite app) untouched.**

---

## 3. Redirect contingency (likely NOT needed)

Fendi confirmed **all** public links use the `links.fendifrost.com/{slug}` form (served
by the Vite app), **not** the stray repo's `/l/{slug}` path. So no redirect is required
and Step D is safe.

**Only if** some old asset/QR is later found pointing at `/l/{slug}`: add a redirect at
the Cloudflare Worker (`public/cloudflare-worker.js`) that rewrites
`links.fendifrost.com/l/{slug}` → `links.fendifrost.com/{slug}` (301), since the Worker
already fronts that domain. Do this **before** archiving anything the old path depended
on. No such asset is known to exist today.

---

## 4. Guardrails

- Do **not** "merge" the two git repos — different frameworks (Vite vs Next.js), no
  shared history; it would break both builds. The plan is *retire the duplicate*, not
  merge.
- Do **not** publish or redeploy the stray Next.js repo or its `smart-link-redirect`
  edge function — that invests in the app we're removing.
- The B2 SQL is non-destructive (it only adds flat keys; `metadata.platforms` stays).
  Safe to re-run.
