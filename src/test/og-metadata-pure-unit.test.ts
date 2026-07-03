import { describe, it, expect } from "vitest";

/**
 * PURE DETERMINISTIC unit tests — zero network calls.
 * Tests the metadata resolution logic and HTML tag building
 * extracted from the edge function and Cloudflare Worker.
 */

// ── Pure function: resolve metadata from DB row (mirrors get-og-metadata) ──
const RUNWAY_OG_IMAGE = "https://links.fendifrost.com/og-runwaymusic.png";
const NEUTRAL_OG_IMAGE = "https://links.fendifrost.com/placeholder.svg";

function isRunwaySlug(slug: string): boolean {
  return slug.toLowerCase() === "runwaymusic";
}

function sanitizeLegacyOgUrl(slug: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (!isRunwaySlug(slug) && url.includes("og-runwaymusic.png")) return null;
  return url;
}

function resolveShareImage(
  slug: string,
  albumArt: string | null | undefined,
  ogImageUrl: string | null | undefined,
): string {
  const legacy = sanitizeLegacyOgUrl(slug, ogImageUrl);
  if (albumArt) return albumArt;
  if (legacy) return legacy;
  return isRunwaySlug(slug) ? RUNWAY_OG_IMAGE : NEUTRAL_OG_IMAGE;
}

function resolveMetadata(
  data: {
    headline?: string;
    title: string;
    subheadline?: string;
    description?: string;
    image_url?: string | null;
    og_image_url?: string | null;
    slug: string;
  } | null,
  linksDomain: string,
) {
  if (!data) {
    return null;
  }
  const title = data.headline || data.title;
  const description = data.subheadline || data.description || "";
  const ogImage = resolveShareImage(data.slug, data.image_url, data.og_image_url);
  const canonicalUrl = `${linksDomain}/${data.slug}`;
  return { title, description, image: ogImage, url: canonicalUrl, canonical: canonicalUrl };
}

// ── Pure function: build OG HTML tags from metadata ──
function buildOgTags(metadata: { title: string; description: string; image: string; url: string; canonical: string }) {
  return [
    `<meta property="og:title" content="${metadata.title}" />`,
    `<meta property="og:description" content="${metadata.description}" />`,
    `<meta property="og:image" content="${metadata.image}" />`,
    `<meta property="og:url" content="${metadata.url}" />`,
    `<link rel="canonical" href="${metadata.canonical}" />`,
  ].join("\n");
}

const LINKS_DOMAIN = "https://links.fendifrost.com";

// ── Mock DB rows matching actual production data ──
const RUNWAY_ROW = {
  title: "Runway Music Even",
  headline: "Runway Music: The Sound of Style",
  subheadline: "Stream the album, shop the vision, and experience the culture where rhythm meets design.",
  description: "This isn't just an album...",
  og_image_url: "https://links.fendifrost.com/og-runwaymusic.png",
  slug: "runwaymusic",
};

const CHAKRA_ROW = {
  title: "Heart Chakra",
  headline: "Some Hearts Break Louder",
  subheadline: "This Is What It Sounds Like.",
  description: "HEART CHAKRA...",
  image_url: "https://vsemrziqxrrfcquxfnwd.supabase.co/storage/v1/object/sign/smart-links/images/chakra.jpg",
  og_image_url: "https://links.fendifrost.com/og-chakra.png",
  slug: "heartchakra",
};

describe("resolveMetadata: pure unit tests (no network)", () => {
  it("uses headline over title when present", () => {
    const meta = resolveMetadata(RUNWAY_ROW, LINKS_DOMAIN)!;
    expect(meta.title).toBe("Runway Music: The Sound of Style");
  });

  it("falls back to title when headline is empty", () => {
    const row = { ...RUNWAY_ROW, headline: undefined };
    const meta = resolveMetadata(row, LINKS_DOMAIN)!;
    expect(meta.title).toBe("Runway Music Even");
  });

  it("uses subheadline as description", () => {
    const meta = resolveMetadata(CHAKRA_ROW, LINKS_DOMAIN)!;
    expect(meta.description).toBe("This Is What It Sounds Like.");
  });

  it("prefers image_url over legacy og_image_url when set", () => {
    const meta = resolveMetadata(CHAKRA_ROW, LINKS_DOMAIN)!;
    expect(meta.image).toContain("supabase.co/storage");
    expect(meta.image).not.toContain("og-chakra.png");
  });

  it("falls back to og_image_url when image_url is null", () => {
    const row = { ...CHAKRA_ROW, image_url: null };
    const meta = resolveMetadata(row, LINKS_DOMAIN)!;
    expect(meta.image).toBe("https://links.fendifrost.com/og-chakra.png");
  });

  it("falls back to default image when og_image_url is null", () => {
    const row = { ...RUNWAY_ROW, og_image_url: null };
    const meta = resolveMetadata(row, LINKS_DOMAIN)!;
    expect(meta.image).toBe(RUNWAY_OG_IMAGE);
  });

  it("builds correct canonical URL from slug", () => {
    const meta = resolveMetadata(RUNWAY_ROW, LINKS_DOMAIN)!;
    expect(meta.canonical).toBe("https://links.fendifrost.com/runwaymusic");
    expect(meta.url).toBe(meta.canonical);
  });

  it("returns null for null data (unknown slug)", () => {
    const meta = resolveMetadata(null, LINKS_DOMAIN);
    expect(meta).toBeNull();
  });

  it("never uses Runway art as fallback for non-Runway links", () => {
    const row = { ...CHAKRA_ROW, image_url: null, og_image_url: null };
    const meta = resolveMetadata(row, LINKS_DOMAIN)!;
    expect(meta.image).toBe(NEUTRAL_OG_IMAGE);
    expect(meta.image).not.toContain("og-runwaymusic.png");
  });

  it("strips Runway og_image_url mistakenly set on a non-Runway link", () => {
    const row = {
      ...CHAKRA_ROW,
      image_url: null,
      og_image_url: "https://links.fendifrost.com/og-runwaymusic.png",
    };
    const meta = resolveMetadata(row, LINKS_DOMAIN)!;
    expect(meta.image).toBe(NEUTRAL_OG_IMAGE);
  });
});

describe("buildOgTags: pure unit tests (no network)", () => {
  it("produces correct OG tags for runway", () => {
    const meta = resolveMetadata(RUNWAY_ROW, LINKS_DOMAIN)!;
    const html = buildOgTags(meta);
    expect(html).toContain('content="Runway Music: The Sound of Style"');
    expect(html).toContain('content="https://links.fendifrost.com/og-runwaymusic.png"');
    expect(html).toContain('href="https://links.fendifrost.com/runwaymusic"');
  });

  it("produces different og:image tags for two slugs", () => {
    const rHtml = buildOgTags(resolveMetadata(RUNWAY_ROW, LINKS_DOMAIN)!);
    const cHtml = buildOgTags(resolveMetadata(CHAKRA_ROW, LINKS_DOMAIN)!);
    expect(rHtml).toContain("og-runwaymusic.png");
    expect(rHtml).not.toContain("supabase.co/storage");
    expect(cHtml).toContain("supabase.co/storage");
    expect(cHtml).not.toContain("og-runwaymusic.png");
  });

  it("non-Runway links with no art use neutral placeholder, not Runway", () => {
    const row = { ...CHAKRA_ROW, image_url: null, og_image_url: null };
    const html = buildOgTags(resolveMetadata(row, LINKS_DOMAIN)!);
    expect(html).toContain("placeholder.svg");
    expect(html).not.toContain("og-runwaymusic.png");
  });
});
