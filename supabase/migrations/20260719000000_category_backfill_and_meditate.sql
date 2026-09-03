-- ⚠️ SUPERSEDED IN PART — DO NOT RE-RUN. See 20260828000000_agh001_truth_drift_remediation.sql
--
-- Steps 4 and 6 below classify "Meditate" as a house/club record. That is WRONG
-- and is the AGH-001 error. Meditate is artist-verified RAP / HIP-HOP — a
-- hip-hop club record (Larry June lifestyle-wellness lane; production references
-- Kendrick Lamar "HUMBLE." and J. Cole "Two Six"). "Club" describes the context
-- it was built for, not its genre; reading "club" as a dance/electronic genre
-- lane is precisely the mistake. Production has since been corrected: Meditate's
-- live categories are rap_general + rap_trap_hype and its short_pitch is the
-- "hip-hop club banger" copy.
--
-- This file is retained UNEDITED as incident evidence — it is the record of what
-- AGH-001 actually was, and rewriting applied history would destroy that. It is
-- left here for the audit trail only. Because steps 4 and 6 are idempotent
-- (`on conflict do nothing`), RE-RUNNING THIS FILE WOULD RE-INTRODUCE the house
-- categories on Meditate. Do not re-run it. Corrections are forward-only.
--
-- ---------------------------------------------------------------------------
-- Category data fix for the submissions outage of 2026-07-19.
--
-- ROOT CAUSE (data half). The original seed populated playlist_categories by
-- joining playlist_targets.lane to categories.slug on an EXACT match:
--
--   join public.categories c on c.slug = pt.lane
--
-- but the mass sweep stamps lanes that were never seeded as categories --
-- house_club, house_general, rap_general, rap_trap_hype, rap_conscious (see
-- _shared/playlist-lanes.ts SWEEP_LANE_GENRE). The join matched nothing for
-- every swept row, which is why playlist_categories is empty across the whole
-- verified pool, which is what the matching gate then read as "mismatch".
--
-- This migration seeds the missing sweep-lane categories, re-runs the lane ->
-- category backfill, and gives the two tracks in play correct categories.
-- Idempotent throughout: safe to re-run.

begin;

-- 1. Seed the sweep lanes as real categories so the lane -> category join can
--    actually match. Slugs deliberately mirror SWEEP_LANE_GENRE exactly.
insert into public.categories (slug, label, family) values
  ('house_club',     'House / Club',      'genre'),
  ('house_general',  'House (General)',   'genre'),
  ('rap_general',    'Rap (General)',     'genre'),
  ('rap_trap_hype',  'Trap / Hype Rap',   'genre'),
  ('rap_conscious',  'Conscious Rap',     'genre')
on conflict (slug) do nothing;

-- 2. Backfill playlist_categories from the stamped lane, pool-wide. This is the
--    same join the seed intended; it now matches because of step 1.
insert into public.playlist_categories (playlist_id, category_id)
select pt.playlist_id, c.id
from public.playlist_targets pt
join public.categories c on c.slug = pt.lane
where pt.lane is not null and pt.lane <> ''
on conflict do nothing;

-- 3. Cross-tag house-lane targets with deep_house_groove, the category the
--    "Designed For Me (Control)" track already carries from the original seed.
--    Without this, a house_club target and a deep_house_groove track share no
--    category id and would rely on the genre fallback rather than a true
--    overlap. Restricted to rows whose own name/curator text does NOT name rap,
--    so this cannot mis-tag a rap row that happens to sit on a house lane.
insert into public.playlist_categories (playlist_id, category_id)
select pt.playlist_id, c.id
from public.playlist_targets pt
cross join (select id from public.categories where slug = 'deep_house_groove') c
where pt.lane in ('house_club', 'house_general')
  and coalesce(pt.playlist_name, '') || ' ' || coalesce(pt.curator_name, '')
      !~* '\m(rap|hip ?hop|hiphop|trap|drill|boom ?bap|phonk)\M'
on conflict do nothing;

-- 4. "Meditate" is a CLUB record despite the title. It had NO track category at
--    all, so every target mismatched by definition. Tag it for the house/club
--    space it actually occupies.
insert into public.track_categories (track_id, category_id)
select t.id, c.id
from public.tracks t
cross join public.categories c
where lower(t.name) = 'meditate'
  and c.slug in ('house_club', 'deep_house_groove', 'late_night')
on conflict do nothing;

-- 5. "Designed For Me (Control)" -- ensure it carries the sweep-lane house
--    categories too, not just deep_house_groove, so it overlaps swept rows
--    directly.
insert into public.track_categories (track_id, category_id)
select t.id, c.id
from public.tracks t
cross join public.categories c
where lower(t.name) like '%designed for me%'
  and c.slug in ('house_club', 'house_general', 'deep_house_groove')
on conflict do nothing;

-- 6. Authored short_pitch for "Meditate". The composer now REFUSES to draft when
--    short_pitch is missing (it used to substitute hardcoded house-lane copy
--    for ANY track, which would have mis-sold this record), so this
--    field is required for Meditate to be pitchable at all.
--    Only claims what is known: it is a club record and the title is misleading.
--    >>> FENDI: review this line and overwrite it if you want different copy. <<<
update public.tracks
set short_pitch = 'Don''t let the title fool you - "Meditate" is a club record. '
                  'Four-on-the-floor house built for late-night floors, not a downtempo cut.'
where lower(name) = 'meditate'
  and coalesce(nullif(trim(short_pitch), ''), '') = '';

-- 7. Raise the DFM campaign's daily_target so today's catch-up of all 31
--    eligible targets is not trimmed by the campaign's own self-imposed limit.
--    (The code-side per-song cap was raised 20 -> 35 in the same batch.)
update public.pitch_campaigns pc
set daily_target = 35
from public.tracks t
where pc.track_id = t.id
  and lower(t.name) like '%designed for me%'
  and pc.status = 'active'
  and pc.daily_target < 35;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION -- run after the migration; expect a non-zero, sane count.
-- ---------------------------------------------------------------------------
-- Targets that now carry at least one category (was 0 pool-wide):
--   select count(distinct playlist_id) from public.playlist_categories;
--
-- Eligible deep-house targets for DFM (should be ~31):
--   select count(*)
--   from public.playlist_targets pt
--   where pt.is_active
--     and pt.lane in ('house_club','house_general')
--     and pt.verification_status = 'verified'
--     and coalesce(pt.fraud_verdict,'') <> 'pay_to_play'
--     and pt.curator_email is not null;
--
-- Both tracks now categorised:
--   select t.name, c.slug from public.tracks t
--   join public.track_categories tc on tc.track_id = t.id
--   join public.categories c on c.id = tc.category_id
--   where lower(t.name) = 'meditate' or lower(t.name) like '%designed for me%';
--
-- Meditate has pitch copy:
--   select name, short_pitch from public.tracks where lower(name) = 'meditate';
