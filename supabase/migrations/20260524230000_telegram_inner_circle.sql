-- =====================================================================
-- Inner Circle — Telegram DM-broadcast infrastructure (v1)
--
-- Strategy doc: ~/Documents/Claude/Projects/Fan Fuel Hub/INNER_CIRCLE_MARKETING_TECHNIQUE.md
-- CC reconciliation: ~/Documents/Claude/Projects/Fan Fuel Hub/CC_RECONCILIATION.md
--
-- Design decisions reflected here:
--   1. Separate tables (telegram_subscribers, telegram_sends) rather than
--      extending email_contacts. Reason: email_contacts.email is NOT NULL
--      in production, but Telegram-first subscribers may not give email.
--      We FK to email_contacts when the same fan has both identities.
--   2. Mirrors the production email pattern (email_contacts / email_sends /
--      email_campaigns) so admin queries can be written symmetrically.
--   3. All operations from a NEW bot (do NOT reuse fendi-control-center's
--      FendiAIbot). Bot username is recorded in env, not in DB.
-- =====================================================================

-- ---------------------------------------------------------------------
-- telegram_subscribers — the Inner Circle roster
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_subscribers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id    text NOT NULL UNIQUE,
  telegram_username   text,
  first_name          text,
  language_code       text,
  contact_id          uuid REFERENCES public.email_contacts(id) ON DELETE SET NULL,
  source_smart_link   text,
  subscribed          boolean NOT NULL DEFAULT true,
  subscribed_at       timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at     timestamptz,
  block_count         integer NOT NULL DEFAULT 0,
  metadata            jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_subscribers_subscribed_idx
  ON public.telegram_subscribers (subscribed) WHERE subscribed = true;

CREATE INDEX IF NOT EXISTS telegram_subscribers_source_idx
  ON public.telegram_subscribers (source_smart_link);

CREATE INDEX IF NOT EXISTS telegram_subscribers_contact_idx
  ON public.telegram_subscribers (contact_id) WHERE contact_id IS NOT NULL;

COMMENT ON TABLE  public.telegram_subscribers IS
  'Inner Circle DM-broadcast roster. One row per unique Telegram chat_id. FK to email_contacts populated when the same fan signs up with email too.';
COMMENT ON COLUMN public.telegram_subscribers.block_count IS
  'Number of 403 Forbidden responses observed on send. Auto-flips subscribed=false on first 403.';

-- ---------------------------------------------------------------------
-- telegram_signup_tokens — one-time deep-link tokens
-- ---------------------------------------------------------------------
-- Flow:
--   1. Fan clicks the canonical Inner Circle URL (e.g.
--      links.fendifrost.com/inner-circle or a smart link's /telegram variant)
--   2. telegram-signup-redirect edge function inserts a row here with full
--      UTM + Meta cookie attribution payload
--   3. Edge function 302 redirects to t.me/<bot>?start=<token>
--   4. Bot webhook consumes the token, links the chat_id to a
--      telegram_subscribers row, marks consumed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_signup_tokens (
  token               text PRIMARY KEY,
  smart_link_slug     text,
  email               text,
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  fbclid              text,
  meta_fbp            text,
  meta_fbc            text,
  user_agent          text,
  ip_hash             text,
  metadata            jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  consumed_at         timestamptz,
  consumed_chat_id    text,
  consumed_subscriber_id uuid REFERENCES public.telegram_subscribers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS telegram_signup_tokens_unconsumed_idx
  ON public.telegram_signup_tokens (created_at) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS telegram_signup_tokens_smart_link_idx
  ON public.telegram_signup_tokens (smart_link_slug, created_at);

COMMENT ON TABLE public.telegram_signup_tokens IS
  'One-time tokens bridging smart-link click to Telegram /start. 24h expiry. Captures full attribution payload at click time so it survives the t.me detour.';

-- ---------------------------------------------------------------------
-- telegram_sends — truth-layer log for every Bot API sendMessage call
-- Mirror of email_sends, scoped to Telegram.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  subscriber_id       uuid REFERENCES public.telegram_subscribers(id) ON DELETE SET NULL,
  recipient_chat_id   text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued','sent','failed','skipped','dry_run')),
  telegram_message_id text,
  error_code          text,        -- e.g. 'telegram_403_blocked', 'telegram_429_rate_limited'
  error_message       text,
  test_send           boolean NOT NULL DEFAULT false,
  batch_label         text,
  metadata            jsonb DEFAULT '{}'::jsonb,
  sent_at             timestamptz NOT NULL DEFAULT now()
);

-- Don't double-send the same campaign to the same subscriber for real sends.
CREATE UNIQUE INDEX IF NOT EXISTS telegram_sends_campaign_subscriber_real_uidx
  ON public.telegram_sends (campaign_id, subscriber_id)
  WHERE test_send = false AND status = 'sent';

CREATE INDEX IF NOT EXISTS telegram_sends_campaign_status_idx
  ON public.telegram_sends (campaign_id, status, sent_at DESC);

CREATE INDEX IF NOT EXISTS telegram_sends_recipient_idx
  ON public.telegram_sends (recipient_chat_id);

CREATE INDEX IF NOT EXISTS telegram_sends_error_code_idx
  ON public.telegram_sends (error_code) WHERE error_code IS NOT NULL;

COMMENT ON TABLE public.telegram_sends IS
  'Mirror of email_sends, scoped to Telegram. Campaign_id is shared with email so one campaign can cover multiple channels.';

-- ---------------------------------------------------------------------
-- touch_updated_at trigger (reuses the function from email_campaign_backend)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS telegram_subscribers_updated ON public.telegram_subscribers;
CREATE TRIGGER telegram_subscribers_updated
BEFORE UPDATE ON public.telegram_subscribers
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Reporting views
-- Strategic constraint: every dashboard metric must trace to a real row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.telegram_inner_circle_stats AS
SELECT
  (SELECT count(*) FROM public.telegram_subscribers
     WHERE subscribed = true)                                          AS subscribers_active,
  (SELECT count(*) FROM public.telegram_subscribers
     WHERE subscribed_at >= now() - interval '7 days')                 AS subscribers_added_7d,
  (SELECT count(*) FROM public.telegram_subscribers
     WHERE subscribed_at >= now() - interval '30 days')                AS subscribers_added_30d,
  (SELECT count(*) FROM public.telegram_sends
     WHERE status = 'sent' AND test_send = false
       AND sent_at >= now() - interval '30 days')                      AS sends_succeeded_30d,
  (SELECT count(*) FROM public.telegram_sends
     WHERE status = 'failed' AND test_send = false
       AND sent_at >= now() - interval '30 days')                      AS sends_failed_30d,
  (SELECT count(*) FROM public.telegram_sends
     WHERE error_code = 'telegram_403_blocked' AND test_send = false
       AND sent_at >= now() - interval '30 days')                      AS blocks_30d;

COMMENT ON VIEW public.telegram_inner_circle_stats IS
  'Inner Circle dashboard metrics. Each value is a SELECT from a real table. No inferred or estimated numbers.';

CREATE OR REPLACE VIEW public.telegram_campaign_send_summary AS
SELECT
  campaign_id,
  min(sent_at)                                          AS first_attempt_at,
  max(sent_at)                                          AS last_attempt_at,
  count(*) FILTER (WHERE status = 'sent' AND test_send = false)  AS sent_count,
  count(*) FILTER (WHERE status = 'failed' AND test_send = false) AS failed_count,
  count(*) FILTER (WHERE error_code = 'telegram_403_blocked')    AS blocked_count
FROM public.telegram_sends
GROUP BY campaign_id
ORDER BY max(sent_at) DESC NULLS LAST;

-- ---------------------------------------------------------------------
-- Audience helper: subscribers grouped by source_smart_link
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.telegram_subscribers_by_source AS
SELECT
  COALESCE(source_smart_link, '(unknown)') AS source_smart_link,
  count(*) FILTER (WHERE subscribed = true)  AS active_subscribers,
  count(*) FILTER (WHERE subscribed = false) AS unsubscribed,
  count(*)                                    AS total
FROM public.telegram_subscribers
GROUP BY source_smart_link
ORDER BY active_subscribers DESC;
