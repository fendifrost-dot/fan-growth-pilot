import { describe, it, expect } from "vitest";

/**
 * Deterministic tests for get-og-metadata edge function.
 * These call the deployed edge function directly (no Cloudflare Worker dependency)
 * and validate per-slug OG metadata + canonical URL + fallback behavior.
 */

const EDGE_FN_URL = "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/get-og-metadata";

describe("get-og-metadata: deterministic per-slug validation", () => {
  it("runwaymusic returns correct title, canonical, and og:image", async () => {
    const res = await fetch(`${EDGE_FN_URL}?slug=runwaymusic`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.title).toContain("Runway Music");
    expect(data.canonical).toBe("https://links.fendifrost.com/runwaymusic");
    expect(data.url).toBe("https://links.fendifrost.com/runwaymusic");
    expect(data.image).toContain("og-runwaymusic.png");
    expect(data.image).toMatch(/^https:\/\//);
  });

  it("heartchakra returns correct title, canonical, and og:image", async () => {
    const res = await fetch(`${EDGE_FN_URL}?slug=heartchakra`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.title).toBe("Some Hearts Break Louder");
    expect(data.canonical).toBe("https://links.fendifrost.com/heartchakra");
    expect(data.url).toBe("https://links.fendifrost.com/heartchakra");
    expect(data.image).toContain("og-chakra.png");
    expect(data.image).toMatch(/^https:\/\//);
  });

  it("two slugs return DIFFERENT og:image values", async () => {
    const [r1, r2] = await Promise.all([
      fetch(`${EDGE_FN_URL}?slug=runwaymusic`).then(r => r.json()),
      fetch(`${EDGE_FN_URL}?slug=heartchakra`).then(r => r.json()),
    ]);

    expect(r1.image).not.toEqual(r2.image);
    expect(r1.title).not.toEqual(r2.title);
    expect(r1.canonical).not.toEqual(r2.canonical);
  });

  it("unknown slug returns 404 with fallback default image", async () => {
    const res = await fetch(`${EDGE_FN_URL}?slug=nonexistent-slug-xyz`);
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.image).toContain("og-runwaymusic.png"); // branded default fallback
    expect(data.title).toBe("Page Not Found");
  });

  it("missing slug returns 400", async () => {
    const res = await fetch(EDGE_FN_URL);
    expect(res.status).toBe(400);
  });
});

describe("HTML injection simulation: og:image per slug", () => {
  /**
   * Simulates the Cloudflare Worker's HTML injection logic.
   * Given metadata from the edge function, verify correct OG tags would be produced.
   */
  function buildOgTags(metadata: { title: string; description: string; image: string; url: string; canonical: string }) {
    return [
      `<meta property="og:title" content="${metadata.title}" />`,
      `<meta property="og:description" content="${metadata.description}" />`,
      `<meta property="og:image" content="${metadata.image}" />`,
      `<meta property="og:url" content="${metadata.url}" />`,
      `<link rel="canonical" href="${metadata.canonical}" />`,
    ].join("\n");
  }

  it("produces different og:image tags for two different slugs", async () => {
    const [runway, chakra] = await Promise.all([
      fetch(`${EDGE_FN_URL}?slug=runwaymusic`).then(r => r.json()),
      fetch(`${EDGE_FN_URL}?slug=heartchakra`).then(r => r.json()),
    ]);

    const runwayHtml = buildOgTags(runway);
    const chakraHtml = buildOgTags(chakra);

    // Runway HTML has runway-specific image
    expect(runwayHtml).toContain("og-runwaymusic.png");
    expect(runwayHtml).not.toContain("og-chakra.png");

    // Chakra HTML has chakra-specific image
    expect(chakraHtml).toContain("og-chakra.png");
    expect(chakraHtml).not.toContain("og-runwaymusic.png");

    // Canonical URLs are slug-specific
    expect(runwayHtml).toContain("https://links.fendifrost.com/runwaymusic");
    expect(chakraHtml).toContain("https://links.fendifrost.com/heartchakra");
  });
});
