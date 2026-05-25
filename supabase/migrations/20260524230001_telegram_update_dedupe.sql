-- =====================================================================
-- Telegram update_id dedupe ledger
--
-- Pattern mirrored from fendi-control-center's
--   20260406000000_telegram_webhook_idempotency.sql
--
-- Why: Telegram retries webhook delivery aggressively on any non-2xx (and
-- sometimes on flaky 2xx network conditions). Without dedupe, a single
-- /start could fire the welcome twice, or /stop could double-process and
-- corrupt unsubscribed_at.
--
-- The telegram-webhook edge function inserts the incoming update_id at the
-- top of the handler with ON CONFLICT DO NOTHING. If the insert returns
-- zero rows, the update has already been processed — respond 200 and skip.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.telegram_webhook_processed_updates (
  update_id   bigint NOT NULL PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.telegram_webhook_processed_updates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'telegram_webhook_processed_updates'
      AND policyname = 'service_role_all'
  ) THEN
    EXECUTE 'CREATE POLICY service_role_all
             ON public.telegram_webhook_processed_updates
             FOR ALL TO service_role
             USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMENT ON TABLE public.telegram_webhook_processed_updates IS
  'Telegram update_id dedupe ledger. Insert at top of telegram-webhook with ON CONFLICT DO NOTHING; if no row returned, skip processing. Cleanup not needed at our scale.';
