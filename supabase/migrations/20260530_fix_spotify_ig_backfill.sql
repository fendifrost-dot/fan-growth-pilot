-- Documentation only — run in Lovable SQL Editor after deploying IG handle fix

-- 1) Inspect corrupted handles
SELECT playlist_id, curator_name, playlist_name, curator_instagram
  FROM public.playlist_targets
 WHERE lower(curator_instagram) = 'spotify'
    OR lower(curator_instagram) LIKE 'spotify%'
    OR curator_instagram LIKE '%.%'
    OR lower(curator_instagram) IN ('instagram', 'meta', 'facebook', 'anchor', 'soundtrap');

-- 2) Clear bad handles and allow re-enrichment
UPDATE public.playlist_targets
   SET curator_instagram = NULL,
       contact_confidence = CASE
         WHEN curator_email IS NOT NULL THEN contact_confidence
         ELSE 0
       END,
       submission_method = CASE
         WHEN curator_email IS NOT NULL THEN 'email'
         WHEN curator_submission_url IS NOT NULL THEN 'web_form'
         ELSE 'none'
       END,
       last_enriched_at = NULL
 WHERE lower(curator_instagram) = 'spotify'
    OR lower(curator_instagram) LIKE 'spotify%'
    OR curator_instagram LIKE '%.%'
    OR lower(curator_instagram) IN ('instagram', 'meta', 'facebook', 'anchor', 'soundtrap');
