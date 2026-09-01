// Canonical domain for all public smart links
export const LINKS_DOMAIN = "https://links.fendifrost.com";

/** Locked public EVEN artist URL — use on existing listen-pills / runway pages. */
export { EVEN_ARTIST_URL } from "@/lib/syncRegisters";

/** Runway Music album art — only for the runwaymusic smart link. */
export const RUNWAY_OG_IMAGE = `${LINKS_DOMAIN}/og-runwaymusic.png`;

/** Neutral fallbacks when a link has no artwork (never Runway album art). */
export const NEUTRAL_OG_IMAGE = `${LINKS_DOMAIN}/placeholder.svg`;
export const NEUTRAL_FAVICON = `${LINKS_DOMAIN}/favicon.png`;

/** @deprecated Use RUNWAY_OG_IMAGE or NEUTRAL_OG_IMAGE explicitly. */
export const DEFAULT_OG_IMAGE = RUNWAY_OG_IMAGE;

export function isRunwaySlug(slug: string): boolean {
  return slug.toLowerCase() === "runwaymusic";
}

/** Strip Runway album art from legacy og_image_url on non-Runway links. */
export function sanitizeLegacyOgUrl(slug: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (!isRunwaySlug(slug) && url.includes("og-runwaymusic.png")) return null;
  return url;
}

/**
 * Build the canonical public URL for a smart link.
 * Always uses the custom domain regardless of current origin.
 */
export const getCanonicalUrl = (slug: string) => `${LINKS_DOMAIN}/${slug}`;
