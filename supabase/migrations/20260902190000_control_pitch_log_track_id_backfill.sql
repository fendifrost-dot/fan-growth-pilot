-- Deterministic Control historical pitch_log.track_id backfill.
-- Independent of pitch_campaigns — safe to apply before campaign gate migrations.
-- Track UUID (primary): Designed For Me (Control) = 5d09da7e-98cf-4276-8dca-861d1fbbfa98
--
-- APPLY via Lovable SQL Editor (paste, don't type). Verified live 2026-09-02:
--   control_null leftover → 0 after apply.

begin;

update public.pitch_log
set track_id = '5d09da7e-98cf-4276-8dca-861d1fbbfa98'::uuid
where track_id is null
  and status = 'sent'
  and lower(coalesce(track_name, '')) like '%designed for me%';

do $$
declare
  leftover int;
begin
  select count(*) into leftover
  from public.pitch_log
  where status = 'sent'
    and track_id is null
    and lower(coalesce(track_name, '')) like '%designed for me%';
  if leftover > 0 then
    raise exception 'Control track_id backfill incomplete: % sent rows still null', leftover;
  end if;
end$$;

commit;

-- POST-APPLY:
--   select count(*) from pitch_log
--    where status='sent' and track_id='5d09da7e-98cf-4276-8dca-861d1fbbfa98';
--   select count(*) from pitch_log
--    where status='sent' and track_id is null
--      and lower(track_name) like '%designed for me%';  -- expect 0
