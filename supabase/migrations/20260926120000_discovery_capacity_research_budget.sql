-- ---------------------------------------------------------------------------
-- Discovery capacity: make the raw research budget an explicit, operator-set value.
-- Apply via Lovable SQL Editor (paste). Idempotent; config only, no schema change.
--
-- get_playlist_discovery_work.daily_target.effective_raw_target is now the configured
-- research budget (research_budget_raw_per_song × active songs), not
-- objective ÷ trailing conversion (which silently collapsed to objective ÷ 0.05).
-- The edge code defaults to 90/song when this key is absent, so applying this file is
-- optional — it only makes the value visible/editable in ops_settings and flips
-- daily_target.research_budget_source from "default" to "ops_settings".
--
-- Never overwrites a value an operator already set.
-- ---------------------------------------------------------------------------

begin;

update public.ops_settings
   set setting_value = setting_value || jsonb_build_object('research_budget_raw_per_song', 90),
       description = 'Daily discovery planning: objective (target_verified_per_song_per_day), '
         || 'research budget (research_budget_raw_per_song = authorized raw passes per song), '
         || 'interim floors, conversion lookback, and the raw→verified fallback rate '
         || '(min_conversion_rate, applied only when there is no data). Editable by operators.'
 where setting_key = 'discovery_capacity'
   and not (setting_value ? 'research_budget_raw_per_song');

commit;
