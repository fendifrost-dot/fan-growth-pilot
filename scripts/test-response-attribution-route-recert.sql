-- Isolated test database only. 20260930210000: attributed response writes + route recert.
do $$
declare pl uuid := gen_random_uuid(); v jsonb; ev record;
begin
  insert into pitch_log(id, playlist_id, track_name, curator_email, status, placement_status, placed, reply_received, response_notes)
  values (pl, 'attr-fixture', 'Fixture', 'attr-fixture@example.test', 'sent', 'accepted_free_promo', true, true, 'CoS: accepted free post; URL recorded');

  -- A later reply-record write naming the caller: notes append, protected status kept, actor recorded.
  v := agh_update_pitch_response(pl, jsonb_build_object('placement_status', 'placed', 'placed', false, 'response_notes', 'one-line summary'),
                                 'grok_playlist_control:mark_pitch_response');
  assert (v->>'ok')::boolean, 'rpc ok';
  assert (select placement_status from pitch_log where id = pl) = 'accepted_free_promo', 'protected status kept';
  assert (select placed from pitch_log where id = pl), 'placed kept';
  assert (select response_notes from pitch_log where id = pl) like 'CoS: accepted free post; URL recorded%one-line summary', 'notes appended';
  select * into ev from agh_pitch_response_events where pitch_log_id = pl order by created_at desc limit 1;
  assert ev.actor = 'grok_playlist_control:mark_pitch_response', 'actor attributed: ' || coalesce(ev.actor, 'null');

  v := agh_update_pitch_response(pl, jsonb_build_object('status', 'rejected'), 'x');
  assert v->>'code' = 'field_not_allowed', 'only response fields';
  v := agh_update_pitch_response(pl, jsonb_build_object('response_notes', 'x'), ' ');
  assert v->>'code' = 'actor_required', 'actor required';
  v := agh_update_pitch_response(gen_random_uuid(), jsonb_build_object('response_notes', 'x'), 'a');
  assert v->>'code' = 'not_found', 'missing row';

  -- Route recert: stale flag on a form target with no URL is demoted; a valid route is untouched.
  insert into playlist_targets(playlist_id, playlist_name, lane, is_active, path_verified, verification_status, contact_method, form_url, form_source_evidence, path_verification_notes)
  values ('recert-bad', 'Bad', 'rap', true, true, 'auto_verified', 'web_form', null, 'no submission route confirmed', 'web form URL + source evidence verified'),
         ('recert-ok', 'Ok', 'rap', true, true, 'auto_verified', 'web_form', 'https://dailyplaylists.com/submit-song/add-song', 'DailyPlaylists free rap list', 'ok');
  v := agh_route_recertify_targets(false);
  assert (select count(*) from jsonb_array_elements(v->'targets') t where t->>'playlist_id' = 'recert-bad' and t->>'code' = 'missing_form_url') = 1, 'preview finds stale flag';
  assert (select path_verified from playlist_targets where playlist_id = 'recert-bad'), 'preview writes nothing';
  v := agh_route_recertify_targets(true);
  assert not (select path_verified from playlist_targets where playlist_id = 'recert-bad'), 'stale flag cleared';
  assert (select path_verification_notes from playlist_targets where playlist_id = 'recert-bad') like 'ROUTE_RECERT: missing_form_url%prior: web form URL%', 'prior note kept';
  assert (select path_verified from playlist_targets where playlist_id = 'recert-ok'), 'valid route untouched';
  assert (agh_route_recertify_targets(false)->>'failing_targets')::int = 0, 'idempotent';
  assert not has_function_privilege('authenticated', 'public.agh_update_pitch_response(uuid, jsonb, text)', 'execute'), 'service role only';
end $$;
