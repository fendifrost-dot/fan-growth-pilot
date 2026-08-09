# CLAUDE.md — agent instructions for `fan-growth-pilot` (FanFuel Hub / Artist Growth Hub)

## 🛑 PROJECT POLICY — violation of ANY item requires STOPPING work

These are **policy, not notes.** If you are about to do anything that conflicts with an
item below, **STOP**, and re-read this block + [`docs/AGENT_BOOTSTRAP.md`](docs/AGENT_BOOTSTRAP.md).
Machine-readable version: [`.deployment/manifest.yml`](.deployment/manifest.yml) /
[`.deployment/manifest.json`](.deployment/manifest.json).

**Lovable-managed backend ONLY — no standalone Supabase dashboard/CLI/service-role/admin-API/external project. All auth, database, migration, and edge work goes through Lovable or the authenticated app/browser. See [`ENVIRONMENT.md`](ENVIRONMENT.md).**

1. **Repository.** The canonical, active repo is **`fendifrost-dot/fan-growth-pilot`**
   (`git remote -v` must show this). It is **NOT** `fendifrost-dot/artistgrowthhub` (a
   stale sibling with no live traffic) and **NOT** an archived/mirror clone. If the remote
   is anything else → STOP.
2. **Database is Lovable-managed Supabase — there is NO standalone Supabase dashboard.**
   Apply SQL / migrations by pasting into **Lovable → SQL Editor** (paste, don't type).
   **Connected project ref: `vsemrziqxrrfcquxfnwd`.**
3. **Edge functions redeploy via Lovable → Edge Functions (Cloud)** — never
   `supabase functions deploy`.
4. **A `supabase` CLI `403` is a FALSE WALL** — it does not mean you lack access. Use Lovable.
5. **Source of truth:** every schema change is committed as a version-controlled migration
   in `supabase/migrations/`; the repo is the source of truth for code.
6. **FORBIDDEN (doing any of these = STOP):**
   `standalone_supabase` (no supabase.com dashboard/login unless Lovable links you in) ·
   `archived_clone` · `local_sql` (no local/CLI SQL apply) · `stale_repo`
   (`artistgrowthhub`).

> A browser/deploy agent recently opened a standalone Supabase dashboard by mistake. That
> is a policy violation — this block exists so it does not happen again.

**Before doing any work, complete the pre-flight checklist:
[`docs/AGENT_BOOTSTRAP.md`](docs/AGENT_BOOTSTRAP.md).**
Full database-access rule + rationale: [`docs/SUPABASE_ACCESS.md`](docs/SUPABASE_ACCESS.md).

---

## Where things live

- **App:** Vite + React + React Router + TypeScript. Operator UI is under `/admin`
  (single-operator). Public smart-link pages at `/:slug`.
- **Backend:** Supabase Edge Functions in `supabase/functions/` (Deno), managed via Lovable.
- **Migrations:** `supabase/migrations/` — version-controlled source of truth; applied via
  the Lovable SQL Editor (see policy above).
- **Governance:** `.deployment/manifest.{yml,json}` (machine-readable facts),
  `docs/AGENT_BOOTSTRAP.md` (pre-flight), `docs/SUPABASE_ACCESS.md` (DB access rule).
- **More context:** the `docs/` folder and the various `*_HANDOFF*.md` files at the repo root.
