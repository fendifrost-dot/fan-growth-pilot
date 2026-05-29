-- Documentation only — run in Lovable SQL Editor after deploying IG handle fix (CURSOR_HANDOFF_FIX_IG_SCOPE)

-- 1) Inspect corrupted handles
SELECT playlist_id, curator_name, playlist_name, curator_instagram
  FROM public.playlist_targets
 WHERE lower(curator_instagram) = 'spotify'
    OR lower(curator_instagram) LIKE 'spotify%'
    OR curator_instagram IN ('instagram', 'meta', 'facebook', 'anchor', 'soundtrap')
    OR curator_instagram LIKE '%.%';

-- Known live damage (2026-05-29): Electronic Chill & Deep House, Fruits Music → 'spotify';
-- Daily Rap Facts / Rap Bops → 'dailyrapfacts.com'

-- 2) Clear bad handles and allow re-enrichment
UPDATE public.playlist_targets
   SET curator_instagram = NULL,
       contact_confidence = CASE
         WHEN curator_email IS NOT NULL THEN contact_confidence
         WHEN curator_email IS NULL AND curator_instagram IS NOT NULL THEN 0
         ELSE contact_confidence
       END,
       submission_method = CASE
         WHEN curator_email IS NOT NULL THEN 'email'
         WHEN curator_submission_url IS NOT NULL THEN 'web_form'
         ELSE 'none'
       END,
       last_enriched_at = NULL
 WHERE lower(curator_instagram) = 'spotify'
    OR lower(curator_instagram) LIKE 'spotify%'
    OR curator_instagram IN ('instagram', 'meta', 'facebook', 'anchor', 'soundtrap')
    OR curator_instagram LIKE '%.%';
