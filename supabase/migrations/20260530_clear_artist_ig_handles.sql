-- Documentation only — run in Lovable SQL Editor (idempotent)

UPDATE public.playlist_targets
   SET is_active = false,
       pitch_status = 'artist_ig_handle_skip',
       submission_method = CASE
         WHEN curator_email IS NOT NULL THEN 'email'
         WHEN curator_submission_url IS NOT NULL THEN 'web_form'
         ELSE 'none'
       END,
       curator_instagram = NULL,
       last_enriched_at = NULL
 WHERE lower(replace(coalesce(curator_instagram, ''), '@', '')) IN (
   'kaytranada', 'channeltres', 'channeltresofficial', 'sglewis', 'sglewismusic',
   'disclosure', 'disclosuremusic', 'honeydijon', 'honeydijonofficial'
 );

DELETE FROM public.social_engagement_queue
 WHERE status = 'pending'
   AND lower(replace(target_url, 'https://www.instagram.com/', '')) ~ '^(kaytranada|channeltres|sglewis|disclosure|honeydijon)/?$';
