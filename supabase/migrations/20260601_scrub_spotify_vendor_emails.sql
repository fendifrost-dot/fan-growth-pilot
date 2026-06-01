-- Documentation only — run in Lovable SQL Editor (paste; do not type UPDATE).
-- Clears curator emails grabbed from spotify.com / spotifyforvendors.com before denylist deploy.

UPDATE playlist_targets
SET
  curator_email = NULL,
  contact_confidence = NULL,
  submission_method = CASE
    WHEN submission_method = 'email' THEN 'none'
    ELSE submission_method
  END,
  updated_at = now()
WHERE curator_email IS NOT NULL
  AND (
    lower(split_part(curator_email, '@', 2)) = 'spotify.com'
    OR lower(split_part(curator_email, '@', 2)) = 'spotifyforvendors.com'
    OR lower(split_part(curator_email, '@', 2)) LIKE '%.spotify.com'
    OR lower(split_part(curator_email, '@', 2)) LIKE '%.spotifyforvendors.com'
  );
