// Canonical domain for all public smart links
export const LINKS_DOMAIN = "https://links.fendifrost.com";

// Default branded fallback image for OG and card thumbnails
export const DEFAULT_OG_IMAGE = `${LINKS_DOMAIN}/og-runwaymusic.png`;

/**
 * Build the canonical public URL for a smart link.
 * Always uses the custom domain regardless of current origin.
 */
export const getCanonicalUrl = (slug: string) => `${LINKS_DOMAIN}/${slug}`;
