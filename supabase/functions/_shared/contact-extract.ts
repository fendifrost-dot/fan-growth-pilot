const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMOJI_EMAIL_RE = /(?:📩|✉️|📧|📨|📮|📬|📭|📤)\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MAILTO_RE = /href=["']mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
const LINKTREE_URL_RE =
  /\b(?:https?:\/\/)?(?:linktr\.ee|linktree\.com|beacons\.ai|lnk\.bio|allmylinks\.com|carrd\.co|bio\.link)\/[A-Za-z0-9._\-\/]+/gi;

const EMAIL_DENYLIST = new Set([
  "support@spotify.com",
  "press@spotify.com",
  "privacy@spotify.com",
  "help@instagram.com",
  "press@instagram.com",
  "noreply@instagram.com",
]);

/** Domain suffixes — subdomains match (e.g. vendor.spotify.com). */
const EMAIL_DOMAIN_DENYLIST = [
  // Platform / vendor-form domains
  "spotify.com",
  "spotifyforvendors.com",
  "graphiteconnect.com",
  "anonaddy.com",
  "noreply.form",
  // SaaS / analytics / non-curator companies that scraping mistakes for curators.
  // (DB-driven non_curator_domains/domain_blocklist is the authoritative list at
  //  send time; this in-code set blocks the most common offenders at WRITE time so
  //  junk like a music-analytics SaaS address never lands in curator_email.)
  "viberate.com",
  "chartmetric.com",
  "soundcharts.com",
  "songstats.com",
  "submithub.com",
  "groover.co",
  "playlistpush.com",
  "daotao.com",
  "linktr.ee",
  "beacons.ai",
  "hubspot.com",
  "mailchimp.com",
  "intercom.io",
  "zendesk.com",
  "squarespace.com",
  "wixpress.com",
  "shopify.com",
  "stripe.com",
  "sentry.io",
  "wordpress.com",
  "gmail.example",
];

/**
 * Academic / government / institutional TLD suffixes — these are never independent
 * playlist curators. A university `.edu` mailbox or a `.gov` inbox scraped off a
 * page is junk and tanks sender reputation when pitched.
 */
const NON_CURATOR_TLD_SUFFIXES = [
  ".edu",
  ".gov",
  ".mil",
  ".ac.uk",
  ".edu.au",
  ".edu.in",
  ".ac.in",
  ".ac.jp",
  ".gov.uk",
  ".edu.cn",
  ".sch.uk",
  ".k12.",
];

/** Local-part prefixes that mark an email as vendor-form / non-human / wrong-role. */
const EMAIL_LOCAL_PREFIX_DENYLIST = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "postmaster",
  "abuse",
  "webmaster",
  "hostmaster",
];

/**
 * Role local-parts that belong to non-curator business functions. These are NOT
 * the music-contact roles (submissions@, demos@, music@, hello@, info@, contact@,
 * pitch@, management@, booking@, press@) which are GOOD for curator outreach — so
 * those are deliberately excluded here.
 */
const NON_CURATOR_ROLE_LOCALS = new Set([
  "sales",
  "billing",
  "invoices",
  "accounts",
  "accounting",
  "careers",
  "jobs",
  "recruiting",
  "hr",
  "legal",
  "privacy",
  "compliance",
  "security",
  "admin",
  "administrator",
  "it",
  "helpdesk",
  "support",
  "customerservice",
  "orders",
  "returns",
  "marketing",
  "advertising",
  "ads",
  "partnerships",
  "investors",
  "media",
  "newsletter",
  "subscribe",
  "unsubscribe",
]);

function hasNonCuratorTld(domain: string): boolean {
  return NON_CURATOR_TLD_SUFFIXES.some((s) =>
    s.endsWith(".") ? domain.includes(s) : domain === s.slice(1) || domain.endsWith(s),
  );
}

function isDeniedEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (EMAIL_DENYLIST.has(lower)) return true;
  const [local, domain] = lower.split("@");
  if (!domain) return false;
  if (EMAIL_LOCAL_PREFIX_DENYLIST.some((p) => local === p || local.startsWith(p + "."))) {
    return true;
  }
  if (NON_CURATOR_ROLE_LOCALS.has(local)) return true;
  if (hasNonCuratorTld(domain)) return true;
  return EMAIL_DOMAIN_DENYLIST.some(
    (suffix) => domain === suffix || domain.endsWith("." + suffix),
  );
}

/**
 * Public predicate: true when an email must NEVER be saved as a curator contact
 * (academic/gov TLD, SaaS/analytics company, vendor form, or non-curator role).
 * Used as the write-time denylist gate in enrichment.
 */
export function isNonCuratorEmail(email: string | null | undefined): boolean {
  if (!email?.trim()) return true;
  return isDeniedEmail(email.trim().toLowerCase());
}

/** Source URLs that should be skipped before scraping (vendor forms etc.). */
export const SOURCE_URL_DOMAIN_DENYLIST = [
  "spotifyforvendors.com",
  "spotify.com",
  "graphiteconnect.com",
];

export function isDeniedSourceUrl(url: string): boolean {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return SOURCE_URL_DOMAIN_DENYLIST.some(
      (suffix) => host === suffix || host.endsWith("." + suffix),
    );
  } catch {
    return false;
  }
}

export const IG_HANDLE_DENYLIST = new Set([
  "spotify",
  "spotifyusa",
  "spotify_uk",
  "spotifycanada",
  "spotify_latam",
  "spotifyfrance",
  "spotifydeutschland",
  "spotifyjp",
  "spotifykorea",
  "spotifybrasil",
  "instagram",
  "meta",
  "facebook",
  "anchor",
  "soundtrap",
  "about",
  "explore",
  "reel",
  "reels",
  "stories",
  "p",
  "accounts",
  "share",
  "tags",
  "direct",
  "tv",
  "developer",
  "press",
  "help",
  "policy",
  "legal",
  "terms",
  "privacy",
  "safety",
  "settings",
  "popular",
]);

const IG_URL_RE = /(?:^|\/\/|\.)instagram\.com\/([A-Za-z0-9._]{2,30})(?:\/|\?|$)/i;

export type EmailHit = { value: string; source: "mailto" | "text" | "emoji" };

export function extractEmails(text: string, html?: string): EmailHit[] {
  const out: EmailHit[] = [];
  const seen = new Set<string>();
  const add = (v: string, source: EmailHit["source"]) => {
    const lower = v.toLowerCase();
    if (isDeniedEmail(lower) || seen.has(lower)) return;
    seen.add(lower);
    out.push({ value: lower, source });
  };
  if (html) {
    for (const m of html.matchAll(MAILTO_RE)) add(m[1], "mailto");
  }
  for (const m of text.matchAll(EMOJI_EMAIL_RE)) add(m[1], "emoji");
  for (const m of text.matchAll(EMAIL_RE)) add(m[0], "text");
  return out;
}

export function extractLinktreeUrls(text: string): string[] {
  const matches = text.match(LINKTREE_URL_RE) ?? [];
  return [...new Set(matches.map((u) => (u.startsWith("http") ? u : `https://${u}`)))];
}

/** Extract curator IG handle from a URL; rejects Spotify/page-chrome handles. */
export function extractIgHandle(url: string): string | null {
  const m = url.match(IG_URL_RE);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (handle.includes(".")) return null;
  if (IG_HANDLE_DENYLIST.has(handle)) return null;
  if (/^spotify/i.test(handle)) return null;
  return m[1];
}

/** @deprecated Use extractIgHandle */
export function parseInstagramHandle(link: string): string | null {
  return extractIgHandle(link);
}

/** Validate a stored or candidate IG handle (not a full URL). */
export function isValidCuratorIgHandle(handle: string | null | undefined): boolean {
  if (!handle?.trim()) return false;
  const clean = handle.replace(/^@/, "").trim();
  const lower = clean.toLowerCase();
  if (IG_HANDLE_DENYLIST.has(lower)) return false;
  if (/^spotify/i.test(lower)) return false;
  if (lower.includes(".")) return false;
  if (!/^[A-Za-z0-9._]{2,30}$/.test(clean)) return false;
  return extractIgHandle(`https://www.instagram.com/${clean}/`) !== null;
}

/** Normalize handle for DB storage; returns null if invalid. */
export function sanitizeCuratorIgHandle(handle: string | null | undefined): string | null {
  if (!handle?.trim()) return null;
  const fromUrl = extractIgHandle(handle.trim());
  const raw = (fromUrl ?? handle.replace(/^@/, "").trim());
  return isValidCuratorIgHandle(raw) ? raw : null;
}

export function extractSubmissionDM(text: string): string | null {
  const re = /(?:for\s+submissions?|send\s+demos?|pitch(?:es)?|submit(?:\s+via)?)[^@]{0,80}@([A-Za-z0-9._]{2,30})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = m[1].toLowerCase();
    if (IG_HANDLE_DENYLIST.has(h) || /^spotify/i.test(h)) continue;
    if (extractIgHandle(`https://www.instagram.com/${m[1]}/`)) return `@${m[1]}`;
  }
  return null;
}

export function extractSubmissionNote(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0 && t.length < 200 && /\b(submit|submission|pitch|demos?)\b/i.test(t)) {
      return t;
    }
  }
  return null;
}

export function extractSubmissionLinkFromMarkdown(md: string): string | null {
  const m = md.match(/\[([^\]]*?(?:submit|submission|pitch|demos?)[^\]]*?)\]\(([^)]+)\)/i);
  return m?.[2] ?? null;
}

export function confidenceForEmailSource(source: EmailHit["source"]): number {
  if (source === "mailto") return 7;
  if (source === "emoji") return 6;
  return 6;
}

export function scoreHunterEmail(e: { value: string; type?: string; first_name?: string }): number {
  let s = 0;
  const local = e.value.split("@")[0].toLowerCase();
  if (/^(submissions?|demos?|music|pitch|hello|info|contact|management|press)$/.test(local)) s += 50;
  if (e.type === "generic") s += 10;
  if (e.first_name) s -= 5;
  return s;
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "gmx.com", "mail.com", "zoho.com",
]);

function nameTokens(...parts: Array<string | null | undefined>): string[] {
  return parts
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["the", "and", "playlist", "music", "official", "spotify"].includes(t));
}

/**
 * Curator-name / handle proximity score for a candidate email.
 *
 *   2  → domain (or its root label) clearly belongs to the curator
 *        (e.g. curator runs example.com and email is x@example.com, or the
 *         local-part / domain contains a curator name or IG-handle token)
 *   1  → local-part is a music-contact role (submissions@, demos@, hello@…),
 *        which is acceptable even without a name match
 *   0  → free-mail or unrelated domain with no name/handle relationship
 *
 * Higher is better; enrichment requires a minimum combined (source + proximity)
 * signal before it will save curator_email.
 */
export function emailProximityScore(
  email: string,
  ctx: {
    curatorName?: string | null;
    playlistName?: string | null;
    igHandle?: string | null;
    website?: string | null;
  },
): number {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split("@");
  if (!local || !domain) return 0;
  const domainRoot = domain.split(".").slice(-2, -1)[0] ?? "";
  const tokens = new Set(nameTokens(ctx.curatorName, ctx.playlistName));
  const handle = (ctx.igHandle ?? "").replace(/^@/, "").toLowerCase();
  if (handle && handle.length >= 3) tokens.add(handle);

  // Curator's own website domain → strong signal.
  if (ctx.website) {
    try {
      const wHost = new URL(ctx.website.startsWith("http") ? ctx.website : `https://${ctx.website}`)
        .hostname.replace(/^www\./, "").toLowerCase();
      if (wHost === domain || domain.endsWith("." + wHost) || wHost.endsWith("." + domain)) return 2;
    } catch { /* ignore */ }
  }

  // Token appears in the (non-free) domain or in the local-part.
  if (!FREE_EMAIL_DOMAINS.has(domain)) {
    for (const t of tokens) {
      if (domainRoot.includes(t) || t.includes(domainRoot)) return 2;
    }
  }
  for (const t of tokens) {
    if (local.includes(t) || (t.length >= 4 && t.includes(local))) return 2;
  }

  // Music-contact role local-part is acceptable without a name match.
  if (/^(submissions?|demos?|music|pitch|hello|info|contact|management|booking|press|playlist)/.test(local)) {
    return 1;
  }
  return 0;
}

/**
 * Detect whether a curator charges a placement fee from scraped page text.
 * Returns 'paid' | 'free' | 'tip_appreciated' | null (unknown). Conservative:
 * only returns non-null on an explicit signal.
 */
export function detectSubmissionCost(
  text: string | null | undefined,
): "paid" | "free" | "tip_appreciated" | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // Explicit paid / placement-fee language.
  const paid =
    /\$\s?\d|€\s?\d|£\s?\d|\d+\s?(?:usd|eur|gbp)\b/.test(t) &&
      /(submission|placement|playlist|consider|review|feature|guarantee)/.test(t)
      ? true
      : /\b(paid|premium)\s+(?:submission|placement|playlist|promo|promotion)\b/.test(t) ||
        /\b(placement|submission)\s+fee\b/.test(t) ||
        /\bpay\s+(?:to|for)\s+(?:submit|placement|play|feature)\b/.test(t) ||
        /\bper\s+(?:placement|track|song)\b.*\$/.test(t) ||
        /\bguaranteed\s+placement\b/.test(t);
  if (paid) return "paid";

  // Tip / donation appreciated but not required.
  if (/\b(tip|donation|paypal|venmo|cash\s?app|ko-?fi|buy\s+me\s+a\s+coffee)\b/.test(t) &&
      /\b(optional|appreciated|welcome|no\s+(?:fee|charge)|free)\b/.test(t)) {
    return "tip_appreciated";
  }

  // Explicit free / no-fee language.
  if (/\b(free\s+submissions?|no\s+(?:fee|charge|payment|cost)|submit\s+for\s+free|always\s+free)\b/.test(t)) {
    return "free";
  }
  return null;
}

