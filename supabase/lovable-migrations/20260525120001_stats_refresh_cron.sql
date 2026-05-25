-- Optional: pg_cron → refresh-platform-stats (internal stats pipeline).
-- REPLACE YOUR_STATS_CRON_SECRET before running in Lovable.
-- Requires extensions pg_cron + pg_net (already enabled in project).

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('refresh-platform-stats-daily');

SELECT cron.schedule(
  'refresh-platform-stats-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/refresh-platform-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-stats-cron-secret', 'YOUR_STATS_CRON_SECRET'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
