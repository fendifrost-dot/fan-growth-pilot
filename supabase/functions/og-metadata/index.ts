import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const LINKS_DOMAIN = "https://links.fendifrost.com";

// Dedicated public OG images per slug (stable URLs, no signed URLs needed)
const OG_IMAGE_MAP: Record<string, string> = {
  runwaymusic: `${LINKS_DOMAIN}/og-runwaymusic.png`,
  chakra: `${LINKS_DOMAIN}/og-chakra.png`,
};

const DEFAULT_OG_IMAGE = `${LINKS_DOMAIN}/og-runway-music.png`;

Deno.serve(async (req) => {
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

    // Fetch smart link data by slug or short_code
    const { data, error } = await supabase
      .from("smart_links")
      .select("title, headline, subheadline, description, image_url, slug, theme_preset")
      .or(`slug.eq.${slug},short_code.eq.${slug}`)
      .eq("is_active", true)
      .maybeSingle();

    if (error || !data) {
      // Return minimal metadata for unknown slugs
      return new Response(
        JSON.stringify({
          title: "Page Not Found",
          description: "",
          image: DEFAULT_OG_IMAGE,
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
    const ogImage = OG_IMAGE_MAP[data.slug] || DEFAULT_OG_IMAGE;
    const canonicalUrl = `${LINKS_DOMAIN}/${data.slug}`;

    const metadata = {
      title,
      description,
      image: ogImage,
      url: canonicalUrl,
      canonical: canonicalUrl,
    };

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        // Cache per slug path for 1 hour, stale-while-revalidate for 24h
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    console.error("og-metadata error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
