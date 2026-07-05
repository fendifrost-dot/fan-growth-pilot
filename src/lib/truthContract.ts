/**
 * Canonical ingest contract (frontend mirror). Keep identical to
 * supabase/functions/_shared/truth/truthContract.ts.
 */

export const CANONICAL_EVENT_TYPES = [
  "page_view",
  "link_click",
  "email_submit",
  "purchase",
  "telegram_signup_initiated",
  "telegram_signup_completed",
  "ig_engagement_received",
  "ig_autoreply_sent",
] as const;

export function isAllowedEventType(eventType: string): boolean {
  const t = eventType.toLowerCase();
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(t);
}

export function allowedEventTypesHint(): string {
  return CANONICAL_EVENT_TYPES.join(", ");
}
