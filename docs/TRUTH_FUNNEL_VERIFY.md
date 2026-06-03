# Truth funnel verify (Lovable only)

## Service role: hidden in Lovable UI

Lovable is correct: **`SUPABASE_SERVICE_ROLE_KEY` exists for your project** but is often **not listed** in Cloud → Secrets. Lovable injects it into **Edge Functions at runtime** only (`execute-pitch`, `meta-conversions`, etc. already use it).

You do **not** need to invent a key, and the **anon / publishable** key is **not** a substitute.

| Key | In Lovable Secrets UI? | Used where |
|-----|------------------------|------------|
| Anon / `VITE_SUPABASE_PUBLISHABLE_KEY` | Usually yes | Browser, Edge `apikey` header |
| Service role | Often **hidden** | Edge runtime only |
| `TRUTH_VERIFY_SECRET` | **You add** | `truth-verify` auth |

## Recommended: verify via Edge (no local service role)

1. **Lovable Cloud → Secrets** — add a secret you choose:
   ```text
   TRUTH_VERIFY_SECRET=<long random string>
   ```

2. **GitHub push** this repo, then **Lovable Publish** the function:
   - `truth-verify` (`supabase/functions/truth-verify/`)

3. In **this repo** `.env` (no service role needed):
   ```env
   VITE_SUPABASE_URL=https://vsemrziqxrrfcquxfnwd.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<anon from Lovable>
   TRUTH_VERIFY_SECRET=<same string as Lovable>
   ```

4. Run:
   ```bash
   npm run verify:funnel
   ```

The script calls `POST …/functions/v1/truth-verify` with `mode=full`. Edge uses Lovable’s injected service role to write `fan_events`, `fan_profiles`, `link_analytics`, etc.

## Optional: direct DB script

Only if you ever obtain the real service role (e.g. Lovable support surfaces it once):

```env
SUPABASE_SERVICE_ROLE_KEY=<service_role JWT — role claim must be service_role, not anon>
```

Then `npm run verify:funnel` uses direct DB writes. Force Edge path anyway:

```bash
VERIFY_VIA_EDGE=1 npm run verify:funnel
```

## Deploy checklist

- [ ] `TRUTH_VERIFY_SECRET` in Lovable Secrets  
- [ ] `truth-verify` published from this repo  
- [ ] `.env` has anon URL + key + `TRUTH_VERIFY_SECRET`  
- [ ] `npm run verify:funnel` returns `"ok": true`

## If `truth-verify` returns 404

Function not deployed yet — Publish in Lovable after push.
