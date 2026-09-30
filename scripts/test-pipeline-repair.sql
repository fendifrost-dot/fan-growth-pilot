-- Isolated test database only.
do $$
declare tr uuid:=gen_random_uuid();dna uuid:=gen_random_uuid();b uuid:=gen_random_uuid();r uuid:=gen_random_uuid();pl uuid;v jsonb;e jsonb;
begin
insert into tracks(id,name,status) values(tr,'Pipeline fixture','active');
insert into song_dna_versions(id,track_id,version_number,approval_state,primary_genre,approved_lanes,excluded_lanes,short_pitch)
values(dna,tr,1,'approved','hip_hop_rap',array['rap'],array['house'],'Test only');
update tracks set approved_song_dna_version_id=dna where id=tr;
insert into playlist_targets(playlist_id,playlist_name,curator_email,lane,is_active,path_verified,verification_status,submission_cost,form_url)
values('pipeline-fixture','Fixture','pipeline-fixture@example.test','rap',true,true,'manually_verified','free','https://example.test/submit');
insert into agh_handoff_batches(id,track_id,queue_state) values(b,tr,'AWAITING_GROK_REVIEW');
insert into agh_handoff_records(id,batch_id,track_id,playlist_target_id,queue_state,submission_channel,song_dna_version_id,record_kind,packet)
values(r,b,tr,'pipeline-fixture','AWAITING_GROK_REVIEW','web_form',dna,'playlist_target','{}');
assert agh_record_can_approve(r)->>'code'='review_required','cannot skip review';
v:=agh_review_handoff_records(b,jsonb_build_array(jsonb_build_object('record_id',r,'decision','reviewed')),'grok_playlist_control','test');
assert (v->>'applied_count')::int=1,'review works';
v:=agh_review_handoff_records(b,jsonb_build_array(jsonb_build_object('record_id',r,'decision','approve','verdict','WARNING','reason','test')),'grok_playlist_control','test');
assert (v->>'applied_count')::int=0,'WARNING cannot approve';
v:=agh_review_handoff_records(b,jsonb_build_array(jsonb_build_object('record_id',r,'decision','approve','verdict','PASS','reason','test')),'claude_playlist_discovery','test');
assert (v->>'applied_count')::int=0,'Claude cannot approve';
v:=agh_review_handoff_records(b,jsonb_build_array(jsonb_build_object('record_id',r,'decision','approve','verdict','PASS','reason','test')),'grok_playlist_control','test');
assert (v->>'applied_count')::int=1,'PASS approves';
begin
update agh_handoff_records set submitted_at=now(),manual_submit_channel='web_form',submitted_by='grok_playlist_control' where id=r;
raise exception 'expected evidence rejection';
exception when raise_exception then assert SQLERRM='submission_evidence_required','evidence required';end;
e:=jsonb_build_object('result','submitted','reference','fixture-receipt','notes','isolated test only','submitted_at',now());
update agh_handoff_records set submitted_at=now(),manual_submit_channel='web_form',submitted_by='grok_playlist_control',
packet=packet||jsonb_build_object('submission_evidence',e) where id=r;
select pitch_log_id into pl from agh_manual_submission_receipts where handoff_record_id=r;
assert pl is not null,'receipt persisted with pitch log';
update agh_handoff_records set submitted_at=submitted_at where id=r;
assert (select count(*) from pitch_log where track_id=tr)=1,'retry does not duplicate';
assert (agh_pipeline_quota(tr)->0->>'submissions_today')::int=1,'quota counts once';
assert agh_contact_policy('pipeline-fixture',tr)->>'code'='curator_cooldown','cooldown active';
begin
insert into outreach_drafts(playlist_id,track_id,track_name,channel,recipient,body) values('pipeline-fixture',tr,'Fixture','email','pipeline-fixture@example.test','test');
raise exception 'expected draft rejection';
exception when raise_exception then assert SQLERRM like 'playlist_policy:%','draft cooldown enforced';end;
update pitch_log set placement_status='declined_paid_solicitation',response_notes='Original decision',reply_received=true where id=pl;
update pitch_log set placement_status='replied',response_notes='New acknowledgement',reply_received=false where id=pl;
assert (select placement_status from pitch_log where id=pl)='declined_paid_solicitation','status preserved';
assert (select response_notes from pitch_log where id=pl) like '%Original decision%New acknowledgement%','notes appended';
assert (select reply_received from pitch_log where id=pl),'human reply preserved';
assert (select count(*) from agh_pitch_response_events where pitch_log_id=pl)=2,'writes audited';
update playlist_targets set submission_cost='paid' where playlist_id='pipeline-fixture';
assert agh_contact_policy('pipeline-fixture',tr)->>'code'='paid_curator','paid rejected';
update playlist_targets set submission_cost='free' where playlist_id='pipeline-fixture';
insert into domain_blocklist(domain,reason) values('example.test','fixture');
assert agh_contact_policy('pipeline-fixture',tr)->>'code'='blocked_domain','domain blocked';
end $$;
