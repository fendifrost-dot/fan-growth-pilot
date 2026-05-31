/** Shared Resend payload defaults for curator/radio pitches (deliverability). */

export function pitchFromEmail(): string {
  const raw = (Deno.env.get("FROM_EMAIL") || "pitches@fendifrost.com").trim();
  return raw.includes("<") ? raw : raw;
}

export function pitchFromHeader(): string {
  const email = pitchFromEmail().replace(/^.*<([^>]+)>$/, "$1").trim() || pitchFromEmail();
  return `Fendi Frost <${email}>`;
}

/** Curator replies land on Fendi's primary inbox — improves trust signals vs. null reply-to. */
export function pitchReplyTo(): string | undefined {
  const v = (Deno.env.get("REPLY_TO_EMAIL") || "fendifrost@gmail.com").trim();
  return v || undefined;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Avoid "Submission:" cold-outreach framing in default subjects (spam heuristics). */
export function defaultPlaylistPitchSubject(trackName: string, playlistName?: string): string {
  const track = trackName.trim();
  const pl = (playlistName ?? "").trim();
  if (pl) return `Fendi Frost — ${track} for ${pl}`;
  return `Fendi Frost — ${track}`;
}

export function buildResendPitchPayload(opts: {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}): Record<string, unknown> {
  const text = opts.text.trim();
  const html = opts.html?.trim() || text.replace(/\n/g, "<br>");
  const payload: Record<string, unknown> = {
    from: pitchFromHeader(),
    to: opts.to,
    subject: opts.subject.trim(),
    text,
    html,
  };
  const replyTo = pitchReplyTo();
  if (replyTo) payload.reply_to = replyTo;
  return payload;
}

export async function sendResendEmail(
  opts: Parameters<typeof buildResendPitchPayload>[0],
): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return { ok: false, status: 500, error: "RESEND_API_KEY not configured" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildResendPitchPayload(opts)),
  });

  const raw = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: raw.slice(0, 500) };

  let id = "";
  try {
    const data = JSON.parse(raw) as { id?: string };
    id = data.id ?? "";
  } catch {
    id = "";
  }
  return { ok: true, id };
}
