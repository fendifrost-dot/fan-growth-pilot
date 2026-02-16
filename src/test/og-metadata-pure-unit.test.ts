import { describe, it, expect } from "vitest";

/**
 * PURE DETERMINISTIC unit tests — zero network calls.
 * Tests the metadata resolution logic and HTML tag building
 * extracted from the edge function and Cloudflare Worker.
 */

// ── Pure function: resolve metadata from DB row ──
function resolveMetadata(
  data: { headline?: string; title: string; subheadline?: string; description?: string; og_image_url?: string | null; slug: string } | null,
  defaultOgImage: string,
  linksDomain: string,
) {
  if (!data) {
    return null;
  }
  const title = data.headline || data.title;
  const description = data.subheadline || data.description || "";
  const ogImage = data.og_image_url || defaultOgImage;
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

const DEFAULT_OG_IMAGE = "https://links.fendifrost.com/og-runwaymusic.png";
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
  og_image_url: "https://links.fendifrost.com/og-chakra.png",
  slug: "heartchakra",
};

describe("resolveMetadata: pure unit tests (no network)", () => {
  it("uses headline over title when present", () => {
    const meta = resolveMetadata(RUNWAY_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.title).toBe("Runway Music: The Sound of Style");
  });

  it("falls back to title when headline is empty", () => {
    const row = { ...RUNWAY_ROW, headline: undefined };
    const meta = resolveMetadata(row, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.title).toBe("Runway Music Even");
  });

  it("uses subheadline as description", () => {
    const meta = resolveMetadata(CHAKRA_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.description).toBe("This Is What It Sounds Like.");
  });

  it("returns og_image_url when set", () => {
    const meta = resolveMetadata(CHAKRA_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.image).toBe("https://links.fendifrost.com/og-chakra.png");
  });

  it("falls back to default image when og_image_url is null", () => {
    const row = { ...RUNWAY_ROW, og_image_url: null };
    const meta = resolveMetadata(row, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.image).toBe(DEFAULT_OG_IMAGE);
  });

  it("builds correct canonical URL from slug", () => {
    const meta = resolveMetadata(RUNWAY_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(meta.canonical).toBe("https://links.fendifrost.com/runwaymusic");
    expect(meta.url).toBe(meta.canonical);
  });

  it("returns null for null data (unknown slug)", () => {
    const meta = resolveMetadata(null, DEFAULT_OG_IMAGE, LINKS_DOMAIN);
    expect(meta).toBeNull();
  });

  it("two different slugs produce different metadata", () => {
    const r = resolveMetadata(RUNWAY_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    const c = resolveMetadata(CHAKRA_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    expect(r.title).not.toEqual(c.title);
    expect(r.image).not.toEqual(c.image);
    expect(r.canonical).not.toEqual(c.canonical);
  });
});

describe("buildOgTags: pure unit tests (no network)", () => {
  it("produces correct OG tags for runway", () => {
    const meta = resolveMetadata(RUNWAY_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!;
    const html = buildOgTags(meta);
    expect(html).toContain('content="Runway Music: The Sound of Style"');
    expect(html).toContain('content="https://links.fendifrost.com/og-runwaymusic.png"');
    expect(html).toContain('href="https://links.fendifrost.com/runwaymusic"');
  });

  it("produces different og:image tags for two slugs", () => {
    const rHtml = buildOgTags(resolveMetadata(RUNWAY_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!);
    const cHtml = buildOgTags(resolveMetadata(CHAKRA_ROW, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!);
    expect(rHtml).toContain("og-runwaymusic.png");
    expect(rHtml).not.toContain("og-chakra.png");
    expect(cHtml).toContain("og-chakra.png");
    expect(cHtml).not.toContain("og-runwaymusic.png");
  });

  it("fallback image appears in OG tags when og_image_url is null", () => {
    const row = { ...CHAKRA_ROW, og_image_url: null };
    const html = buildOgTags(resolveMetadata(row, DEFAULT_OG_IMAGE, LINKS_DOMAIN)!);
    expect(html).toContain("og-runwaymusic.png"); // fallback
    expect(html).not.toContain("og-chakra.png");
  });
});
