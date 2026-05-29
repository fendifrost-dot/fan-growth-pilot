-- Doc-only: run via Lovable SQL Editor after lane-fit-gate deploy.
-- Clears deep_house_groove lane stamps on rap-named catalog rows (idempotent).

update playlist_targets
   set lane = null,
       why_it_fits = null,
       recommended_pitch_angle = null
 where lane = 'deep_house_groove'
   and (
     lower(playlist_name) ~ '\b(rap|hip ?hop|hiphop|trap|drill)\b'
     or lower(curator_name) ~ '\b(rap|hip ?hop|hiphop|trap|drill)\b'
   );
