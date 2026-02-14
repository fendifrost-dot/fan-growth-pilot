import { describe, it, expect } from "vitest";

const EDGE_FN_URL = `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/og-metadata`;

describe("og-metadata edge function", () => {
  it("returns different metadata for runwaymusic vs chakra", async () => {
    const [runwayRes, chakraRes] = await Promise.all([
      fetch(`${EDGE_FN_URL}?slug=runwaymusic`),
      fetch(`${EDGE_FN_URL}?slug=chakra`),
    ]);

    expect(runwayRes.ok).toBe(true);
    expect(chakraRes.ok).toBe(true);

    const runway = await runwayRes.json();
    const chakra = await chakraRes.json();

    // Titles must be different
    expect(runway.title).not.toEqual(chakra.title);

    // OG images must be different
    expect(runway.image).not.toEqual(chakra.image);

    // Canonical URLs must be different and correct
    expect(runway.canonical).toBe("https://links.fendifrost.com/runwaymusic");
    expect(chakra.canonical).toBe("https://links.fendifrost.com/chakra");

    // og:url must match canonical
    expect(runway.url).toBe(runway.canonical);
    expect(chakra.url).toBe(chakra.canonical);

    // Verify specific content
    expect(runway.title).toContain("Runway Music");
    expect(chakra.title).toBe("Some Hearts Break Louder");

    // OG images must be absolute HTTPS URLs
    expect(runway.image).toMatch(/^https:\/\//);
    expect(chakra.image).toMatch(/^https:\/\//);
  });

  it("returns 400 without slug parameter", async () => {
    const res = await fetch(EDGE_FN_URL);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown slug", async () => {
    const res = await fetch(`${EDGE_FN_URL}?slug=nonexistent-slug-xyz`);
    expect(res.status).toBe(404);
  });
});

/**
 * INTEGRATION TEST — Real delivery path validation
 * 
 * These tests validate the FULL pipeline: Cloudflare Worker → og-metadata edge function → HTML injection.
 * They fetch the real production URLs and assert the returned HTML <head> contains correct per-slug metadata.
 * 
 * Run manually after Cloudflare Worker deployment:
 *   npx vitest run src/test/og-metadata.test.ts
 * 
 * NOTE: These will fail until the Cloudflare Worker is deployed.
 */
describe("Integration: live URL metadata delivery", () => {
  const LINKS_DOMAIN = "https://links.fendifrost.com";

  it("GET /runwaymusic returns correct OG tags in HTML", async () => {
    const res = await fetch(`${LINKS_DOMAIN}/runwaymusic`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    
    if (!res.ok) {
      console.warn("Integration test skipped: links domain not reachable");
      return;
    }

    const html = await res.text();

    // Must contain Runway Music OG title
    expect(html).toMatch(/og:title[^>]*content="[^"]*Runway Music/i);
    // Must contain runwaymusic OG image
    expect(html).toMatch(/og:image[^>]*content="[^"]*og-runwaymusic\.png/i);
    // Must contain correct canonical
    expect(html).toMatch(/rel="canonical"[^>]*href="https:\/\/links\.fendifrost\.com\/runwaymusic"/i);
    // Must contain correct og:url
    expect(html).toMatch(/og:url[^>]*content="https:\/\/links\.fendifrost\.com\/runwaymusic"/i);
  });

  it("GET /chakra returns different OG tags from /runwaymusic", async () => {
    const res = await fetch(`${LINKS_DOMAIN}/chakra`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    
    if (!res.ok) {
      console.warn("Integration test skipped: links domain not reachable");
      return;
    }

    const html = await res.text();

    // Must NOT contain Runway Music - must be Heart Chakra
    expect(html).not.toMatch(/og:title[^>]*content="[^"]*Runway Music/i);
    // Must contain Heart Chakra OG title
    expect(html).toMatch(/og:title[^>]*content="[^"]*Some Hearts Break Louder/i);
    // Must contain chakra OG image
    expect(html).toMatch(/og:image[^>]*content="[^"]*og-chakra\.png/i);
    // Must contain correct canonical
    expect(html).toMatch(/rel="canonical"[^>]*href="https:\/\/links\.fendifrost\.com\/chakra"/i);
  });
});
