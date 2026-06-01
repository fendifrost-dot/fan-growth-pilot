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
  "spotify.com",
  "spotifyforvendors.com",
  "noreply.form",
];

function isDeniedEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (EMAIL_DENYLIST.has(lower)) return true;
  const domain = lower.split("@")[1] ?? "";
  if (!domain) return false;
  return EMAIL_DOMAIN_DENYLIST.some(
    (suffix) => domain === suffix || domain.endsWith("." + suffix),
  );
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
