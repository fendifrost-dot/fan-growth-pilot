# Handoff — finish the smart-link favicon/OG + auto-artwork work

**For:** a Cursor / Claude Code session with **Cloudflare access** (wrangler login or a
CF API token) in this environment.
**Repo (LIVE):** `/Users/gocrazyglobal/artistgrowthhub-repo` — remote
`github.com/fendifrost-dot/fan-growth-pilot.git`. **Do NOT** use
`/Users/gocrazyglobal/artistgrowthhub` (dead Next.js clone, no live traffic).
**Supabase project ref:** `vsemrziqxrrfcquxfnwd` (same for both repos — use the git
remote to tell them apart).

## Background (already done — do not redo)

The smart-link pages at `links.fendifrost.com/{slug}` had two bugs: the browser-tab
favicon and the iMessage/social OG image both showed the generic "Runway Music" art
instead of each link's own album artwork. Root cause + fixes are shipped on `main`
(commits `8fee16a`, `e851b50`, pushed) and the Supabase edge functions + frontend are
deployed:

- `supabase/functions/get-og-metadata/index.ts` — now returns a per-link `icon`
  (album art) and uses the link's own `image_url` as the og:image fallback. **Live.**
- `supabase/functions/resolve-artwork/index.ts` + `supabase/functions/_shared/artwork.ts`
  — auto-pull official cover art from the link's DSP URLs (Apple iTunes 1000×1000 →
  Spotify oEmbed 640 → og:image scrape), verify hi-res, store in the `smart-links`
  bucket, set `image_url`. **Live** (returns 401 unauth).
- Frontend: sets the browser-tab favicon client-side, auto-fetches art on link
  create, and runs a once-per-session **backfill sweep** on admin load. **Live**
  (`data-commit-sha=e851b50` on `fan-growth-pilot.lovable.app`).

Architecture note: the app is a **client-rendered Vite SPA (no SSR)**, so crawlers
(iMessage, Twitter) can't see React's client-side meta. Per-link OG/favicon **must**
be injected server-side. That injection is done by a **Cloudflare Worker** on
`links.fendifrost.com/*` that calls `get-og-metadata` and rewrites the HTML `<head>`.
`dig` confirms Cloudflare fronts the domain.

## What's LEFT (your job)

### Task 1 — Deploy the Cloudflare Worker (fixes the crawler/iMessage favicon)

The Worker was historically hand-pasted into the Cloudflare dashboard and had drifted
from the repo. It is now wrangler-ized:
- Source: `public/cloudflare-worker.js` (already contains the favicon `<link rel="icon">`
  injection — the piece the live Worker is missing).
- Config: `wrangler.toml` (route `links.fendifrost.com/*`, zone `fendifrost.com`,
  `ORIGIN_URL=https://fan-growth-pilot.lovable.app`).
- CI: `.github/workflows/deploy-worker.yml` (deploys on push once secrets exist).
- Full setup notes: `docs/CLOUDFLARE_WORKER_DEPLOY.md`.

Steps:
1. Confirm CF auth: `npx wrangler whoami` (or set `CLOUDFLARE_API_TOKEN`).
2. **Find the existing Worker's name** serving `links.fendifrost.com` (CF dashboard →
   Workers & Pages, or `npx wrangler deployments list`). Set `name` in `wrangler.toml`
   to that exact name so this **updates the existing Worker in place** (a different
   name creates a second Worker that can't claim the route — if you must use a new
   name, delete the old Worker's `links.fendifrost.com/*` route first).
3. Dry-run then deploy: `npx wrangler deploy --dry-run` → `npx wrangler deploy`.
4. (Optional but preferred for the future) Add repo secrets `CLOUDFLARE_API_TOKEN`
   + `CLOUDFLARE_ACCOUNT_ID` so pushes auto-deploy via the Action.
5. Commit the `name` change to `wrangler.toml`.

### Task 2 — Trigger + verify the Nutrition artwork backfill

`nutrition` is the only active link still missing art (`image_url` is null). It fills
automatically the next time the smart-links admin loads (the sweep calls
`resolve-artwork {backfill:true}` with the operator's JWT). To force it now, either:
- Open the admin smart-links page in the app (uses your login), **or**
- Invoke with the hub key:
  `curl -X POST https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/resolve-artwork
   -H "x-api-key: $FANFUEL_HUB_KEY" -H "Content-Type: application/json"
   -d '{"backfill":true}'` (FANFUEL_HUB_KEY is in Supabase/Lovable secrets, not local).

### Verification (must pass before declaring done)

```bash
# Nutrition should now have album art (not null)
curl -s "$VITE_SUPABASE_URL/rest/v1/smart_links?slug=eq.nutrition&select=slug,image_url" \
  -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $VITE_SUPABASE_PUBLISHABLE_KEY"

# Live pages: og:image AND favicon must be each link's OWN art (not /favicon.png, not Runway)
for s in nutrition heartchakra runway; do
  echo "== $s =="; curl -s "https://links.fendifrost.com/$s" | grep -iE 'og:image|rel="icon"|<title>'
done
```

Expected after both tasks: `rel="icon"` points to a per-link image (Supabase signed
URL or the link's image), and `og:image` is the link's own artwork — for Heart Chakra
and Nutrition especially. Report what's confirmed live vs. anything still pending.

## Guardrails
- Only touch the LIVE repo (`artistgrowthhub-repo`). Leave unrelated uncommitted WIP
  in the tree alone — stage only the files you intend to change.
- Edge functions deploy through Lovable's GitHub/Supabase integration (a redeploy in
  Lovable may be needed); there is **no** standalone `supabase functions deploy` in
  this setup. The Worker is the exception — it deploys via wrangler.
