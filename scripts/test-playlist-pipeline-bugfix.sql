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
  assert agh_contact_policy('bounce-email', tr, 'instagram_dm')->>'code' = 'curator_cooldown', 'a real send still cools every channel';

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
  assert agh_contact_policy('pd-alpha-2', tr, 'web_form')->>'code' = 'curator_cooldown', 'the same PlaylistDock slug is in cooldown';
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
