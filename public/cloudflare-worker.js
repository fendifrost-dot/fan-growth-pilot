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

const OG_METADATA_URL = "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/og-metadata";

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
      // Replace existing OG tags
      html = html.replace(
        /<meta property="og:title"[^>]*>/,
        `<meta property="og:title" content="${escapeHtml(metadata.title)}" />`
      );
      html = html.replace(
        /<meta property="og:description"[^>]*>/,
        `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`
      );
      html = html.replace(
        /<meta property="og:image"[^>]*>/,
        `<meta property="og:image" content="${escapeHtml(metadata.image)}" />`
      );

      // Add og:url (doesn't exist in original)
      html = html.replace(
        /<meta property="og:type"[^>]*>/,
        `<meta property="og:url" content="${escapeHtml(metadata.url)}" />\n    <meta property="og:type" content="website" />`
      );

      // Replace Twitter tags
      html = html.replace(
        /<meta name="twitter:title"[^>]*>/,
        `<meta name="twitter:title" content="${escapeHtml(metadata.title)}" />`
      );
      html = html.replace(
        /<meta name="twitter:description"[^>]*>/,
        `<meta name="twitter:description" content="${escapeHtml(metadata.description)}" />`
      );
      html = html.replace(
        /<meta name="twitter:image"[^>]*>/,
        `<meta name="twitter:image" content="${escapeHtml(metadata.image)}" />`
      );

      // Replace page title
      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(metadata.title)}</title>`
      );

      // Add canonical link (inject before </head>)
      html = html.replace(
        /<\/head>/,
        `  <link rel="canonical" href="${escapeHtml(metadata.canonical)}" />\n  </head>`
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

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
