# Agent bootstrap — pre-flight checklist (answer BEFORE doing any work)

Every new agent session MUST answer these six questions **before** touching deploy,
database, or git — and must be able to answer them **correctly**. If you cannot answer
any item correctly (or a check below fails), **do NOT proceed** — stop and re-read
[`/CLAUDE.md`](../CLAUDE.md) and the machine-readable manifest
[`.deployment/manifest.yml`](../.deployment/manifest.yml).

| # | Question | Correct answer | How to check |
|---|---|---|---|
| 1 | **Repository?** | `fendifrost-dot/fan-growth-pilot` (the canonical, active repo) | `git remote -v` shows origin = `…/fan-growth-pilot.git`. NOT `artistgrowthhub` (stale sibling), NOT an archived/mirror clone. |
| 2 | **Deployment target?** | **Lovable** (Edge Functions redeploy via Lovable) | `.deployment/manifest.yml` → `deployment.provider: lovable`. |
| 3 | **Database?** | **Lovable-managed Supabase** — via Lovable SQL Editor, no standalone dashboard | `docs/SUPABASE_ACCESS.md`; manifest `database.provider: lovable_supabase`. |
| 4 | **Project ref?** | `vsemrziqxrrfcquxfnwd` | manifest `database.project_ref`. |
| 5 | **Canonical branch?** | `main` | manifest `canonical_branch`; `git rev-parse origin/main`. |
| 6 | **Source of truth?** | Version-controlled `supabase/migrations/` for schema; the repo for code | manifest `database.migrations_source_of_truth`. |

## Kill this assumption before you start

**Managed service ≠ operational access to the underlying platform.** AGH / FanFuel Hub
runs on Supabase technology *underneath* Lovable, but the team has **no** "Supabase
environment": no dashboard, CLI, service-role key, or Admin API to operate. Lovable is the
only control plane; the underlying Supabase is an implementation detail, not an operational
surface. Never reason *"it's Supabase, so I'll use the Supabase dashboard/CLI/Admin API."*
Everything goes through Lovable or the authenticated app/browser. Full statement:
[`/ENVIRONMENT.md`](../ENVIRONMENT.md) → "Principle: managed service ≠ operational access to
the underlying platform."

## Hard stops (the `forbidden` list — doing any of these means STOP)

- **standalone_supabase** — never open a supabase.com dashboard/login unless Lovable
  itself links you into it.
- **archived_clone** — never act from an archived or mirror copy of the repo.
- **local_sql** — never apply SQL locally / via the CLI; use the Lovable SQL Editor.
- **stale_repo** — never push to / act on `fendifrost-dot/artistgrowthhub` (stale sibling,
  serves no live traffic).

## If a check fails

Stop. Do not deploy, do not apply SQL, do not push. Report which check failed and re-read
`/CLAUDE.md` (PROJECT POLICY) + `.deployment/manifest.yml`. A `supabase` CLI `403` is a
**false wall**, not a failed check — it just means "use Lovable instead."

## One-line self-test

```
git remote -v            # → origin fendifrost-dot/fan-growth-pilot   (else: wrong/stale clone → STOP)
cat .deployment/manifest.yml   # → project_ref vsemrziqxrrfcquxfnwd, provider lovable
```
