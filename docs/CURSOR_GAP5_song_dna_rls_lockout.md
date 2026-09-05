# GAP 5 — Song DNA RLS lockout (P0)

## Problem

`20260905000000_outreach_dna_discovery_identity.sql` gated `song_dna_versions` /
`song_dna_audit_events` / `discovery_profiles` (and related audit tables) on:

```sql
coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
```

Nothing in this system sets `app_metadata.role`. The real role model is
`user_roles` + `public.has_role(uid, role)` from `20260718005000_admin_roles.sql`.
The account owner **is** in `user_roles` as `admin`. Direct authenticated writes
returned `42501`.

## Fix

Replace every JWT `app_metadata.role` predicate on those tables with:

```sql
public.has_role(auth.uid(), 'admin')
```

Do **not** grant the JWT claim as a workaround (second divergent role system).

## Applied

- Live: Lovable SQL, 2026-09-05 (Cursor) — `pg_policies` now show `has_role(...)`; 0 remaining `app_metadata` policies on those tables.
- Repo: `supabase/migrations/20260905140000_fix_dna_rls_use_has_role.sql` + source migration corrected for fresh installs.

## Secondary — Track dropdown empty on Song DNA page

`AdminSongDna` previously `Promise.all`'d `list_tracks` + `list_song_dna`, so any DNA
list failure wiped tracks too. Loads are now independent.
