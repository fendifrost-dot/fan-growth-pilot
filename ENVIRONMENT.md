# ENVIRONMENT.md — FanFuel Hub / Artist Growth Hub (`fan-growth-pilot`)

**This app runs in a LOVABLE-MANAGED environment. There is no standalone Supabase to
log into.** This file is the authoritative statement of that operational reality. If
anything you are about to do assumes a standalone-Supabase workflow, **STOP** and re-read
this file. See also the policy block in [`CLAUDE.md`](CLAUDE.md) and the machine-readable
[`.deployment/manifest.yml`](.deployment/manifest.yml) /
[`.deployment/manifest.json`](.deployment/manifest.json).

---

## Authority chain

```
GitHub repo  →  Lovable-managed backend/cloud  →  live app / browser
(code +          (backend, auth, database,          (runtime
 migrations)      edge deployment)                    verification)
```

1. **GitHub repo** — canonical source of truth for code **and** migrations
   (`fendifrost-dot/fan-growth-pilot`, branch `main`). Migrations live in
   `supabase/migrations/` and are version-controlled here.
2. **Lovable-managed backend/cloud** — the control plane for backend, auth, database, and
   edge-function deployment. This is where migrations are *applied* (Lovable's SQL editor)
   and where edge functions are *redeployed* (Lovable → Edge Functions area).
3. **Live app / browser** — where changes are verified at runtime through the
   authenticated app.

**This is NOT `GitHub → a standalone Supabase dashboard / CLI / project`.** There is no
such standalone hop in the chain.

## There is NO standalone Supabase / service-role / admin access

- There is **NO** standalone Supabase project, dashboard, or CLI workflow available to us.
- There is **NO** standalone service-role key, **NO** Supabase "Admin API", and **NO**
  external-project access to assume as if independently reachable.
- Therefore, do **NOT**:
  - log into supabase.com / a Supabase dashboard directly (unless Lovable itself links you
    in),
  - use the Supabase CLI to inspect, migrate, or deploy,
  - apply migrations to an external / standalone Supabase project,
  - reference a "Supabase Admin API" or a "service-role key" as though it were something we
    can independently reach and use.

A `supabase` CLI `403` / "wrong account" is a **FALSE WALL** — it is not evidence that you
lack access. It means you are using the wrong door. Use Lovable.

## How work actually gets done

**All** of the following go **through the Lovable-managed environment** (Lovable's SQL
editor + Edge Functions area) **or** the authenticated live-app / browser path:

| Task | Where it happens |
|------|------------------|
| Auth verification / inspection | Lovable-managed auth data via Lovable, or the authenticated live app/browser — **never** a direct Supabase login or an "Admin API" |
| Database inspection | Lovable SQL editor (or the app's own authenticated data views) |
| Migration application | Lovable SQL editor (paste the version-controlled migration; don't type) |
| Edge function redeploy | Lovable → Edge Functions area (Publish ≠ edge redeploy) |
| Runtime verification | the authenticated live app / browser |

## Connected backend ref (identifier, NOT a login target)

The connected backend ref **identifies** the Lovable-managed backend for this repo. It is
**not** a standalone project for you to log into or point a CLI/service-role key at.

- **FanFuel Hub / Artist Growth Hub connected backend ref: `vsemrziqxrrfcquxfnwd`.**

## The drift this file exists to prevent

> **Drift (WRONG):** "check whether X is tied to another auth identity in this Supabase
> project / via the Supabase Admin API."
>
> **Correct framing:** "check the Lovable-managed auth data through the tools available in
> Lovable / the app."

Same underlying auth system — **different operational reality.** We reach it through
Lovable and the authenticated app, never through a standalone Supabase login, CLI, or
service-role / Admin-API assumption.
