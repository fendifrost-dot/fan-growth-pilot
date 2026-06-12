// Target verification gate. Decides whether a scraped/discovered curator contact is
// safe to draft + send to, BEFORE an outreach_drafts row is ever created. Sending to
// junk (academic CVs, loan/real-estate info@ inboxes, fake .form TLDs, dev/test inboxes)
// hard-bounces and tanks playlists@fendifrost.com sender reputation — this stops it.
//
// Runtime note: Supabase Edge (Deno Deploy-style) does not reliably expose Deno.resolveDns,
// so MX resolution is done over DNS-over-HTTPS via fetch.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type VerifyVerdict = {
  ok: boolean;                 // true → auto_verified
  status: "auto_verified" | "unverified";
  reason: string;              // human-readable; stored in verification_notes
  domain: string | null;
};

// TLDs that never belong to a real mailbox. The MX check catches most junk, but these
// synthesized/placeholder TLDs (e.g. submissions+x@noreply.form) fail before any network call.
const INVALID_TLDS = new Set([
  "form", "local", "test", "example", "invalid", "localhost", "internal", "lan",
]);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

export function isValidEmailFormat(email: string): boolean {
  if (!EMAIL_RE.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;   // exactly one @, non-empty local
  const local = email.slice(0, at);
  if (local.length < 1 || local.length > 64) return false;
  return true;
}

export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

export function tld(domain: string): string {
  const parts = domain.split(".");
  return parts[parts.length - 1] ?? "";
}

// Root domain = last two labels (good enough for blocklist matching: city.ac.uk → ac.uk
// won't collapse correctly, so we also match the full domain and the registrable-ish root).
export function domainCandidates(domain: string): string[] {
  const parts = domain.split(".");
  const out = new Set<string>([domain]);
  if (parts.length >= 2) out.add(parts.slice(-2).join("."));
  if (parts.length >= 3) out.add(parts.slice(-3).join("."));   // handles ac.uk / co.uk style
  return [...out];
}

export function isInvalidTld(domain: string): boolean {
  const t = tld(domain);
  if (!t || !/^[a-z]{2,24}$/.test(t)) return true;             // numeric/empty/garbage TLD
  return INVALID_TLDS.has(t);
}

// MX lookup over DNS-over-HTTPS (Google public resolver, dns-json). Returns true only when
// the domain advertises at least one MX record (type 15).
export async function hasMxRecord(domain: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!res.ok) return false;
    const data = await res.json() as { Status?: number; Answer?: { type: number }[] };
    if (data.Status !== 0) return false;
    return (data.Answer ?? []).some((a) => a.type === 15);
  } catch (e) {
    console.warn(`hasMxRecord: DoH lookup failed for ${domain}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

async function isBlockedDomain(sb: SupabaseClient, candidates: string[]): Promise<string | null> {
  const { data: blocked } = await sb.from("domain_blocklist").select("domain, reason").in("domain", candidates);
  if (blocked?.length) return `blocklisted (${blocked[0].reason})`;
  const { data: nonCurator } = await sb.from("non_curator_domains").select("domain, category").in("domain", candidates);
  if (nonCurator?.length) return `known non-curator domain (${nonCurator[0].category ?? "manual"})`;
  return null;
}

/**
 * Auto-verify a single email. Passes ALL checks → auto_verified, else unverified with a reason.
 * `bounceCount` is the target's current bounce_count (>= 2 fails).
 */
export async function verifyEmail(
  sb: SupabaseClient,
  rawEmail: string | null | undefined,
  bounceCount = 0,
): Promise<VerifyVerdict> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!email) return { ok: false, status: "unverified", reason: "no email on file", domain: null };
  if (!isValidEmailFormat(email)) return { ok: false, status: "unverified", reason: "invalid email format", domain: null };

  const domain = domainOf(email);
  if (!domain) return { ok: false, status: "unverified", reason: "no domain", domain: null };
  if (isInvalidTld(domain)) return { ok: false, status: "unverified", reason: `invalid TLD .${tld(domain)}`, domain };
  if (bounceCount >= 2) return { ok: false, status: "unverified", reason: `bounced ${bounceCount}×`, domain };

  const candidates = domainCandidates(domain);
  const blockReason = await isBlockedDomain(sb, candidates);
  if (blockReason) return { ok: false, status: "unverified", reason: blockReason, domain };

  if (!(await hasMxRecord(domain))) return { ok: false, status: "unverified", reason: "no MX record (won't receive mail)", domain };

  return { ok: true, status: "auto_verified", reason: "passed format/TLD/MX/blocklist checks", domain };
}

export const VERIFIED_STATUSES = ["auto_verified", "manually_verified"] as const;

// A draftable target is one whose verification has passed. `undefined` (column not yet
// deployed) is treated as draftable so the gate is a no-op until the migration + backfill land.
export function isDraftable(verificationStatus: string | null | undefined): boolean {
  if (verificationStatus === undefined || verificationStatus === null) return true;
  return (VERIFIED_STATUSES as readonly string[]).includes(verificationStatus);
}
