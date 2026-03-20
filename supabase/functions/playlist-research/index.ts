import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-supabase-client-platform, x-supabase-client-runtime",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getProvidedHubKey(req: Request) {
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const apikey = req.headers.get("apikey");
  if (apikey) return apikey;
  const auth = req.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_) {}

    const track_name = body.track_name;
    if (!track_name || typeof track_name !== "string") return json({ error: "track_name required" }, 400);

    const expectedKey = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expectedKey) return json({ error: "FANFUEL_HUB_KEY not configured" }, 500);
    const providedKey = getProvidedHubKey(req);
    if (!providedKey || providedKey.trim() !== expectedKey.trim()) return json({ error: "Unauthorized" }, 401);

    const spotifyClientId = Deno.env.get("SPOTIFY_CLIENT_ID");
    const spotifyClientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
    if (!spotifyClientId || !spotifyClientSecret) return json({ error: "Spotify credentials not configured" }, 500);

    // Step 1: Spotify token via client_credentials
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(spotifyClientId + ":" + spotifyClientSecret),
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenResp.ok) {
      const err = await tokenResp.text().catch(() => "");
      return json({ error: "Spotify auth failed", status: tokenResp.status, detail: err.slice(0, 200) }, 502);
    }
    const tokenJson = await tokenResp.json().catch(() => ({}));
    const accessToken = tokenJson.access_token;
    if (!accessToken) return json({ error: "Spotify auth failed: missing access_token" }, 502);

    const spotFetch = async (url: string) => {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
      if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        throw new Error(`Spotify ${r.status}: ${errBody.slice(0, 200)}`);
      }
      return r.json();
    };

    // Step 2: Search for the track
    const searchData = await spotFetch("https://api.spotify.com/v1/search?q=" + encodeURIComponent(track_name) + "&type=track&limit=3");
    const track = searchData?.tracks?.items?.[0];
    if (!track) return json({ error: "Track not found on Spotify: " + track_name }, 404);

    const trackId = track.id;
    const artist = track.artists?.[0];
    const artistId = artist?.id;
    const artistName = artist?.name || track_name;

    // Step 3: Get artist DNA (related artists) — NO audio-features, NO recommendations
    let genres: string[] = [];
    let dnaArtists: { id: string; name: string }[] = [];
    if (artistId) {
      const artistData = await spotFetch("https://api.spotify.com/v1/artists/" + artistId);
      genres = (Array.isArray(artistData?.genres) ? artistData.genres : []).slice(0, 5);

      const relatedData = await spotFetch("https://api.spotify.com/v1/artists/" + artistId + "/related-artists");
      dnaArtists = (Array.isArray(relatedData?.artists) ? relatedData.artists : [])
        .slice(0, 10)
        .map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }));
    }

    // Step 4: Search playlists using each artist DNA name
    const playlistMap = new Map<string, {
      playlist_id: string; platform: string; playlist_name: string; name: string;
      curator_name: string | null; followers: number; track_count: number;
      matched_queries: string[]; track_name: string; pitch_status: string;
      research_context: Record<string, unknown>;
    }>();

    // Search with each DNA artist name: ?q=ARTIST_DNA_NAME&type=playlist&limit=8
    const searchTerms = dnaArtists.map(a => a.name);
    // Also include the original artist as a search term
    if (artistName && !searchTerms.includes(artistName)) {
      searchTerms.unshift(artistName);
    }

    for (const dnaName of searchTerms) {
      try {
        const plData = await spotFetch(
          "https://api.spotify.com/v1/search?q=" + encodeURIComponent(dnaName) + "&type=playlist&limit=8"
        );
        const items = plData?.playlists?.items || [];
        for (const pl of items) {
          if (!pl?.id) continue;
          const key = "spotify:" + pl.id;
          const followerCount = (pl.followers && typeof pl.followers.total === "number")
            ? pl.followers.total
            : (pl.tracks && typeof pl.tracks.total === "number") ? pl.tracks.total : 0;

          if (!playlistMap.has(key)) {
            playlistMap.set(key, {
              playlist_id: key,
              platform: "spotify",
              playlist_name: pl.name,
              name: pl.name,
              curator_name: pl.owner?.display_name || null,
              followers: followerCount,
              track_count: pl.tracks?.total || 0,
              matched_queries: [dnaName],
              track_name: track_name,
              pitch_status: "not_pitched",
              research_context: {
                genres,
                dna_artists: dnaArtists.map(a => a.name),
                search_term: dnaName,
              },
            });
          } else {
            playlistMap.get(key)!.matched_queries.push(dnaName);
          }
        }
      } catch (e) {
        console.warn("Search failed for DNA artist:", dnaName, e);
      }
    }

    // Step 5: Filter spam + rank by match count then followers
    const results: typeof playlistMap extends Map<string, infer V> ? V[] : never = [];
    for (const entry of playlistMap.values()) {
      const name = (entry.playlist_name || "").toLowerCase();
      if (!entry.playlist_name) continue;
      if (["submit", "promo", "placement", "pay"].some(k => name.includes(k))) continue;
      results.push(entry);
    }
    results.sort((a, b) => (b.matched_queries.length - a.matched_queries.length) || (b.followers - a.followers));
    const top = results.slice(0, 50);

    // Step 6: Upsert to playlist_targets
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && supabaseKey && top.length > 0) {
      try {
        const sb = createClient(supabaseUrl, supabaseKey);
        const { error: uErr } = await sb.from("playlist_targets").upsert(
          top.map(pl => ({
            playlist_id: pl.playlist_id,
            platform: pl.platform,
            playlist_name: pl.playlist_name,
            curator_name: pl.curator_name,
            track_name: pl.track_name,
            followers: pl.followers,
            pitch_status: pl.pitch_status,
            research_context: pl.research_context,
          })),
          { onConflict: "playlist_id" }
        );
        if (uErr) console.error("Upsert error:", uErr.message);
      } catch (uEx) { console.error("Upsert exception:", uEx); }
    }

    return json({
      playlists: top.map(p => ({
        playlist_id: p.playlist_id,
        name: p.name || p.playlist_name,
        followers: p.followers,
        platform: p.platform,
        matched_queries: p.matched_queries,
      })),
      total: top.length,
      track: { id: trackId, name: track.name, artist: artistName },
      dna_artists: dnaArtists.map(a => a.name),
    }, 200);

  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
