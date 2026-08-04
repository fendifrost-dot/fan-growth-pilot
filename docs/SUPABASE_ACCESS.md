# Supabase / database access — the Lovable-only rule (MUST READ)

> A browser/deploy agent recently opened a **standalone Supabase dashboard** by mistake.
> This document exists so the next agent cannot miss the rule. See also the top of
> [`/CLAUDE.md`](../CLAUDE.md).

## TL;DR

**There is NO standalone Supabase project, dashboard, or supabase.com login for this
repo.** The database is managed **entirely through the Lovable project** (FanFuel Hub /
`fan-growth-pilot`). Reach the database through Lovable — never through a separate
supabase.com dashboard.

## The rules

1. **No standalone Supabase dashboard.** Do not navigate to supabase.com, and do not look
   for a separate Supabase login/project. If you think you need the Supabase dashboard,
   you actually need **Lovable**.
2. **Apply SQL / migrations** in **Lovable → SQL Editor**. **Paste** the SQL (don't type
   it — the Monaco editor can strip leading keywords such as `UPDATE`). Every migration is
   also committed to `supabase/migrations/` as the version-controlled source of truth, so
   the repo and the live DB stay in sync.
3. **Deploy / redeploy edge functions** via **Lovable → Edge Functions (Cloud)**, not
   `supabase functions deploy`.
4. **Connected Supabase project ref:** `vsemrziqxrrfcquxfnwd`. The data physically lives in
   this Supabase project, but you administer it **through Lovable**.
5. **A `supabase` CLI `403` is a FALSE WALL.** It does not mean you lack access or that
   something is broken — it means the CLI path is not the way in. Use Lovable.
6. **Only open a Supabase dashboard if Lovable itself links you into it.** If Lovable
   provides a deep link into Supabase for a specific action, following that link is fine;
   navigating to a standalone Supabase dashboard on your own is not.

## Why this rule exists

This project is a **Lovable** app. Lovable provisions and fronts the Supabase project;
there is no separately-managed Supabase account or dashboard for an operator to log into.
Agents that go looking for a standalone Supabase dashboard waste time and can end up in the
wrong place (or a different project entirely). The **Lovable SQL Editor** and **Edge
Functions** area are the supported, correct surfaces for every database and function
operation.

## Quick reference

| Task | Where to do it |
|---|---|
| Run a migration / ad-hoc SQL | **Lovable → SQL Editor** (paste, don't type) |
| Redeploy an edge function | **Lovable → Edge Functions (Cloud)** |
| Where the data physically lives | Supabase project ref `vsemrziqxrrfcquxfnwd` (reached via Lovable) |
| `supabase` CLI returns `403` | Ignore — false wall; use Lovable |
| Standalone supabase.com dashboard | ❌ Do **not** — unless Lovable links you in |
| Commit the schema change to git | Always — `supabase/migrations/*.sql` (version-controlled source of truth) |
