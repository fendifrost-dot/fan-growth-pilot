# CLAUDE.md — agent instructions for `fan-growth-pilot` (FanFuel Hub / Artist Growth Hub)

## 🛑 Supabase / database access — MUST READ (do it the Lovable way, NOT a standalone dashboard)

**There is NO standalone Supabase project, dashboard, or supabase.com login for this
repo.** The database is managed **entirely through the Lovable project** (FanFuel Hub,
GitHub `fendifrost-dot/fan-growth-pilot`). You reach the database **through Lovable** —
never through a separate supabase.com dashboard.

- **Apply SQL / migrations:** paste + run in **Lovable → SQL Editor** (paste, don't type —
  the Monaco editor can strip leading keywords like `UPDATE`). Every schema change must
  ALSO be committed as a version-controlled migration in `supabase/migrations/`.
- **Deploy / redeploy edge functions:** the **Lovable → Edge Functions (Cloud)** area —
  **not** `supabase functions deploy`.
- **Connected Supabase project ref:** `vsemrziqxrrfcquxfnwd` — the data physically lives
  there, but you administer it *through Lovable*.
- **A `supabase` CLI `403` is a FALSE WALL** — it does not mean you lack access; use Lovable.
- **NEVER open a standalone Supabase dashboard / supabase.com login unless Lovable itself
  links you into it.** (A browser/deploy agent recently went to a standalone Supabase
  dashboard by mistake — don't repeat that.)

**Full rule + rationale + quick-reference table:** [`docs/SUPABASE_ACCESS.md`](docs/SUPABASE_ACCESS.md).

---

## Where things live

- **App:** Vite + React + React Router + TypeScript. Operator UI is under `/admin`
  (single-operator). Public smart-link pages at `/:slug`.
- **Backend:** Supabase Edge Functions in `supabase/functions/` (Deno), managed via Lovable.
- **Migrations:** `supabase/migrations/` — the version-controlled source of truth; applied
  via the Lovable SQL Editor (see the rule above).
- **More context:** the `docs/` folder and the various `*_HANDOFF*.md` files at the repo
  root (e.g. `CLAUDE_HANDOFF.md`).
