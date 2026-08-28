-- AGH-001 Truth Drift Remediation — FORWARD-ONLY correction.
--
-- WHY THIS EXISTS
-- ---------------
-- Production was read (read-only) via the Lovable SQL editor on 2026-08-28. The
-- P0-A containment migration (20260827000000) had already been applied at
-- 2026-08-28 05:02:43 UTC from the UNCORRECTED commit — the version whose
-- Meditate provenance described it as a "club record" on the
-- house_club / deep_house_groove / late_night tagging.
--
-- Live state found:
--
--   Meditate   categories  rap_general, rap_trap_hype                 CORRECT
--              short_pitch "hip-hop club banger..."                   CORRECT
--              pitch_angle "...HOUSE explicitly INAPPROPRIATE..."     CORRECT
--              eligibility_reason / _source / _si_version             STALE — house text
--
--   Designed For Me (Control)
--              categories  deep_house_groove, house_club,
--                          house_general, PLUS rap_general            CONTAMINATED
--
-- So the artist truth is already right; what is stale is the eligibility
-- PROVENANCE written by the uncorrected migration, plus one stray category on
-- DFM. This file corrects both, forward-only.
--
-- FORWARD-ONLY / EVIDENCE PRESERVATION
-- ------------------------------------
-- 20260827000000 and 20260719000000 are NOT edited or re-run. Applied history is
-- evidence and stays exactly as it was applied — including the incorrect text,
-- which is the record of what AGH-001 actually was. This migration supersedes
-- that state going forward and says so in the data it writes.
--
-- SCOPE: eligibility provenance + one contaminated category row. It does NOT
-- change outreach_eligibility for any track (both cleared tracks stay
-- `eligible`; all others stay on the fail-closed default), does NOT author
-- short_pitch or pitch_angle, and does NOT touch any other track.
--
-- NOT APPLIED BY THIS COMMIT. Live apply is a gated Lovable step.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Meditate — replace the stale house provenance with the rap correction.
-- ---------------------------------------------------------------------------
-- GENRE = rap/hip-hop. CONTEXT = club. Those are different axes, and collapsing
-- them is the AGH-001 error. "Club" is correct and is kept; no house wording is
-- written for Meditate by this statement.
update public.tracks
set eligibility_reason    = 'Artist-verified 2026-08-27: RAP / HIP-HOP club record — a '
                            'hip-hop club banger. Hard-hitting rap bars built for the '
                            'nightclub floor. Larry June lifestyle-wellness lane; '
                            'production references Kendrick Lamar "HUMBLE." and J. Cole '
                            '"Two Six". Live categories are rap_general + rap_trap_hype. '
                            '"Club" is the CONTEXT the record was made for, NOT a genre '
                            'claim — the genre is rap/hip-hop. AGH-001 remediation: '
                            'supersedes the prior dance/electronic genre mis-classification '
                            'written by migration 20260827000000, which is retained '
                            'unedited as incident evidence.',
    eligibility_source    = 'artist_review_rap_correction_2026-08-27',
    eligibility_set_by    = 'fendi-approved-2026-08-27',
    eligibility_set_at    = now(),
    eligibility_si_version = 'si-2026-08-27-meditate-rap-correction'
where lower(name) = 'meditate';

-- ---------------------------------------------------------------------------
-- 2. Designed For Me (Control) — remove the contaminating rap_general tag.
-- ---------------------------------------------------------------------------
-- DFM is a house record. No migration in the repository explains a rap_general
-- tag on it (20260719000000 inserts only house_club / house_general /
-- deep_house_groove for DFM), so this is drift of unknown origin.
--
-- It is not cosmetic. trackGenre reads category slugs first, and
-- sweepLaneTextGenre returns NULL when a string matches BOTH genres — so
-- "deep_house_groove house_club house_general rap_general" resolves to no genre
-- at all. That is what made DFM indistinguishable from a track with no song
-- intelligence. The placement-match gate was hardened separately so a blended
-- track can never be blocked on that basis alone; this removes the bad datum.
delete from public.track_categories tc
using public.tracks t, public.categories c
where tc.track_id = t.id
  and tc.category_id = c.id
  and lower(t.name) like '%designed for me%'
  and c.slug = 'rap_general';

-- Record why DFM's provenance changed, without altering its eligibility.
update public.tracks
set eligibility_reason    = 'Artist-verified 2026-08-27: house/club record — Chicago '
                            'deep-house influenced melodic rap, categories and authored '
                            'short_pitch corrected and reviewed; cleared for curator '
                            'outreach. AGH-001 remediation 2026-08-28: removed a stray '
                            'rap_general category tag of unknown origin that made the '
                            'track genre unresolvable.',
    eligibility_source    = 'artist_review_2026-08-27',
    eligibility_set_at    = now(),
    eligibility_si_version = 'si-2026-08-28-dfm-category-decontamination'
where lower(name) like '%designed for me%';

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run after applying.
-- ---------------------------------------------------------------------------
-- Meditate provenance is the rap correction, and carries no house wording:
--   select name, outreach_eligibility, eligibility_source, eligibility_si_version,
--          eligibility_reason
--   from public.tracks where lower(name) = 'meditate';
--
-- DFM now resolves to a single genre (expect deep_house_groove, house_club,
-- house_general and NO rap_general):
--   select t.name, c.slug from public.tracks t
--   join public.track_categories tc on tc.track_id = t.id
--   join public.categories c on c.id = tc.category_id
--   where lower(t.name) like '%designed for me%' order by c.slug;
--
-- Eligibility itself is unchanged — still exactly two cleared tracks:
--   select count(*) from public.tracks where outreach_eligibility = 'eligible';

-- ---------------------------------------------------------------------------
-- ROLLBACK. Restores the pre-remediation VALUES; it does not un-apply history.
-- Note this deliberately restores the incorrect house provenance, so only run it
-- to reproduce the incident state.
-- ---------------------------------------------------------------------------
-- begin;
-- insert into public.track_categories (track_id, category_id)
-- select t.id, c.id from public.tracks t
-- cross join (select id from public.categories where slug = 'rap_general') c
-- where lower(t.name) like '%designed for me%'
-- on conflict do nothing;
--
-- update public.tracks
-- set eligibility_source = 'migration',
--     eligibility_si_version = 'si-2026-07-19-category-backfill'
-- where lower(name) = 'meditate' or lower(name) like '%designed for me%';
-- commit;
