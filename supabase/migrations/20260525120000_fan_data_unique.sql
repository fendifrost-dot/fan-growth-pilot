-- Apply via Lovable migration tool (GitHub copy is for version control only).
-- Deduplicate platform stat rows, then enforce one row per artist + identifier.

-- Remove duplicate fan_data rows (keep latest updated_at per user/platform/fan_identifier)
DELETE FROM public.fan_data fd
USING (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, platform, fan_identifier
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      ) AS rn
    FROM public.fan_data
    WHERE fan_identifier IS NOT NULL
  ) ranked
  WHERE rn > 1
) dupes
WHERE fd.id = dupes.id;

CREATE UNIQUE INDEX IF NOT EXISTS fan_data_user_platform_identifier_uidx
  ON public.fan_data (user_id, platform, fan_identifier)
  WHERE fan_identifier IS NOT NULL;

COMMENT ON INDEX fan_data_user_platform_identifier_uidx IS
  'One platform stats row per artist (internal ops dashboard).';
