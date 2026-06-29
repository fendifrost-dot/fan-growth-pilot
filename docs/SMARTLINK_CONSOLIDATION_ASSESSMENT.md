# Smart Link Consolidation — Assessment

_Date: 2026-06-29 · Author: Claude Code session_

## Naming note (read first)

**"FanFuel Hub" is the product name of your ONE real app** — the main Vite app. Its
Lovable project is *displayed* as "FanFuel Hub" but its repo/URL slug is
`fan-growth-pilot` (`fan-growth-pilot.lovable.app`), and it serves
`links.fendifrost.com`. Same project, just a different name.

The confusing part: a **separate, stray Next.js GitHub repo** (`fendifrost-dot/artistgrowthhub`,
local `~/artistgrowthhub`) *also* calls itself "FanFuel Hub backend" in its README,
even though it is a different codebase created by a prior AI session. Throughout this
doc, **"the stray Next.js repo"** = that duplicate, and **"the main app" / "FanFuel
Hub"** = the real, live app to keep.

## TL;DR

You should have **one** smart-link app, and you already do: the main Vite app
(FanFuel Hub / `fan-growth-pilot`), live at `links.fendifrost.com`. The **stray
Next.js repo** is a redundant rebuild of a feature the main app **already shipped** —
and it uses an *incompatible data shape*, so the "multi-platform" rows it created
(`nutrition`, `heartchakra`) **don't render their platform buttons on the live site
today.**

**Recommended path:** don't merge the repos. Fix the two data rows to the shape the
live app reads, optionally add SoundCloud as a supported button, then **retire the
stray Next.js repo**. This is a data fix, not a code migration.

---

## 1. The two repos

| | **Main app — FanFuel Hub** (live, keep) | **Stray Next.js repo** (retire) |
|---|---|---|
| Local path | `~/artistgrowthhub-repo` | `~/artistgrowthhub` |
| GitHub | `fendifrost-dot/fan-growth-pilot` | `fendifrost-dot/artistgrowthhub` |
| Lovable | project displayed as "FanFuel Hub" | not the live origin |
| Framework | Vite + React + shadcn | Next.js 14 |
| Maturity | 443 commits — the daily driver | 31 commits — created by a prior AI session |
| Supabase | `vsemrziqxrrfcquxfnwd` | **same** `vsemrziqxrrfcquxfnwd` |
| Role | Admin, campaigns, playlists, **smart links** | Smart links only (duplicate) |

No shared git history and different frameworks, so a literal `git merge` is not
viable — it would break both deploys. The right frame is "retire the duplicate," not
"merge the repos."

## 2. How the live links are actually served

`links.fendifrost.com/{slug}` →
1. **Cloudflare Worker** (`public/cloudflare-worker.js`) intercepts the request.
2. Worker fetches the SPA HTML from origin **`fan-growth-pilot.lovable.app/{slug}`** (the main app).
3. Worker calls Supabase edge fn `get-og-metadata` for that slug, injects OG/Twitter tags, caches 1h.

**The main Vite app is the origin.** The stray Next.js repo is not in this path and
serves no live traffic. Its `/l/{slug}` route is dead weight.

## 3. The core finding: the feature already exists in the main app

`src/pages/SmartLinkPage.tsx` (lines ~339–387, "Multi-DSP buttons (Phase 2)",
shipped as `80c33d6`, on `main`) **already** renders a Spotify-first stack of
platform buttons read from a smart link's `metadata`, with per-platform `CTAClick`
tracking. Supported: **Spotify, Apple Music, YouTube, Tidal, EVEN.**

The stray Next.js repo reimplemented something the main app already had. Its one
genuinely new idea was **Odesli/song.link auto-resolve** ("give one URL, get the
others") — worth keeping as an *idea* in the main app's admin, not as a separate app.

## 4. The data-shape mismatch (this is why links look broken)

The two implementations read **different metadata shapes**:

- **Main app (live) reads flat keys:** `metadata.spotify_url`, `metadata.apple_music_url`, `metadata.youtube_url`, `metadata.tidal_url`, `metadata.even_url`.
- **Stray Next.js repo wrote an array:** `metadata.platforms = [{ key, label, url }, ...]`.

The `nutrition` and `heartchakra` rows were created with **`metadata.platforms[]`**
(the stray repo's shape). The live main app does **not** read that key, so:

- `heartchakra` → no buttons render → falls back to single `destination_url` = `even.biz/r/heart-chakra` (straight to EVEN, no chooser).
- `nutrition` → no buttons render → falls back to single `destination_url` = the Spotify album (no Apple button).

> ⚠️ Verify in the Supabase SQL editor before acting — inferred from the prior
> handoff, not a live DB read:
> `select slug, destination_url, metadata from smart_links where slug in ('nutrition','heartchakra');`

**Net:** the multi-platform chooser is effectively live **nowhere** — the stray repo
has matching code but serves no traffic; the main app serves the traffic but can't
read these rows' shape.

## 5. What this session already did (and what to NOT do)

- Landed commit `255ecca` (the chooser) onto the **stray Next.js repo's** `main`.
  Given consolidation, **this is now moot** — it polishes the app we're retiring. No
  harm: it changed only the `artistgrowthhub` GitHub repo, not the live origin.
- **Do NOT** run the old handoff's deploy steps (Publish / redeploy the stray repo's
  `smart-link-redirect` edge function). That would invest further in the duplicate.

## 6. Options

**A. Consolidate onto the main app, retire the stray Next.js repo — _recommended_.**
Lowest effort, single source of truth, matches reality. Mostly a data fix.

**B. Keep both.** Ongoing confusion, two codebases, mismatched data shapes. Not advised.

**C. Make the stray repo canonical.** Would require repointing `links.fendifrost.com`
to a 31-commit Next.js rebuild lacking the admin, campaigns, leads, and pixel tooling.
Strongly not advised.

## 7. Recommended steps (Option A)

1. **Verify** the live shape: query the two rows in Supabase SQL editor (see §4).
2. **Convert the rows** to the shape the live app reads (one `UPDATE` each):
   - `heartchakra`: set `metadata.apple_music_url`, (SoundCloud — see step 3), `metadata.even_url`. Keep `destination_url` = EVEN as fallback.
   - `nutrition`: set `metadata.spotify_url`, `metadata.apple_music_url`.
   - (Add Heart Chakra `spotify_url` once Fendi provides it — Spotify renders first.)
3. **(Optional, ~2 lines) add SoundCloud** to the main app's DSP list in
   `src/pages/SmartLinkPage.tsx` (the `dspLinks.push(...)` block) so `metadata.soundcloud_url` renders.
4. **Verify live**: visit `links.fendifrost.com/nutrition` and `/heartchakra` →
   confirm the Spotify/Apple-first button stack renders, each button navigates + fires
   a platform-tagged `CTAClick`.
5. **Retire the stray Next.js repo**: archive `fendifrost-dot/artistgrowthhub` on
   GitHub and remove/rename the local `~/artistgrowthhub` clone (→ `*-ARCHIVED`). If it
   has any standalone Lovable deployment, archive that too — but the FanFuel Hub Lovable
   project (= the main app) stays untouched.
6. **(Optional, later)** port the Odesli auto-resolve idea into the main app's admin so
   entering one DSP URL can pre-fill the others.

## 8. Open questions for Fendi

- Confirm `links.fendifrost.com` (and any QR codes) only ever use the main app's
  `/{slug}` form — not the stray repo's `/l/{slug}`. If any printed/QR assets point at
  `/l/{slug}`, we need a redirect before retiring it.
- Do you want SoundCloud as a standard button (step 3)? The original `heartchakra`
  plan included it.
- OK to archive the `fendifrost-dot/artistgrowthhub` GitHub repo (the FanFuel Hub
  Lovable project itself stays — that's the main app)?
