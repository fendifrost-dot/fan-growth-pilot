/**
 * Pure Resend webhook decisions for playlist pitch bounces.
 * The provider id stored on pitch_log.resend_message_id is data.email_id.
 * data.message_id is the RFC Message-ID and does not match that column.
 * email.suppressed is a failed send: Resend never handed it to the recipient.
 * suppression.added is not applied here; email.bounced already covers that send,
 * and applying both would bump playlist_targets.bounce_count twice.
 */

export type DeliveryFailure = "bounce" | "complaint";

export function resendDeliveryFailure(type: string): DeliveryFailure | null {
  if (type === "email.bounced" || type === "email.suppressed") return "bounce";
  if (type === "email.complained") return "complaint";
  return null;
}

/** Resend email id, the value execute-pitch stores. Never the RFC Message-ID. */
export function resendProviderEmailId(data: Record<string, unknown> | null | undefined): string {
  return String(data?.email_id ?? "").trim();
}

export function resendRecipients(data: Record<string, unknown> | null | undefined): string[] {
  const to = data?.to ?? data?.email ?? [];
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

/** A bounce is not a delivery. Status and placement both say so, and the cooldown ends. */
export function pitchLogBouncePatch(): {
  status: "bounced";
  placement_status: "bounced";
  cooldown_until: null;
} {
  return { status: "bounced", placement_status: "bounced", cooldown_until: null };
}

function decodeWhsec(secret: string): Uint8Array<ArrayBuffer> | null {
  if (!secret.startsWith("whsec_")) return null;
  try {
    const bin = atob(secret.slice("whsec_".length));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Svix HMAC used by Resend. Returns false for a shared-password secret. */
export async function svixSignatureValid(opts: {
  secret: string;
  rawBody: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const keyBytes = decodeWhsec(opts.secret);
  if (!keyBytes || !opts.id || !opts.timestamp || !opts.signature) return false;
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - ts) > tolerance) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${opts.id}.${opts.timestamp}.${opts.rawBody}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  for (const part of opts.signature.split(" ")) {
    const sig = part.startsWith("v1,") ? part.slice(3) : "";
    if (sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

/**
 * Accept the legacy shared secret, or a Svix signature when the env secret is whsec_.
 * An empty expected secret keeps the previous open behavior for local functions
 * that have not set RESEND_WEBHOOK_SECRET.
 */
export async function authorizeResendWebhook(opts: {
  expectedSecret: string;
  providedSecret: string | null;
  rawBody: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  nowSeconds?: number;
}): Promise<boolean> {
  const expected = opts.expectedSecret.trim();
  if (!expected) return true;
  if (opts.providedSecret != null && opts.providedSecret === expected) return true;
  return await svixSignatureValid({
    secret: expected,
    rawBody: opts.rawBody,
    id: opts.svixId,
    timestamp: opts.svixTimestamp,
    signature: opts.svixSignature,
    nowSeconds: opts.nowSeconds,
  });
}
