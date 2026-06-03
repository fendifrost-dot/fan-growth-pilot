# Phase 2 — Truth funnel (complete)

**Status:** Passed on Lovable Edge (`truth-verify` mode=full).  
**Verify command:** `npm run verify:funnel` (needs `TRUTH_VERIFY_SECRET` in `.env`).

## Checklist

| Requirement | Status | Evidence |
|-------------|--------|----------|
| `page_view` → `fan_events` | Pass | verify step `page_view` |
| `email_submit` → `fan_profiles` + `smart_link_leads` | Pass | verify step `email_submit` |
| `link_click` → `link_analytics` before redirect | Pass | verify step `link_click` (ingest path) |
| `purchase` + `click_id` → `link_analytics.converted` | Pass | verify step `purchase` |
| `fan_profiles.user_id` required | Pass | fix `0622862` |
| Optional tables non-fatal | Pass | `smart_link_leads` errors logged, not thrown |
| Meta CAPI payload | Fixed in repo | `meta-conversions` accepts `capi_event_name` + pre-hashed `em` — **Publish** after pull |

## Edge functions (Lovable)

| Function | Role |
|----------|------|
| `truth-verify` | Automated funnel test (`POST` `{"mode":"full"}`) |
| `truth-ingest` | Production browser/API ingest (same `_shared/truth`) |
| `meta-conversions` | Meta CAPI from truth ingest |

## Not in Phase 2

- Next.js `/internal/truth-harness` (separate `artistgrowthhub` repo)
- Dashboard mock → Supabase (Phase 3)
- Channel localStorage fixes (Phase 3 / PR #2 in handoff)

## Last verified

Run locally after Lovable Publish:

```bash
npm run verify:funnel
```

Expect `"ok": true` and four green steps. CAPI may show `any_ok: true` after `meta-conversions` redeploy.
