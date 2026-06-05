/**
 * curator-strategies.ts — Discrete curator-email discovery strategies.
 *
 * Each strategy is a pure-ish async function over an EnrichmentContext that
 * either returns a verified email + confidence + source attribution, or null
 * (meaning "I tried, nothing surfaced; chain should try the next strategy").
 *
 * The caller (runEnrichCuratorContacts) chains them in priority order,
 * short-circuits on the first plausible hit, and records an audit trail of
 * everything attempted in `playlist_targets.research_context` JSONB.
 *
 * No LinkedIn. No Hunter.io. No new paid APIs. Firecrawl (`/v1/scrape` +
 * `/v1/search`) is the only outbound dependency, and it was already on the
 * stack before this module was added.
 */

import { firecrawlScrape, firecrawlMarkdown, firecrawlSearch } from "./firecrawl.ts";
import { extractEmails, extractLinktreeUrls, isDeniedSourceUrl, type EmailHit } from "./contact-extract.ts";

/** Row shape we care about (subset of playlist_targets). */
export type CuratorRow = Record<string, unknown> & {
  playlist_id: string;
  platform?: string;
  playlist_name?: string | null;
  curator_name?: string | null;
  curator_instagram?: string | null;
  curator_twitter?: string | null;
  curator_tiktok?: string | null;
  curator_linktree?: string | null;
  curator_website?: string | null;
  curator_submission_url?: string | null;
  submission_url?: string | null;
  notes?: string | null;
  research_context?: Record<string, unknown> | null;
};

export type StrategyResult = {
  email: string;
  source: string;
  source_url?: string;
  confidence: number;
};

export type AttemptLog = {
  strategy: string;
  status: "found" | "not_found" | "skipped" | "error";
  detail?: string;
  source_url?: string;
  ms: number;
};

export type EnrichmentContext = {
  row: CuratorRow;
  /** Spotify playlist ID without the `spotify:` prefix, if known. */
  spotifyPlaylistId: string | null;
  /** Spotify user ID of the playlist owner, if known. */
  spotifyOwnerId: string | null;
  /** Accumulator: URLs surfaced across strategies (bio links, linktree fan-out, etc.). */
  discoveredUrls: Set<string>;
  /** Accumulator: handles surfaced per-platform. */
  discoveredHandles: Map<string, string>;
  /** Caching: avoid re-scraping the same playlist page. */
  cachedPlaylistMarkdown?: string;
  cachedOwnerMarkdown?: string;
  cachedOwnerBioLinks?: string[];
  /** Audit trail; strategies push entries here. */
  attempts: AttemptLog[];
  /** Strategies we've already tried (for de-dup). */
  triedStrategies: Set<string>;
};

// ------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------

const STRICT_NOISE_EMAIL = new Set<string>([
  "support@spotify.com",
  "press@spotify.com",
  "privacy@spotify.com",
  "help@instagram.com",
  "press@instagram.com",
  "noreply@instagram.com",
  "support@twitter.com",
  "press@twitter.com",
  "support@x.com",
  "press@x.com",
  "press@tiktok.com",
  "creators@tiktok.com",
  "support@tiktok.com",
  "wordpress@wordpress.com",
  "press@google.com",
  "support@google.com",
  "press@apple.com",
  "support@youtube.com",
  "press@meta.com",
  "press@facebook.com",
]);

const NOISE_LOCAL_PREFIXES = ["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon"];

const KNOWN_SOCIAL_HOSTS = new Set<string>([
  "instagram.com", "twitter.com", "x.com", "tiktok.com", "facebook.com",
  "soundcloud.com", "youtube.com", "youtu.be", "spotify.com", "open.spotify.com",
  "linktr.ee", "beacons.ai", "lnk.bio", "bio.link", "allmylinks.com", "carrd.co",
  "snapchat.com", "twitch.tv", "discord.gg", "discord.com", "apple.com",
  "music.apple.com", "tumblr.com", "pinterest.com", "github.com",
  "linkedin.com", "threads.net", "bsky.app", "mastodon.social",
  "patreon.com", "ko-fi.com", "buymeacoffee.com", "cash.app", "venmo.com",
  "paypal.com", "stripe.com", "shopify.com", "bandcamp.com",
  "submithub.com", "groover.co", "musosoup.com", "onesubmit.com",
]);

const PERSONAL_PATHS = ["/contact", "/contact/", "/contact-us", "/submit", "/submissions", "/about", "/press", "/info"];

export function isPlausibleEmail(raw: string): boolean {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 254) return false;
  if (STRICT_NOISE_EMAIL.has(e)) return false;
  const [local, domain] = e.split("@");
  if (!local || !domain) return false;
  if (local.length > 64) return false;
  if (NOISE_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return false;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
  // Filter image-asset-shaped tokens that look like emails (e.g. "icon@2x.png").
  if (/\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$/.test(e)) return false;
  if (/^[a-f0-9]{32,}$/.test(local)) return false;
  // Refuse "info@example.com" / "test@test.com" template-residue.
  if (domain === "example.com" || domain === "test.com" || domain === "domain.com") return false;
  // Reject embedded sentry/tracking dsn pseudo-emails (start with long hex).
  if (/^[a-f0-9]{16,}/.test(local) && local.length > 24) return false;
  return true;
}

/** Higher-confidence "looks like a contact/submission email" local-part check. */
export function isMusicContactLocal(local: string): boolean {
  return /^(submit|submissions|submission|demo|demos|music|hello|hi|info|contact|press|booking|mgmt|management|inquiries?|inquiry|promo|promotions?|playlist|playlists|curator|dj|radio|label|team|hey)$/i.test(local);
}

export function isPersonalSiteUrl(url: string): boolean {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    for (const social of KNOWN_SOCIAL_HOSTS) {
      if (host === social || host.endsWith("." + social)) return false;
    }
    // Reject mail/calendar/store hosts.
    if (/^(mail|gmail|mailto|calendar|cal|store|shop|app|api)\./.test(host)) return false;
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------
// Email picking / ranking inside one scrape
// ------------------------------------------------------------------

/** Among a set of emails extracted from one source, prefer mailto > emoji > text, then music-contact-local. */
export function pickBestEmail(hits: EmailHit[]): EmailHit | null {
  const valid = hits.filter((h) => isPlausibleEmail(h.value));
  if (!valid.length) return null;
  const sourceRank: Record<EmailHit["source"], number> = { mailto: 3, emoji: 2, text: 1 };
  valid.sort((a, b) => {
    const localA = a.value.split("@")[0];
    const localB = b.value.split("@")[0];
    const mA = isMusicContactLocal(localA) ? 1 : 0;
    const mB = isMusicContactLocal(localB) ? 1 : 0;
    if (mA !== mB) return mB - mA;
    const sA = sourceRank[a.source] ?? 0;
    const sB = sourceRank[b.source] ?? 0;
    return sB - sA;
  });
  return valid[0];
}

// ------------------------------------------------------------------
// Spotify helpers
// ------------------------------------------------------------------

function spotifyId(row: CuratorRow): string | null {
  const raw = String(row.playlist_id ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^spotify:/i, "");
}

function spotifyPlaylistUrl(id: string): string {
  return `https://open.spotify.com/playlist/${id}`;
}

function spotifyUserUrl(id: string): string {
  return `https://open.spotify.com/user/${id}`;
}

function spotifyOwnerIdFromMarkdown(md: string): string | null {
  const m = md.match(/open\.spotify\.com\/user\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function harvestBioLinks(md: string): string[] {
  const urls = new Set<string>();
  // Markdown link form
  for (const m of md.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) urls.add(m[1]);
  // Plain links
  for (const m of md.matchAll(/\bhttps?:\/\/[^\s)<>"']+/g)) urls.add(m[0]);
  return [...urls];
}

function harvestSocialHandles(md: string, ctx: EnrichmentContext): void {
  for (const m of md.matchAll(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
    if (!ctx.discoveredHandles.has("instagram")) ctx.discoveredHandles.set("instagram", m[1]);
  }
  for (const m of md.matchAll(/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})/gi)) {
    if (!ctx.discoveredHandles.has("twitter")) ctx.discoveredHandles.set("twitter", m[1]);
  }
  for (const m of md.matchAll(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,30})/gi)) {
    if (!ctx.discoveredHandles.has("tiktok")) ctx.discoveredHandles.set("tiktok", m[1]);
  }
  for (const m of md.matchAll(/(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([A-Za-z0-9._-]{2,40})/gi)) {
    if (!ctx.discoveredHandles.has("soundcloud")) ctx.discoveredHandles.set("soundcloud", m[1]);
  }
  for (const m of md.matchAll(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([A-Za-z0-9._-]{2,40})/gi)) {
    if (!ctx.discoveredHandles.has("youtube")) ctx.discoveredHandles.set("youtube", m[1]);
  }
}

// ------------------------------------------------------------------
// Strategy implementations
// ------------------------------------------------------------------

async function withTiming<T>(name: string, ctx: EnrichmentContext, fn: () => Promise<StrategyResult | null>): Promise<StrategyResult | null> {
  if (ctx.triedStrategies.has(name)) return null;
  ctx.triedStrategies.add(name);
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    if (r) ctx.attempts.push({ strategy: name, status: "found", detail: r.email, source_url: r.source_url, ms });
    else ctx.attempts.push({ strategy: name, status: "not_found", ms });
    return r;
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    ctx.attempts.push({ strategy: name, status: "error", detail: msg.slice(0, 200), ms });
    return null;
  }
}

/** Strategy 1 — Spotify playlist page (description + visible page text). */
export async function strategyPlaylistPage(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("playlist_page", ctx, async () => {
    if (!ctx.spotifyPlaylistId) return null;
    const url = spotifyPlaylistUrl(ctx.spotifyPlaylistId);
    const { markdown, html } = await firecrawlScrape(url, { waitFor: 2000 });
    ctx.cachedPlaylistMarkdown = markdown;
    if (!ctx.spotifyOwnerId) {
      const owner = spotifyOwnerIdFromMarkdown(markdown);
      if (owner) ctx.spotifyOwnerId = owner;
    }
    harvestSocialHandles(markdown, ctx);
    for (const u of harvestBioLinks(markdown)) ctx.discoveredUrls.add(u);
    const hit = pickBestEmail(extractEmails(markdown, html));
    if (!hit) return null;
    return { email: hit.value, source: "playlist_description", source_url: url, confidence: 9 };
  });
}

/** Strategy 2 — Spotify owner profile bio. */
export async function strategySpotifyBio(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("spotify_bio", ctx, async () => {
    if (!ctx.spotifyOwnerId) return null;
    const url = spotifyUserUrl(ctx.spotifyOwnerId);
    const { markdown, html } = await firecrawlScrape(url, { waitFor: 2000 });
    ctx.cachedOwnerMarkdown = markdown;
    const bioLinks = harvestBioLinks(markdown);
    ctx.cachedOwnerBioLinks = bioLinks;
    for (const u of bioLinks) ctx.discoveredUrls.add(u);
    harvestSocialHandles(markdown, ctx);
    const hit = pickBestEmail(extractEmails(markdown, html));
    if (!hit) return null;
    return { email: hit.value, source: "spotify_bio", source_url: url, confidence: 9 };
  });
}

/** Strategy 3 — Linktree (or beacons / bio.link) page follow. */
export async function strategyLinktree(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("linktree", ctx, async () => {
    const candidates = new Set<string>();
    const fromRow = (ctx.row.curator_linktree as string | undefined)?.trim();
    if (fromRow) candidates.add(fromRow);
    for (const u of ctx.discoveredUrls) for (const lt of extractLinktreeUrls(u)) candidates.add(lt);
    for (const u of ctx.discoveredUrls) {
      if (/(?:linktr\.ee|beacons\.ai|lnk\.bio|bio\.link|allmylinks\.com|carrd\.co)/i.test(u)) candidates.add(u);
    }
    if (!candidates.size) return null;
    for (const url of candidates) {
      if (isDeniedSourceUrl(url)) {
        ctx.attempts.push({ strategy: "linktree", status: "skipped", detail: "denied_source_url", source_url: url, ms: 0 });
        continue;
      }
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 1500 });
        for (const u of harvestBioLinks(markdown)) ctx.discoveredUrls.add(u);
        harvestSocialHandles(markdown, ctx);
        const hit = pickBestEmail(extractEmails(markdown, html));
        if (hit) return { email: hit.value, source: "linktree", source_url: url, confidence: hit.source === "mailto" ? 8 : 7 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 4 — Personal website discovery + /contact /submit /about probe. */
export async function strategyPersonalWebsite(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("personal_website", ctx, async () => {
    const sites = new Set<string>();
    const rowWeb = (ctx.row.curator_website as string | undefined)?.trim();
    if (rowWeb && isPersonalSiteUrl(rowWeb) && !isDeniedSourceUrl(rowWeb)) sites.add(rowWeb);
    for (const u of ctx.discoveredUrls) {
      if (isPersonalSiteUrl(u) && !isDeniedSourceUrl(u)) {
        try { sites.add(new URL(u).origin); } catch {}
      }
    }
    if (!sites.size) return null;
    for (const origin of sites) {
      if (isDeniedSourceUrl(origin)) {
        ctx.attempts.push({ strategy: "personal_website", status: "skipped", detail: "denied_source_url", source_url: origin, ms: 0 });
        continue;
      }
      // Probe homepage first, then a small set of likely contact paths.
      const probes = [origin, ...PERSONAL_PATHS.map((p) => origin.replace(/\/$/, "") + p)];
      for (const url of probes) {
        try {
          const { markdown, html } = await firecrawlScrape(url, { waitFor: 1500 });
          const hit = pickBestEmail(extractEmails(markdown, html));
          if (hit) {
            const conf = hit.source === "mailto" ? 8 : isMusicContactLocal(hit.value.split("@")[0]) ? 7 : 6;
            return { email: hit.value, source: "personal_website", source_url: url, confidence: conf };
          }
        } catch {}
      }
    }
    return null;
  });
}

/** Strategy 5 — Twitter/X bio + pinned scrape. */
export async function strategyTwitter(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("twitter", ctx, async () => {
    const handles = new Set<string>();
    const fromRow = (ctx.row.curator_twitter as string | undefined)?.trim();
    if (fromRow) handles.add(fromRow.replace(/^@/, ""));
    const fromAcc = ctx.discoveredHandles.get("twitter");
    if (fromAcc) handles.add(fromAcc);
    // Cross-platform: try Spotify owner id as a Twitter handle.
    if (ctx.spotifyOwnerId && /^[A-Za-z0-9_]{2,15}$/.test(ctx.spotifyOwnerId)) handles.add(ctx.spotifyOwnerId);
    // And the IG handle (common to share between platforms).
    const ig = ctx.discoveredHandles.get("instagram") ?? (ctx.row.curator_instagram as string | undefined);
    if (ig && /^[A-Za-z0-9_]{2,15}$/.test(ig)) handles.add(ig);
    if (!handles.size) return null;
    for (const h of handles) {
      const url = `https://x.com/${h}`;
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 3000 });
        const text = (markdown ?? "") + "\n" + (html ?? "");
        const hit = pickBestEmail(extractEmails(text, html));
        if (hit) return { email: hit.value, source: "twitter_bio", source_url: url, confidence: 7 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 6 — Instagram bio scrape (deeper than current). */
export async function strategyInstagram(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("instagram", ctx, async () => {
    const handles = new Set<string>();
    const fromRow = (ctx.row.curator_instagram as string | undefined)?.trim();
    if (fromRow) handles.add(fromRow.replace(/^@/, ""));
    const fromAcc = ctx.discoveredHandles.get("instagram");
    if (fromAcc) handles.add(fromAcc);
    if (!handles.size) return null;
    for (const h of handles) {
      const url = `https://www.instagram.com/${h}/`;
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 3000 });
        const text = (markdown ?? "") + "\n" + (html ?? "");
        const hit = pickBestEmail(extractEmails(text, html));
        if (hit) return { email: hit.value, source: "instagram_bio", source_url: url, confidence: 7 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 7 — Cross-platform handle probe (TikTok / SoundCloud / YouTube). */
export async function strategyCrossPlatform(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("cross_platform", ctx, async () => {
    const handle = ctx.spotifyOwnerId
      ?? (ctx.row.curator_instagram as string | undefined)
      ?? ctx.discoveredHandles.get("instagram")
      ?? null;
    if (!handle) return null;
    const safe = String(handle).replace(/^@/, "");
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(safe)) return null;
    const urls = [
      `https://www.tiktok.com/@${safe}`,
      `https://soundcloud.com/${safe}`,
      `https://www.youtube.com/@${safe}`,
    ];
    for (const url of urls) {
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 2500 });
        const text = (markdown ?? "") + "\n" + (html ?? "");
        for (const u of harvestBioLinks(markdown ?? "")) ctx.discoveredUrls.add(u);
        const hit = pickBestEmail(extractEmails(text, html));
        if (hit) return { email: hit.value, source: "cross_platform", source_url: url, confidence: 7 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 8 — Google-style dorking via Firecrawl /v1/search. */
export async function strategyWebSearchDork(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("web_search_dork", ctx, async () => {
    const curator = (ctx.row.curator_name as string | undefined)?.trim();
    const playlist = (ctx.row.playlist_name as string | undefined)?.trim();
    const ig = (ctx.row.curator_instagram as string | undefined)?.trim()
      ?? ctx.discoveredHandles.get("instagram");
    const dorks: string[] = [];
    if (curator) {
      dorks.push(`"${curator}" submissions email`);
      dorks.push(`"${curator}" contact email`);
      dorks.push(`"${curator}" submit music`);
    }
    if (playlist) {
      dorks.push(`"${playlist}" submit music email`);
      dorks.push(`"${playlist}" contact curator`);
    }
    if (ig) {
      dorks.push(`"@${ig}" submissions email`);
      dorks.push(`site:linktr.ee "${ig}"`);
      dorks.push(`site:beacons.ai "${ig}"`);
      dorks.push(`site:bio.link "${ig}"`);
    }
    if (!dorks.length) return null;
    for (const q of dorks.slice(0, 8)) {
      let hits = [];
      try { hits = await firecrawlSearch(q, 5); } catch { continue; }
      // First sweep: look for emails directly in SERP titles + descriptions.
      const serpText = hits.map((h) => `${h.title ?? ""} ${h.description ?? ""}`).join(" ");
      const fromSerp = pickBestEmail(extractEmails(serpText));
      if (fromSerp) return { email: fromSerp.value, source: "web_search_dork_serp", source_url: hits[0]?.url, confidence: 5 };
      // Second sweep: fetch the top 1–2 hits and parse.
      for (const hit of hits.slice(0, 2)) {
        if (!hit.url) continue;
        ctx.discoveredUrls.add(hit.url);
        try {
          const { markdown, html } = await firecrawlScrape(hit.url, { waitFor: 1500 });
          const emailHit = pickBestEmail(extractEmails(markdown, html));
          if (emailHit) {
            const conf = emailHit.source === "mailto" ? 6 : 5;
            return { email: emailHit.value, source: "web_search_dork", source_url: hit.url, confidence: conf };
          }
        } catch {}
      }
    }
    return null;
  });
}

/** Strategy 9 — Other playlists by the same Spotify owner. */
export async function strategyOtherPlaylists(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("other_playlists", ctx, async () => {
    if (!ctx.spotifyOwnerId) return null;
    const url = spotifyUserUrl(ctx.spotifyOwnerId) + "/playlists";
    let md: string;
    try { md = await firecrawlMarkdown(url, 2500); } catch { return null; }
    const seen = new Set<string>();
    for (const m of md.matchAll(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/g)) {
      if (m[1] !== ctx.spotifyPlaylistId) seen.add(m[1]);
    }
    let probed = 0;
    for (const pid of seen) {
      if (probed >= 3) break;
      probed++;
      try {
        const { markdown, html } = await firecrawlScrape(spotifyPlaylistUrl(pid), { waitFor: 1500 });
        const hit = pickBestEmail(extractEmails(markdown, html));
        if (hit) return { email: hit.value, source: "other_playlist_description", source_url: spotifyPlaylistUrl(pid), confidence: 7 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 10 — Wayback Machine archived bios for known curator URLs. */
export async function strategyWayback(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("wayback", ctx, async () => {
    const targets = new Set<string>();
    if (ctx.spotifyOwnerId) targets.add(spotifyUserUrl(ctx.spotifyOwnerId));
    const lt = (ctx.row.curator_linktree as string | undefined)?.trim();
    if (lt) targets.add(lt);
    for (const u of ctx.discoveredUrls) if (isPersonalSiteUrl(u)) targets.add(u);
    if (!targets.size) return null;
    for (const t of [...targets].slice(0, 3)) {
      const url = `https://web.archive.org/web/2024/${t}`;
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 2500 });
        const hit = pickBestEmail(extractEmails(markdown, html));
        if (hit) return { email: hit.value, source: "wayback", source_url: url, confidence: 4 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 11 — SubmitHub / OneSubmit / MusoSoup public profile (free reads only). */
export async function strategyAggregatorProfile(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("aggregator_profile", ctx, async () => {
    const candidates = new Set<string>();
    const seedNames = [
      (ctx.row.curator_name as string | undefined)?.trim(),
      (ctx.row.curator_instagram as string | undefined)?.trim(),
      ctx.discoveredHandles.get("instagram"),
      ctx.spotifyOwnerId,
    ].filter((s): s is string => !!s).map((s) => s.replace(/^@/, ""));
    for (const s of seedNames) {
      const slug = s.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      candidates.add(`https://www.submithub.com/profile/${slug}`);
      candidates.add(`https://www.submithub.com/blogs/${slug}`);
      candidates.add(`https://onesubmit.com/curator/${slug}`);
    }
    if (!candidates.size) return null;
    for (const url of [...candidates].slice(0, 4)) {
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 1500 });
        if (!markdown && !html) continue;
        const hit = pickBestEmail(extractEmails(markdown, html));
        if (hit) return { email: hit.value, source: "aggregator_profile", source_url: url, confidence: 6 };
      } catch {}
    }
    return null;
  });
}

/** Strategy 12 — Newsletter (Substack / beehiiv / medium) footer email. */
export async function strategyNewsletter(ctx: EnrichmentContext): Promise<StrategyResult | null> {
  return withTiming("newsletter", ctx, async () => {
    const targets: string[] = [];
    for (const u of ctx.discoveredUrls) {
      if (/(?:substack\.com|beehiiv\.com|medium\.com|ghost\.io)/i.test(u)) targets.push(u);
    }
    if (!targets.length) return null;
    for (const url of targets.slice(0, 3)) {
      try {
        const { markdown, html } = await firecrawlScrape(url, { waitFor: 2000 });
        const hit = pickBestEmail(extractEmails(markdown, html));
        if (hit) return { email: hit.value, source: "newsletter_footer", source_url: url, confidence: 6 };
      } catch {}
    }
    return null;
  });
}

// ------------------------------------------------------------------
// Chain runner
// ------------------------------------------------------------------

export type StrategyName =
  | "playlist_page"
  | "spotify_bio"
  | "linktree"
  | "personal_website"
  | "twitter"
  | "instagram"
  | "cross_platform"
  | "web_search_dork"
  | "other_playlists"
  | "newsletter"
  | "aggregator_profile"
  | "wayback";

/** Default priority order; chain stops at first plausible email. */
export const DEFAULT_STRATEGY_ORDER: StrategyName[] = [
  "playlist_page",        // cheapest, sometimes has email in description
  "spotify_bio",          // owner profile bio
  "linktree",             // follow linktree fan-out
  "personal_website",     // /contact /submit /about probe
  "instagram",            // bio + submission patterns
  "twitter",              // bio + pinned
  "cross_platform",       // tiktok / soundcloud / youtube
  "web_search_dork",      // Google dorks via firecrawl search
  "newsletter",           // substack/beehiiv footer
  "other_playlists",      // same-creator other playlists
  "aggregator_profile",   // submithub / onesubmit (free reads)
  "wayback",              // last resort: archived bios
];

const STRATEGY_FNS: Record<StrategyName, (ctx: EnrichmentContext) => Promise<StrategyResult | null>> = {
  playlist_page: strategyPlaylistPage,
  spotify_bio: strategySpotifyBio,
  linktree: strategyLinktree,
  personal_website: strategyPersonalWebsite,
  instagram: strategyInstagram,
  twitter: strategyTwitter,
  cross_platform: strategyCrossPlatform,
  web_search_dork: strategyWebSearchDork,
  newsletter: strategyNewsletter,
  other_playlists: strategyOtherPlaylists,
  aggregator_profile: strategyAggregatorProfile,
  wayback: strategyWayback,
};

export function newContext(row: CuratorRow): EnrichmentContext {
  const sid = spotifyId(row);
  return {
    row,
    spotifyPlaylistId: sid,
    spotifyOwnerId: null,
    discoveredUrls: new Set<string>(),
    discoveredHandles: new Map<string, string>(),
    attempts: [],
    triedStrategies: new Set<string>(),
  };
}

export async function runStrategyChain(
  ctx: EnrichmentContext,
  order: StrategyName[] = DEFAULT_STRATEGY_ORDER,
): Promise<StrategyResult | null> {
  for (const name of order) {
    const fn = STRATEGY_FNS[name];
    if (!fn) continue;
    const r = await fn(ctx);
    if (r) return r;
  }
  return null;
}
