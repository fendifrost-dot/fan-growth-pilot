/**
 * Sync pay-to-play gate. Reuses the playlist positive-fee helper.
 * Unknown and blank terms are not a hold. A recorded fee, a pay-to-play mark,
 * or a paid submission host is.
 * Taxi, MusicXray, Broadjam, and Songtradr paid tiers are sync-only additions
 * so playlist matching stays unchanged.
 */
import { submissionFeeBlocker, textHasSubmissionFee } from "./pre-send-gate.ts";
import { hostOf } from "./submission-route.ts";

const SYNC_PAID_HOSTS = ["taxi.com", "musicxray.com", "broadjam.com"];
const PAY_TO_PLAY = /\bpay[\s-]*to[\s-]*play\b/i;
const CLAUSE_NEGATION =
  /\b(?:no|not|none|without|never|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t)\b|different\s+curator|none\s+found|not\s+found|no\s+listing/i;
const SONGTRADR_PAID =
  /\b(?:premium|pro)\s+tier\b|\bpaid\s+tier\b|\bbuy\s+credits\b|\bcredits\s+(?:required|to\s+submit)\b|\bsubmission\s+fee\b|\bpay[\s-]*to[\s-]*submit\b/i;

export type SyncFeeInput = {
  submission_policy?: unknown;
  compensation_known?: unknown;
  compensation_public?: unknown;
  source_evidence?: unknown;
  submission_requirements?: unknown;
  official_url?: unknown;
  primary_source_url?: unknown;
  verified_contact_path?: unknown;
  company_name?: unknown;
  contact_channel?: unknown;
};

export type SyncFeeDecision = { blocked: boolean; detail: string | null };

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function hostMatches(raw: string, domains: readonly string[]): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  const host = hostOf(trimmed) || hostOf(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function emailDomain(raw: string): string {
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1 || raw.includes(" ")) return "";
  return raw.slice(at + 1);
}

/** Enum-like cost only. Free-text commission is not a submission cost. */
function normalizedCost(policy: string, compensation: string): string {
  const policyKey = policy.toLowerCase();
  const comp = compensation.toLowerCase();
  if (policyKey === "free" || policyKey.startsWith("free_") || policyKey.startsWith("free ")) return "free";
  if (comp === "free" || comp.startsWith("free ") || comp.startsWith("free_")) return "free";
  if (policyKey === "paid" || policyKey === "pay_to_play" || policyKey === "paid_submission" || policyKey === "fee_required") {
    return "paid";
  }
  if (comp === "paid" || comp === "pay_to_play" || comp === "tip_appreciated") return comp;
  if (!comp || comp === "unknown" || comp === "n/a" || comp === "none") return "unknown";
  return "";
}

function clauseHas(pattern: RegExp, value: string): boolean {
  for (const clause of value.split(/[.;\n]+/)) {
    if (!pattern.test(clause)) continue;
    if (CLAUSE_NEGATION.test(clause)) continue;
    return true;
  }
  return false;
}

export function syncPositiveFee(input: SyncFeeInput): SyncFeeDecision {
  const policy = text(input.submission_policy);
  const compensation = text(input.compensation_known || input.compensation_public);
  const evidence = [
    text(input.source_evidence),
    text(input.submission_requirements),
    compensation,
    policy,
  ].filter(Boolean).join("\n");
  const urls = [text(input.official_url), text(input.primary_source_url), text(input.verified_contact_path)];
  const contact = text(input.verified_contact_path);
  const cost = normalizedCost(policy, compensation);
  const playlistBlock = submissionFeeBlocker({
    submission_cost: cost || "unknown",
    pitch_status: policy.toLowerCase() === "pay_to_play" ? "pay_to_play" : "",
    fraud_verdict: "",
    form_cost: "",
    submission_method: text(input.contact_channel),
    form_url: text(input.official_url),
    submission_url: contact.startsWith("http") ? contact : text(input.primary_source_url),
    curator_website: text(input.primary_source_url) || text(input.official_url),
    curator_email: contact.includes("@") ? contact : "",
    form_source_evidence: evidence,
    notes: text(input.company_name),
  });
  if (playlistBlock) return { blocked: true, detail: playlistBlock };

  for (const url of urls) {
    if (hostMatches(url, SYNC_PAID_HOSTS)) return { blocked: true, detail: "sync_paid_platform" };
    if (hostMatches(url, ["patreon.com"])) return { blocked: true, detail: "paid_patreon" };
  }
  const domain = emailDomain(contact);
  if (domain && hostMatches(domain, SYNC_PAID_HOSTS)) return { blocked: true, detail: "sync_paid_platform" };
  if (domain && hostMatches(domain, ["patreon.com"])) return { blocked: true, detail: "paid_patreon" };

  if (clauseHas(PAY_TO_PLAY, evidence)) return { blocked: true, detail: "pay_to_play" };
  if (clauseHas(/\bpaid\s+patreon\b/i, evidence)) return { blocked: true, detail: "paid_patreon" };
  if (/songtradr/i.test(evidence) || urls.some((url) => hostMatches(url, ["songtradr.com"]))) {
    if (clauseHas(SONGTRADR_PAID, evidence) || textHasSubmissionFee(evidence)) {
      return { blocked: true, detail: "songtradr_paid_tier" };
    }
  }
  return { blocked: false, detail: null };
}

/** What a successful sync send records. Paid rows never reach a send. */
export function syncTermsStatusAtSend(input: SyncFeeInput | null | undefined): "free" | "unknown" {
  const policy = text(input?.submission_policy).toLowerCase();
  const compensation = text(input?.compensation_known || input?.compensation_public).toLowerCase();
  if (
    policy === "free" ||
    policy.startsWith("free_") ||
    policy.startsWith("free ") ||
    compensation === "free" ||
    compensation.startsWith("free ") ||
    compensation.startsWith("free_")
  ) {
    return "free";
  }
  return "unknown";
}

export const SYNC_FEE_CLEAR = "no_positive_fee" as const;
