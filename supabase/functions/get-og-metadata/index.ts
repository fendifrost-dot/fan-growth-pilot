import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  gatherCandidateUrls,
  resolveArtwork,
} from "../_shared/artwork.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LINKS_DOMAIN = "https://links.fendifrost.com";
const DEFAULT_OG_IMAGE = `${LINKS_DOMAIN}/og-runwaymusic.png`;
const DEFAULT_FAVICON = `${LINKS_DOMAIN}/favicon.png`;
// Long-lived signed URLs so crawlers/browsers can fetch private-bucket artwork.
const SIGN_EXPIRY_SECONDS = 60 * 60 * 24 * 365; // 1 year
const STORAGE_BUCKET = "smart-links";

// Resolve a smart_links image field to an absolute, publicly-fetchable URL.
// Full URLs pass through; relative storage paths are signed from the private bucket.
async function resolveImageUrl(
  supabase: SupabaseClient,
  raw: string | null | undefined,
): Promise<string | null> {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(raw, SIGN_EXPIRY_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("resolveImageUrl failed for", raw, error);
    return null;
  }
  return data.signedUrl;
}

function extFor(contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  return "jpg";
}

// When image_url is missing, pull official DSP artwork and persist it so future
// requests (and the SPA) reuse the same stored cover art.
async function ensureStoredArtwork(
  supabase: SupabaseClient,
  link: {
    id: string;
    slug: string;
    short_code: string | null;
    image_url: string | null;
    destination_url: string | null;
    metadata: Record<string, unknown> | null;
  },
): Promise<string | null> {
  const existing = await resolveImageUrl(supabase, link.image_url);
  if (existing) return existing;

  const candidates = gatherCandidateUrls(link);
  if (candidates.length === 0) return null;

  const art = await resolveArtwork(candidates);
  if (!art) return null;

  const imgRes = await fetch(art.imageUrl);
  if (!imgRes.ok) return art.imageUrl;

  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const ext = extFor(art.contentType);
  const path = `images/auto/${link.slug}-${link.short_code ?? link.id}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, bytes, { contentType: art.contentType, upsert: true });
  if (upErr) {
    console.error("ensureStoredArtwork upload failed:", upErr);
    return art.imageUrl;
  }

  const { error: updErr } = await supabase
    .from("smart_links")
    .update({ image_url: path })
    .eq("id", link.id);
  if (updErr) {
    console.error("ensureStoredArtwork db update failed:", updErr);
    return art.imageUrl;
  }

  return resolveImageUrl(supabase, path);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");

    if (!slug) {
      return new Response(
        JSON.stringify({ error: "Missing slug parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from("smart_links")
      .select(
        "id, title, headline, subheadline, description, image_url, slug, short_code, destination_url, metadata, theme_preset, og_image_url",
      )
      .or(`slug.eq.${slug},short_code.eq.${slug}`)
      .eq("is_active", true)
      .maybeSingle();

    if (error || !data) {
      return new Response(
        JSON.stringify({
          title: "Page Not Found",
          description: "",
          image: DEFAULT_OG_IMAGE,
          icon: DEFAULT_FAVICON,
          url: `${LINKS_DOMAIN}/${slug}`,
          canonical: `${LINKS_DOMAIN}/${slug}`,
        }),
        {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "public, s-maxage=60, max-age=60",
          },
        }
      );
    }

    const title = data.headline || data.title;
    const description = data.subheadline || data.description || "";

    // Resolve stored artwork, auto-fetching from DSP URLs when image_url is empty.
    const albumArt = await ensureStoredArtwork(supabase, data);

    // OG/social + favicon: per-link album art first; legacy og_image_url is fallback only.
    const ogImage = albumArt || data.og_image_url || DEFAULT_OG_IMAGE;
    const icon = albumArt || data.og_image_url || DEFAULT_FAVICON;
    const canonicalUrl = `${LINKS_DOMAIN}/${data.slug}`;

    const metadata = {
      title,
      description,
      image: ogImage,
      icon,
      url: canonicalUrl,
      canonical: canonicalUrl,
    };

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    console.error("get-og-metadata error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
