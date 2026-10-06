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
  values ('bounce-email', 'Bounce email', 'bounce-fixture@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free', 'bouncefixture', 0);

  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until, resend_message_id)
  values ('bounce-email', tr, 'Bounce fixture', 'bounce-fixture@playlist-bugfix.test', 'email', 'bounced', now(), now(), now() + interval '90 days', 're_bounced')
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
  values ('bounce-email', tr, 'Bounce fixture', 'bounce-fixture@playlist-bugfix.test', 'email', 'sent', now(), now(), now() + interval '90 days', 're_sent')
  returning id into sent_id;
  q := (agh_pipeline_quota(tr)->0->>'submissions_today')::int;
  assert q = 1, 'a real send still counts once';
  assert agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'code' = 'cooldown_conflict', 'a real send still cools every channel';
  assert (agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'pitch_log_id')::uuid = sent_id, 'cooldown names the sent pitch, not the bounce';

  assert bounced_id is not null and sent_id is not null, 'fixture rows exist';

  assert agh_curator_form_key('https://www.playlistdock.com/playlist.php?slug=Chill-Vibes&utm_source=x')
    = 'playlistdock.com/playlist.php?slug=chill-vibes', 'playlistdock keeps slug and drops utm';
  assert agh_curator_form_key('https://playlistdock.com/playlist.php?slug=chill-vibes')
    <> agh_curator_form_key('https://curator.playlistdock.com/playlist.php?slug=other'), 'different slugs stay distinct';
  assert agh_curator_form_key('https://www.DailyPlaylists.com/submit-song/add-song/?utm=x')
    = 'dailyplaylists.com/submit-song/add-song', 'other forms still ignore the query';

  insert into playlist_targets(playlist_id, playlist_name, lane, is_active, path_verified, verification_status, submission_cost, form_url)
  values
    ('pd-alpha', 'PD alpha', 'rap', true, true, 'manually_verified', 'free', 'https://playlistdock.com/playlist.php?slug=alpha'),
    ('pd-beta', 'PD beta', 'rap', true, true, 'manually_verified', 'free', 'https://www.playlistdock.com/playlist.php?slug=beta&utm_source=x'),
    ('pd-alpha-2', 'PD alpha sibling', 'rap', true, true, 'manually_verified', 'free', 'https://playlistdock.com/playlist.php?slug=alpha');
  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until)
  values ('pd-alpha', tr, 'Bounce fixture', 'pd-alpha@playlist-bugfix.test', 'web_form', 'sent', now(), now(), now() + interval '90 days');
  assert agh_contact_policy('pd-beta', tr, 'web_form')->>'code' = 'eligible', 'another PlaylistDock slug is not in cooldown';
  assert agh_contact_policy('pd-alpha-2', tr, 'web_form')->>'code' = 'cooldown_conflict', 'the same PlaylistDock slug is in cooldown';
  assert agh_contact_policy('pd-alpha-2', tr, 'web_form')->>'pitch_log_id'
    = (select id::text from pitch_log where playlist_id = 'pd-alpha' and track_id = tr), 'slug cooldown names the prior pitch';
end $$;

-- Batch-approved web forms can be marked submitted, and one record can be
-- approved or rejected inside a batch that is already APPROVED_FOR_SEND.
do $$
declare
  tr uuid := gen_random_uuid();
  dna uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  approved uuid := gen_random_uuid();
  reviewed uuid := gen_random_uuid();
  rejectable uuid := gen_random_uuid();
  warned uuid := gen_random_uuid();
  bare uuid := gen_random_uuid();
  e jsonb;
  pl uuid;
  v jsonb;
  q jsonb;
begin
  insert into tracks(id, name, status) values (tr, 'Web form fixture', 'active');
  insert into song_dna_versions(id, track_id, version_number, approval_state, primary_genre, approved_lanes, excluded_lanes, short_pitch)
  values (dna, tr, 1, 'approved', 'hip_hop_rap', array['rap'], array['house'], 'Test only');
  update tracks set approved_song_dna_version_id = dna where id = tr;
  insert into playlist_targets(playlist_id, playlist_name, curator_email, lane, is_active, path_verified, verification_status, submission_cost, form_url)
  values ('web-form-approved', 'Web form', 'web-form@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free', 'https://forms.playlist-bugfix.test/submit');
  insert into agh_handoff_batches(id, track_id, queue_state) values (b, tr, 'APPROVED_FOR_SEND');
  insert into agh_handoff_records(id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, approved_by, record_kind, packet)
  values
    (approved, b, tr, 'web-form-approved', 'APPROVED_FOR_SEND', 'web_form', dna, 'fendi', 'playlist_target', '{}'),
    (reviewed, b, tr, 'web-form-approved', 'GROK_REVIEWED', 'web_form', dna, null, 'playlist_target', '{}'),
    (rejectable, b, tr, 'web-form-approved', 'APPROVED_FOR_SEND', 'web_form', dna, 'fendi', 'playlist_target', '{}'),
    (warned, b, tr, 'web-form-approved', 'APPROVED_FOR_SEND', 'web_form', dna, 'fendi', 'playlist_target', '{"grok_review":{"verdict":"WARNING"}}'),
    (bare, b, tr, 'web-form-approved', 'APPROVED_FOR_SEND', 'web_form', dna, null, 'playlist_target', '{}');

  v := agh_review_handoff_records(b, jsonb_build_array(jsonb_build_object(
    'record_id', rejectable, 'decision', 'reject', 'reason', 'under 300 followers')), 'grok_playlist_control', 'test');
  assert (v->>'ok')::boolean and (v->>'applied_count')::int = 1, 'one approved record can be rejected';
  assert (select queue_state from agh_handoff_records where id = rejectable) = 'REJECTED_BY_GROK', 'reject sticks';
  assert (select rejection_reason from agh_handoff_records where id = rejectable) = 'under 300 followers', 'reason stored once';
  assert (select queue_state from agh_handoff_batches where id = b) = 'APPROVED_FOR_SEND', 'approved batch does not move backwards';

  v := agh_review_handoff_records(b, jsonb_build_array(jsonb_build_object(
    'record_id', reviewed, 'decision', 'approve', 'verdict', 'PASS', 'reason', 'lane fits')), 'grok_playlist_control', 'test');
  assert (v->>'applied_count')::int = 1, 'one reviewed record can be approved inside an approved batch';
  assert (select packet->'grok_review'->>'verdict' from agh_handoff_records where id = reviewed) = 'PASS', 'PASS is recorded';

  e := jsonb_build_object('result', 'submitted', 'reference', 'form-receipt', 'notes', 'submitted by hand', 'submitted_at', now());
  begin
    update agh_handoff_records
       set submitted_at = now(), manual_submit_channel = 'web_form', submitted_by = 'fendi',
           packet = packet || jsonb_build_object('submission_evidence', e)
     where id = warned;
    raise exception 'expected warning rejection';
  exception when raise_exception then
    assert SQLERRM = 'pass_approval_required', 'WARNING still cannot be submitted';
  end;
  begin
    update agh_handoff_records
       set submitted_at = now(), manual_submit_channel = 'web_form', submitted_by = 'fendi',
           packet = packet || jsonb_build_object('submission_evidence', e)
     where id = bare;
    raise exception 'expected missing approval rejection';
  exception when raise_exception then
    assert SQLERRM = 'pass_approval_required', 'missing approval still cannot be submitted';
  end;

  update agh_handoff_records
     set submitted_at = now(), manual_submit_channel = 'web_form', submitted_by = 'fendi',
         packet = packet || jsonb_build_object('submission_evidence', e)
   where id = approved;
  select pitch_log_id into pl from agh_manual_submission_receipts where handoff_record_id = approved;
  assert pl is not null, 'receipt stores the handoff record';
  update agh_handoff_records set submitted_at = submitted_at where id = approved;
  assert (select count(*) from agh_manual_submission_receipts where handoff_record_id = approved) = 1, 'retry does not duplicate the receipt';
  q := agh_pipeline_quota(tr)->0;
  assert (q->>'submissions_manual_today')::int = 1, 'manual receipt counts once';
  assert (q->>'submissions_email_today')::int = 0, 'a web form is not an email send';
  assert (q->>'submissions_today')::int = 1, 'quota counts the form once';
end $$;

-- A reason that already names its code is not prefixed again.
do $$
declare
  b uuid := gen_random_uuid();
  doubled uuid := gen_random_uuid();
  plain uuid := gen_random_uuid();
  v jsonb;
begin
  assert agh_compose_rejection_reason('["LOW_REACH"]'::jsonb, 'LOW_REACH: under 300 followers')
    = 'LOW_REACH: under 300 followers', 'existing prefix is kept once';
  assert agh_compose_rejection_reason('["LOW_REACH"]'::jsonb, 'under 300 followers')
    = 'LOW_REACH: under 300 followers', 'a bare reason is prefixed once';
  assert agh_compose_rejection_reason('[]'::jsonb, 'under 300 followers')
    = 'under 300 followers', 'no code leaves the reason alone';

  insert into agh_handoff_batches(id, queue_state) values (b, 'AWAITING_GROK_REVIEW');
  insert into agh_handoff_records(id, batch_id, queue_state, record_kind, packet)
  values
    (doubled, b, 'AWAITING_GROK_REVIEW', 'playlist_target', '{}'),
    (plain, b, 'AWAITING_GROK_REVIEW', 'playlist_target', '{}');
  v := agh_review_handoff_records(b, jsonb_build_array(
    jsonb_build_object('record_id', doubled, 'decision', 'reject', 'reason_codes', jsonb_build_array('LOW_REACH'), 'reason', 'LOW_REACH: under 300 followers'),
    jsonb_build_object('record_id', plain, 'decision', 'reject', 'reason_codes', jsonb_build_array('LOW_REACH'), 'reason', 'under 300 followers')
  ), 'grok_playlist_control', 'test');
  assert (v->>'applied_count')::int = 2, 'both rejects apply';
  assert (select rejection_reason from agh_handoff_records where id = doubled) = 'LOW_REACH: under 300 followers', 'stored reason is not doubled';
  assert (select rejection_reason from agh_handoff_records where id = plain) = 'LOW_REACH: under 300 followers', 'stored reason gains the code once';
end $$;

-- A real email send moves the approved handoff to SENT. A bounce does not,
-- and the move does not add a quota row.
do $$
declare
  tr uuid := gen_random_uuid();
  dna uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  d_sent uuid := gen_random_uuid();
  d_bounce uuid := gen_random_uuid();
  sent_rec uuid := gen_random_uuid();
  form_rec uuid := gen_random_uuid();
  bounce_rec uuid := gen_random_uuid();
  q_before int;
  q_after int;
  logs_before int;
  again jsonb;
begin
  insert into tracks(id, name, status) values (tr, 'Sent handoff fixture', 'active');
  insert into song_dna_versions(id, track_id, version_number, approval_state, primary_genre, approved_lanes, excluded_lanes, short_pitch)
  values (dna, tr, 1, 'approved', 'hip_hop_rap', array['rap'], array['house'], 'Test only');
  update tracks set approved_song_dna_version_id = dna where id = tr;
  insert into playlist_targets(playlist_id, playlist_name, curator_email, lane, is_active, path_verified, verification_status, submission_cost)
  values
    ('sent-handoff', 'Sent handoff', 'sent-handoff@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free'),
    ('bounce-handoff', 'Bounce handoff', 'bounce-handoff@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free');
  insert into outreach_drafts(id, playlist_id, track_id, track_name, channel, recipient, body, status)
  values
    (d_sent, 'sent-handoff', tr, 'Sent handoff fixture', 'email', 'sent-handoff@playlist-bugfix.test', 'already approved', 'approved'),
    (d_bounce, 'bounce-handoff', tr, 'Sent handoff fixture', 'email', 'bounce-handoff@playlist-bugfix.test', 'already approved', 'approved');
  insert into agh_handoff_batches(id, track_id, queue_state) values (b, tr, 'APPROVED_FOR_SEND');
  insert into agh_handoff_records(id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, outreach_draft_id, approved_by, record_kind, packet)
  values
    (sent_rec, b, tr, 'sent-handoff', 'APPROVED_FOR_SEND', 'email', dna, d_sent, 'fendi', 'playlist_target', '{}'),
    (form_rec, b, tr, 'sent-handoff', 'APPROVED_FOR_SEND', 'web_form', dna, null, 'fendi', 'playlist_target', '{}'),
    (bounce_rec, b, tr, 'bounce-handoff', 'APPROVED_FOR_SEND', 'email', dna, d_bounce, 'fendi', 'playlist_target', '{}');
  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, draft_id, resend_message_id)
  values
    ('sent-handoff', tr, 'Sent handoff fixture', 'sent-handoff@playlist-bugfix.test', 'email', 'sent', now(), now(), d_sent, 're_sent_handoff'),
    ('bounce-handoff', tr, 'Sent handoff fixture', 'bounce-handoff@playlist-bugfix.test', 'email', 'bounced', now(), now(), d_bounce, 're_bounced_handoff');

  q_before := (agh_pipeline_quota(tr)->0->>'submissions_today')::int;
  logs_before := (select count(*) from pitch_log where track_id = tr);
  again := agh_backfill_email_handoff_sent();
  assert (again->>'updated')::int = 1, 'one approved email handoff matches the sent pitch';
  assert (select queue_state from agh_handoff_records where id = sent_rec) = 'SENT', 'matching send moves the record to SENT';
  assert (select submitted_at from agh_handoff_records where id = sent_rec) is null, 'SENT does not stamp submitted_at';
  assert (select queue_state from agh_handoff_records where id = form_rec) = 'APPROVED_FOR_SEND', 'web form on the same playlist stays approved';
  assert (select queue_state from agh_handoff_records where id = bounce_rec) = 'APPROVED_FOR_SEND', 'a bounce does not count as sent';
  assert (select count(*) from pitch_log where track_id = tr) = logs_before, 'backfill does not insert pitch_log';
  assert (select count(*) from agh_manual_submission_receipts mr join pitch_log l on l.id = mr.pitch_log_id where l.track_id = tr) = 0, 'backfill does not write a manual receipt';
  q_after := (agh_pipeline_quota(tr)->0->>'submissions_today')::int;
  assert q_after = q_before, 'quota does not change when the handoff moves to SENT';
  again := agh_backfill_email_handoff_sent();
  assert (again->>'updated')::int = 0, 'running the backfill again changes nothing';
  assert (select queue_state from agh_handoff_records where id = sent_rec) = 'SENT', 'the sent record stays SENT';
end $$;

-- Cross-channel cooldown and operator groups.
-- Sphere shape: email pitch on a website target cools an IG playlist that
-- shares the curator email, including a different song.
-- Underground shape: email pitch stored as spotify:<id> cools the bare Spotify
-- id used by the IG handoff, even when that row has no email.
-- Operator shape: shared operator_group_id or Spotify owner id cools every
-- account in the group. A bounce does not.
do $$
declare
  med uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  dna uuid := gen_random_uuid();
  sphere_pitch uuid;
  underground_pitch uuid;
  group_pitch uuid;
  owner_pitch uuid;
  sphere_ig uuid := gen_random_uuid();
  underground_ig uuid := gen_random_uuid();
  group_ig uuid := gen_random_uuid();
  sphere_batch uuid := gen_random_uuid();
  underground_batch uuid := gen_random_uuid();
  group_batch uuid := gen_random_uuid();
  sphere_draft uuid := gen_random_uuid();
  v jsonb;
  q_before int;
  logs_before int;
begin
  insert into tracks(id, name, status) values
    (med, 'Meditate', 'active'),
    (other, 'Designed For Me', 'active');
  insert into song_dna_versions(id, track_id, version_number, approval_state, primary_genre, approved_lanes, excluded_lanes, short_pitch)
  values (dna, med, 1, 'approved', 'hip_hop_rap', array['rap'], array['house'], 'Test only');
  update tracks set approved_song_dna_version_id = dna where id = med;

  insert into playlist_targets(playlist_id, playlist_name, curator_email, lane, is_active, path_verified, verification_status, submission_cost, ig_curator_account)
  values
    ('url:https://www.sphereofhiphop.com/music-news-video-submissions/', 'Sphere of Hip-Hop playlists', 'sphereofhiphop1997@gmail.com', 'rap', true, true, 'manually_verified', 'free', null),
    ('320vLhCnq4Ayd9DcPygQUr', 'Mellow Bars', 'sphereofhiphop1997@gmail.com', 'rap', true, true, 'manually_verified', 'free', 'sphereofhiphop'),
    ('3qKNkgJrFpCRleTD0qZGSC', 'Best Underground Rap 2026', null, 'rap', true, true, 'manually_verified', 'free', 'unknownrap_spotify'),
    ('spotify:5VrYT3G0raqImUExBSSf8O', 'Hip Hop', 'playlistpumppragency@gmail.com', 'rap', true, true, 'manually_verified', 'free', null),
    ('7pU1Xs4DesndgmT5qP6BG2', 'HIP HOP', null, 'rap', true, true, 'manually_verified', 'free', 'playlistcuratorssubmission'),
    ('owner-a-aaaaaaaaaaaaaaaaaa', 'Owner A', 'owner-a@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free', null),
    ('owner-b-bbbbbbbbbbbbbbbbbb', 'Owner B', null, 'rap', true, true, 'manually_verified', 'free', 'ownerbhandle'),
    ('stranger-cccccccccccccccccc', 'Stranger', 'stranger@playlist-bugfix.test', 'rap', true, true, 'manually_verified', 'free', 'strangerhandle');
  update playlist_targets set operator_group_id = 'playlistpumppragency'
   where playlist_id in ('spotify:5VrYT3G0raqImUExBSSf8O', '7pU1Xs4DesndgmT5qP6BG2');
  update playlist_targets set spotify_owner_id = 'spotify-owner-shared'
   where playlist_id in ('owner-a-aaaaaaaaaaaaaaaaaa', 'owner-b-bbbbbbbbbbbbbbbbbb');

  insert into outreach_drafts(id, playlist_id, track_id, track_name, channel, recipient, body, status, generated_by)
  values (sphere_draft, '320vLhCnq4Ayd9DcPygQUr', med, 'Meditate', 'instagram_dm', '@sphereofhiphop', 'already pending', 'pending', 'claude');

  insert into pitch_log(playlist_id, track_id, track_name, curator_email, method, status, sent_at, pitched_at, cooldown_until, resend_message_id)
  values
    ('url:https://www.sphereofhiphop.com/music-news-video-submissions/', med, 'Meditate', 'sphereofhiphop1997@gmail.com', 'email', 'sent', now() - interval '20 days', now() - interval '20 days', now() + interval '70 days', 're_sphere'),
    ('spotify:3qKNkgJrFpCRleTD0qZGSC', med, 'Meditate', 'mgr@partsunknownmusic.com', 'email', 'sent', now() - interval '40 days', now() - interval '40 days', now() + interval '50 days', 're_underground'),
    ('spotify:5VrYT3G0raqImUExBSSf8O', med, 'Meditate', 'playlistpumppragency@gmail.com', 'email', 'sent', now() - interval '10 days', now() - interval '10 days', now() + interval '80 days', 're_group'),
    ('owner-a-aaaaaaaaaaaaaaaaaa', med, 'Meditate', 'owner-a@playlist-bugfix.test', 'email', 'sent', now() - interval '5 days', now() - interval '5 days', now() + interval '85 days', 're_owner'),
    ('stranger-cccccccccccccccccc', med, 'Meditate', 'stranger@playlist-bugfix.test', 'email', 'bounced', now(), now(), now() + interval '90 days', 're_stranger_bounce')
  ;
  select id into sphere_pitch from pitch_log where resend_message_id = 're_sphere';
  select id into underground_pitch from pitch_log where resend_message_id = 're_underground';
  select id into group_pitch from pitch_log where resend_message_id = 're_group';
  select id into owner_pitch from pitch_log where resend_message_id = 're_owner';

  v := agh_contact_policy('320vLhCnq4Ayd9DcPygQUr', med, 'instagram_dm');
  assert v->>'code' = 'cooldown_conflict', 'Sphere IG approve is a cooldown conflict';
  assert (v->>'pitch_log_id')::uuid = sphere_pitch, 'Sphere conflict names the email pitch';
  v := agh_contact_policy('320vLhCnq4Ayd9DcPygQUr', other, 'web_form');
  assert v->>'code' = 'cooldown_conflict' and (v->>'pitch_log_id')::uuid = sphere_pitch, 'Sphere cooldown covers the other song and every channel';

  v := agh_contact_policy('3qKNkgJrFpCRleTD0qZGSC', med, 'instagram_dm');
  assert v->>'code' = 'cooldown_conflict', 'Underground IG approve is a cooldown conflict';
  assert (v->>'pitch_log_id')::uuid = underground_pitch, 'Underground conflict names the spotify: pitch';
  v := agh_contact_policy('3qKNkgJrFpCRleTD0qZGSC', other, 'email');
  assert v->>'code' = 'cooldown_conflict' and (v->>'pitch_log_id')::uuid = underground_pitch, 'Underground cooldown covers the other song';

  v := agh_contact_policy('7pU1Xs4DesndgmT5qP6BG2', med, 'instagram_dm');
  assert v->>'code' = 'cooldown_conflict' and (v->>'pitch_log_id')::uuid = group_pitch, 'operator group cools every account';
  v := agh_contact_policy('owner-b-bbbbbbbbbbbbbbbbbb', other, 'instagram_dm');
  assert v->>'code' = 'cooldown_conflict' and (v->>'pitch_log_id')::uuid = owner_pitch, 'shared Spotify owner id cools the other account and song';
  v := agh_contact_policy('stranger-cccccccccccccccccc', med, 'instagram_dm');
  assert v->>'code' = 'eligible', 'a bounce does not cool the curator';

  insert into agh_handoff_batches(id, track_id, queue_state) values
    (sphere_batch, med, 'GROK_REVIEWED'),
    (underground_batch, med, 'GROK_REVIEWED'),
    (group_batch, med, 'GROK_REVIEWED');
  insert into agh_handoff_records(id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, record_kind, packet)
  values
    (sphere_ig, sphere_batch, med, '320vLhCnq4Ayd9DcPygQUr', 'GROK_REVIEWED', 'instagram_dm', dna, 'playlist_target', '{"ig_curator_account":"sphereofhiphop"}'),
    (underground_ig, underground_batch, med, '3qKNkgJrFpCRleTD0qZGSC', 'GROK_REVIEWED', 'instagram_dm', dna, 'playlist_target', '{"ig_curator_account":"unknownrap_spotify"}'),
    (group_ig, group_batch, med, '7pU1Xs4DesndgmT5qP6BG2', 'GROK_REVIEWED', 'instagram_dm', dna, 'playlist_target', '{"ig_curator_account":"playlistcuratorssubmission"}');

  v := agh_record_can_approve(sphere_ig);
  assert v->>'code' = 'cooldown_conflict' and (v->>'pitch_log_id')::uuid = sphere_pitch, 'record approve sees the Sphere pitch';
  v := agh_review_handoff_records(sphere_batch, jsonb_build_array(jsonb_build_object(
    'record_id', sphere_ig, 'decision', 'approve', 'verdict', 'PASS', 'reason', 'lane fits')), 'grok_playlist_control', 'test');
  assert (v->>'applied_count')::int = 0, 'Sphere IG approval is not applied';
  assert v->'skipped'->0->>'reason' = 'cooldown_conflict', 'Sphere approve skip is cooldown_conflict';
  assert (v->'skipped'->0->>'pitch_log_id')::uuid = sphere_pitch, 'Sphere approve skip names the pitch';
  assert (select queue_state from agh_handoff_records where id = sphere_ig) = 'GROK_REVIEWED', 'Sphere handoff stays unapproved';

  v := agh_review_handoff_records(underground_batch, jsonb_build_array(jsonb_build_object(
    'record_id', underground_ig, 'decision', 'approve', 'verdict', 'PASS', 'reason', 'lane fits')), 'grok_playlist_control', 'test');
  assert v->'skipped'->0->>'reason' = 'cooldown_conflict', 'Underground approve skip is cooldown_conflict';
  assert (v->'skipped'->0->>'pitch_log_id')::uuid = underground_pitch, 'Underground approve skip names the pitch';

  v := agh_review_handoff_records(group_batch, jsonb_build_array(jsonb_build_object(
    'record_id', group_ig, 'decision', 'approve', 'verdict', 'PASS', 'reason', 'lane fits')), 'fendi', 'test');
  assert v->'skipped'->0->>'code' = 'cooldown_conflict', 'operator-group approve skip is cooldown_conflict';
  assert (v->'skipped'->0->>'pitch_log_id')::uuid = group_pitch, 'operator-group approve skip names the pitch';

  q_before := (agh_pipeline_quota(med)->0->>'submissions_today')::int;
  logs_before := (select count(*) from pitch_log where track_id = med);
  begin
    update outreach_drafts set status = 'approved', approved_by = 'grok_playlist_control' where id = sphere_draft;
    raise exception 'expected cooldown conflict';
  exception when raise_exception then
    assert SQLERRM = 'playlist_policy:cooldown_conflict:' || sphere_pitch::text, 'draft approve names the prior pitch';
  end;
  assert (select status from outreach_drafts where id = sphere_draft) = 'pending', 'cooled draft stays pending';
  assert (select count(*) from pitch_log where track_id = med) = logs_before, 'a blocked approve does not write pitch_log';
  assert (agh_pipeline_quota(med)->0->>'submissions_today')::int = q_before, 'a blocked approve does not change quota';
end $$;
