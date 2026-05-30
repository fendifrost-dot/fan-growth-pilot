-- Documentation only — run in Lovable SQL Editor after contact-extract denylist deploy

UPDATE public.playlist_targets
   SET curator_instagram = NULL,
       submission_method = CASE
         WHEN curator_email IS NOT NULL THEN 'email'
         WHEN curator_submission_url IS NOT NULL THEN 'web_form'
         ELSE 'none'
       END,
       last_enriched_at = NULL
 WHERE lower(curator_instagram) IN (
   'reel', 'reels', 'p', 'explore', 'stories', 'share', 'accounts', 'direct', 'tv',
   'developer', 'press', 'about', 'help', 'policy', 'legal', 'terms', 'privacy',
   'safety', 'settings', 'popular'
 );
