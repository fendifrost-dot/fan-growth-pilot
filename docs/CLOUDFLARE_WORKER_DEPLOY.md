# Cloudflare Worker — automated deploy (no more copy-paste)

The smart-link pages at `links.fendifrost.com/{slug}` are served by a Cloudflare
Worker that injects per-link `og:image`, `twitter:image`, `<title>`, canonical,
and **favicon** into the SPA HTML for crawlers (iMessage, Twitter, WhatsApp) —
because the app is a client-rendered Vite SPA and crawlers don't run JS.

Historically that Worker was hand-pasted into the Cloudflare dashboard, so
`public/cloudflare-worker.js` in the repo could silently drift from what was
live. This wires it to Wrangler + GitHub Actions so a `git push` deploys it.

- **Worker source (edit here):** `public/cloudflare-worker.js`
- **Deploy config:** `wrangler.toml`
- **CI:** `.github/workflows/deploy-worker.yml`

## One-time setup

### 1. Match the Worker name
In the Cloudflare dashboard → **Workers & Pages**, find the Worker currently
serving `links.fendifrost.com` and copy its exact name. Put it in `wrangler.toml`
as `name = "..."`. (If you instead want a new Worker, first delete the old
Worker's route for `links.fendifrost.com/*` so this one can claim it — two
Workers can't own the same route.)

### 2. Create a scoped API token
Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**:
- **Account** → *Workers Scripts* → **Edit**
- **Zone** → *Workers Routes* → **Edit** (for zone `fendifrost.com`)
- **Zone** → *Zone* → **Read**

Copy the token (shown once).

### 3. Find your Account ID
Cloudflare dashboard → **Workers & Pages** (or any zone's Overview) → **Account ID**.

### 4. Add repo secrets
GitHub repo **Settings → Secrets and variables → Actions → New repository secret**:
- `CLOUDFLARE_API_TOKEN` = the token from step 2
- `CLOUDFLARE_ACCOUNT_ID` = the ID from step 3

That's the only manual step, and it's one-time. Until these exist, the workflow
runs but skips the deploy (stays green).

## After setup

Any push to `main` that touches `public/cloudflare-worker.js` or `wrangler.toml`
auto-deploys the Worker. You can also trigger it manually from the **Actions**
tab (**Deploy Cloudflare Worker → Run workflow**), or run `wrangler deploy`
locally (`npx wrangler login` first).

## Verify a deploy

```bash
# favicon + og:image should be per-link (not the generic /favicon.png or Runway)
curl -s https://links.fendifrost.com/heartchakra | grep -iE 'rel="icon"|og:image'
```

The Worker does not cache HTML aggressively, so changes appear on the next
request. If you ever need to force-purge a slug:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {token}" \
  -d '{"files":["https://links.fendifrost.com/heartchakra"]}'
```
