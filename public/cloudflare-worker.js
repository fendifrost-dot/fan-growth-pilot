/**
 * Cloudflare Worker for links.fendifrost.com
 * 
 * Intercepts ALL requests to links.fendifrost.com/:slug
 * Fetches dynamic OG metadata from the og-metadata edge function
 * Injects/replaces OG + Twitter + canonical tags in the SPA's index.html
 * 
 * DEPLOYMENT:
 * 1. Create a Cloudflare Worker
 * 2. Paste this code
 * 3. Add route: links.fendifrost.com/*
 * 4. Set environment variable: ORIGIN_URL = your Lovable preview/published URL
 * 
 * CACHING STRATEGY:
 * - HTML responses are cached per-path (slug) using cf.cacheKey
 * - Cache TTL: 1 hour (s-maxage=3600)
 * - Stale-while-revalidate: 24 hours
 * - PURGE: Use Cloudflare API to purge by URL when a smart link is edited
 *   curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
 *     -H "Authorization: Bearer {token}" \
 *     -d '{"files":["https://links.fendifrost.com/runwaymusic"]}'
 */

const OG_METADATA_URL = "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/get-og-metadata";
const DEFAULT_OG_IMAGE = "https://links.fendifrost.com/og-runwaymusic.png";
const SUPABASE_URL = "https://vsemrziqxrrfcquxfnwd.supabase.co";
// Public anon key (same as the published SPA bundle) — read-only smart_links access.
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzZW1yemlxeHJyZmNxdXhmbndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MjgyMDYsImV4cCI6MjA3NzUwNDIwNn0.YBf-HcObtQGlyjbXeXe0SErkRSnmBy6BNWUbjcgus94";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Root returns 404 (protect dashboard privacy)
    if (path === "/" || path === "") {
      return new Response("Not Found", { status: 404 });
    }

    // Extract slug (first path segment, ignore deeper paths)
    const slug = path.replace(/^\//, "").split("/")[0];

    // Skip non-slug paths (assets, etc.)
    if (slug.includes(".") || !slug) {
      // Pass through to origin for static assets
      const originUrl = env.ORIGIN_URL || "https://fan-growth-pilot.lovable.app";
      return fetch(`${originUrl}${path}`, request);
    }

    // Fetch OG metadata from edge function
    let metadata = null;
    try {
      const metaRes = await fetch(`${OG_METADATA_URL}?slug=${encodeURIComponent(slug)}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (metaRes.ok) {
        metadata = await metaRes.json();
        metadata = await maybeUpgradeDefaultArtwork(slug, metadata);
      }
    } catch (e) {
      console.error("Failed to fetch OG metadata:", e);
    }

    // Fetch origin HTML
    const originUrl = env.ORIGIN_URL || "https://fan-growth-pilot.lovable.app";
    const originRes = await fetch(`${originUrl}/${slug}`, {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "",
        "Accept": request.headers.get("Accept") || "text/html",
      },
    });

    let html = await originRes.text();

    // Inject dynamic metadata if we have it
    if (metadata) {
      // STRIP ALL existing OG and Twitter meta tags to prevent duplicates
      html = html.replace(/<meta\s+(property|name)="(og:[^"]+|twitter:[^"]+)"[^>]*>\s*/gi, "");

      // STRIP the static favicon/icon links so we can inject a per-link one
      // (otherwise every slug shows the default Runway Music favicon)
      html = html.replace(/<link\s+[^>]*rel="(shortcut icon|icon|apple-touch-icon)"[^>]*>\s*/gi, "");

      // Per-link favicon = this link's own artwork (falls back to default in the edge fn)
      const icon = metadata.icon || metadata.image;

      // Build the single authoritative OG + Twitter block
      const metaBlock = [
        `<meta property="og:title" content="${escapeHtml(metadata.title)}" />`,
        `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:image" content="${escapeHtml(metadata.image)}" />`,
        `<meta property="og:url" content="${escapeHtml(metadata.url)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:site" content="@Fendi_Frost" />`,
        `<meta name="twitter:title" content="${escapeHtml(metadata.title)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(metadata.description)}" />`,
        `<meta name="twitter:image" content="${escapeHtml(metadata.image)}" />`,
        `<link rel="icon" href="${escapeHtml(icon)}" />`,
        `<link rel="apple-touch-icon" href="${escapeHtml(icon)}" />`,
        `<link rel="canonical" href="${escapeHtml(metadata.canonical)}" />`,
      ].join("\n    ");

      // Replace page title
      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(metadata.title)}</title>`
      );

      // Inject the single block before </head>
      html = html.replace(
        /<\/head>/,
        `    ${metaBlock}\n  </head>`
      );
    }

    return new Response(html, {
      status: originRes.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Cache per-path — different slug = different cache entry
        // Cloudflare automatically uses the full URL as cache key
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400, max-age=0",
        // Vary by path to prevent cross-slug pollution
        "Vary": "Accept-Encoding",
      },
    });
  },
};

/** When the edge fn still returns the generic Runway default, resolve DSP artwork. */
async function maybeUpgradeDefaultArtwork(slug, metadata) {
  if (!metadata || slug === "runwaymusic") return metadata;

  // Favicon already uses stored album art but og:image still points at a legacy static og-*.png.
  if (
    metadata.icon &&
    metadata.icon.includes("supabase.co/storage") &&
    metadata.image?.includes("links.fendifrost.com/og-")
  ) {
    return { ...metadata, image: metadata.icon };
  }

  if (metadata.image !== DEFAULT_OG_IMAGE && metadata.icon !== "https://links.fendifrost.com/favicon.png") {
    return metadata;
  }

  const art = await resolveDspArtwork(slug);
  if (!art) return metadata;
  return { ...metadata, image: art, icon: art };
}

async function resolveDspArtwork(slug) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/smart_links?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=metadata,destination_url`,
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
      },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const link = rows?.[0];
    if (!link) return null;

    const md = link.metadata || {};
    const urls = [
      md.apple_music_url,
      md.spotify_url,
      ...(Array.isArray(md.platforms) ? md.platforms.map((p) => p?.url) : []),
      link.destination_url,
    ].filter((u) => typeof u === "string" && u.startsWith("http"));

    for (const url of [...new Set(urls)]) {
      const apple = await artworkFromApple(url);
      if (apple) return apple;
      const spotify = await artworkFromSpotify(url);
      if (spotify) return spotify;
    }
  } catch (e) {
    console.error("resolveDspArtwork failed:", e);
  }
  return null;
}

async function artworkFromApple(url) {
  const id = url.match(/[?&]i=(\d{3,})/)?.[1] ?? url.match(/music\.apple\.com\/[^?#]*?\/(\d{3,})(?:[/?#]|$)/i)?.[1];
  if (!id) return null;
  const data = await fetch(`https://itunes.apple.com/lookup?id=${id}`).then((r) => r.json());
  const raw = data?.results?.[0]?.artworkUrl100 ?? data?.results?.[0]?.artworkUrl60;
  if (!raw) return null;
  return raw.replace(/\/\d+x\d+bb\.(jpg|png)/i, "/1000x1000bb.$1");
}

async function artworkFromSpotify(url) {
  if (!/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:album|track|playlist)\//i.test(url)) return null;
  const data = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  ).then((r) => (r.ok ? r.json() : null));
  const thumb = data?.thumbnail_url;
  if (!thumb) return null;
  return thumb.replace(/ab67616d0000[0-9a-f]{4}/i, "ab67616d0000b273");
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
