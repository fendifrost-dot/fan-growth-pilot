/**
 * Provider email transport. Test mode never calls Resend.
 * Sent is only true after the provider accepts the payload.
 */
export type ProviderSendInput = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
};

export type ProviderSendResult =
  | { ok: true; id: string; raw: Record<string, unknown> }
  | { ok: false; status: number; error: string; retryable: boolean };

export function isProviderTestMode(): boolean {
  const flag = (Deno.env.get("AGH_PROVIDER_TEST_MODE") || Deno.env.get("AGH_TEST_MODE") || "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function sanitizeProviderError(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/re_[A-Za-z0-9]+/g, "[redacted]")
    .slice(0, 400);
}

export async function sendProviderEmail(
  input: ProviderSendInput,
): Promise<ProviderSendResult> {
  if (isProviderTestMode()) {
    const forced = (Deno.env.get("AGH_PROVIDER_FORCE_FAILURE") || "").trim();
    if (forced) {
      return {
        ok: false,
        status: 502,
        error: sanitizeProviderError(forced),
        retryable: true,
      };
    }
    return {
      ok: true,
      id: `test_${input.idempotencyKey || "msg"}`,
      raw: { test_mode: true, id: `test_${input.idempotencyKey || "msg"}` },
    };
  }

  const key = (Deno.env.get("RESEND_API_KEY") || "").trim();
  if (!key) {
    return { ok: false, status: 500, error: "RESEND_API_KEY not configured", retryable: false };
  }

  const fromRaw = (Deno.env.get("FROM_EMAIL") || "pitches@fendifrost.com").trim();
  const from = fromRaw.includes("<") ? fromRaw : `Fendi Frost <${fromRaw}>`;
  const replyTo = (Deno.env.get("REPLY_TO_EMAIL") || "replies@fendifrost.com").trim();
  const payload: Record<string, unknown> = {
    from,
    to: input.to,
    subject: input.subject.trim(),
    text: input.text,
    html: input.html?.trim() || input.text.replace(/\n/g, "<br>"),
  };
  if (replyTo) payload.reply_to = replyTo;
  if (input.attachments?.length) {
    payload.attachments = input.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      content_type: a.contentType || "application/octet-stream",
    }));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const rawText = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = { raw: rawText.slice(0, 200) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: sanitizeProviderError(rawText),
        retryable: res.status >= 500 || res.status === 429,
      };
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!id) {
      return {
        ok: false,
        status: 502,
        error: "provider accepted response without message id",
        retryable: true,
      };
    }
    return { ok: true, id, raw: parsed };
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: sanitizeProviderError(e instanceof Error ? e.message : String(e)),
      retryable: true,
    };
  }
}

export function outreachIdempotencyKey(parts: {
  kind: string;
  id: string;
  channel: string;
}): string {
  return `${parts.kind}:${parts.id}:${parts.channel}`;
}

/** UTF-8 → base64 for Resend attachments. Avoids deprecated unescape(). */
export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
