-- Isolated checks for the Oct 2026 playlist-pipeline fixes.
-- Runs after the repair migrations and the bugfix migrations, on the fixture schema.
do $$
declare
  tr uuid := gen_random_uuid();
  dna uuid := gen_random_uuid();
  sent_id uuid;
  bounced_id uuid;
  q int;
begin
  insert into tracks(id, name, status) values (tr, 'Bounce fixture', 'active');
  insert into song_dna_versions(id, track_id, version_number, approval_state, primary_genre, approved_lanes, excluded_lanes, short_pitch)
  values (dna, tr, 1, 'approved', 'hip_hop_rap', array['rap'], array['house'], 'Test only');
  update tracks set approved_song_dna_version_id = dna where id = tr;

  insert into playlist_targets(playlist_id, playlist_name, curator_email, lane, is_active, path_verified, verification_status, submission_cost, ig_curator_account, bounce_count)
  values ('bounce-email', 'Bounce email', 'bounce-fixture@example.test', 'rap', true, true, 'manually_verified', 'free', 'bouncefixture', 0);

  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until, resend_message_id)
  values ('bounce-email', tr, 'Bounce fixture', 'bounce-fixture@example.test', 'email', 'bounced', now(), now(), now() + interval '90 days', 're_bounced')
  returning id into bounced_id;

  q := (agh_pipeline_quota(tr)->0->>'submissions_today')::int;
  assert q = 0, 'bounced resend id does not count toward quota';
  assert agh_contact_policy('bounce-email', tr, 'email')->>'code' = 'eligible', 'bounced row does not start email cooldown';
  assert agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'code' = 'eligible', 'bounced email does not block IG';
  assert agh_contact_policy('bounce-email', tr)->>'code' = 'eligible', 'default channel also ignores the bounce';

  update playlist_targets set bounce_count = 1 where playlist_id = 'bounce-email';
  assert agh_contact_policy('bounce-email', tr, 'email')->>'code' = 'suppressed_curator', 'email bounce still suppresses email';
  assert agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'code' = 'eligible', 'bounce count does not block IG';
  assert agh_contact_policy('bounce-email', tr, 'web_form')->>'code' = 'eligible', 'bounce count does not block web forms';
  update playlist_targets set bounce_count = 0 where playlist_id = 'bounce-email';

  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until, resend_message_id)
  values ('bounce-email', tr, 'Bounce fixture', 'bounce-fixture@example.test', 'email', 'sent', now(), now(), now() + interval '90 days', 're_sent')
  returning id into sent_id;
  q := (agh_pipeline_quota(tr)->0->>'submissions_today')::int;
  assert q = 1, 'a real send still counts once';
  assert agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'code' = 'curator_cooldown', 'a real send still cools every channel';

  assert bounced_id is not null and sent_id is not null, 'fixture rows exist';
end $$;
