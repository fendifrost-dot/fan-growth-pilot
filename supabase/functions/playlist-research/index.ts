import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-supabase-client-platform, x-supabase-client-runtime",
};

function json(data, status) {
  if (status === undefined) status = 200;
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
  });
}

function getProvidedHubKey(req) {
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
    let body = {};
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

    // Step 1: Spotify token
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

    const spotFetch = async function(url) {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
      return r.json().catch(() => ({}));
    };

    // Step 2: Search track
    const searchData = await spotFetch("https://api.spotify.com/v1/search?q=" + encodeURIComponent(track_name) + "&type=track&limit=3");
    const track = searchData && searchData.tracks && searchData.tracks.items && searchData.tracks.items[0];
    if (!track) return json({ error: "Track not found on Spotify: " + track_name }, 404);

    const trackId = track.id;
    const artist = track.artists && track.artists[0];
    const artistId = artist && artist.id;
    const artistName = (artist && artist.name) || track_name;

    // Step 3: Artist info + related (free endpoints only)
    let genres = [];
    let relatedArtists = [];
    if (artistId) {
      const artistData = await spotFetch("https://api.spotify.com/v1/artists/" + artistId);
      genres = (artistData && Array.isArray(artistData.genres) ? artistData.genres : []).slice(0, 5);
      const relatedData = await spotFetch("https://api.spotify.com/v1/artists/" + artistId + "/related-artists");
      relatedArtists = (relatedData && Array.isArray(relatedData.artists) ? relatedData.artists : []).slice(0, 3).map(function(a) { return a && a.name; }).filter(Boolean);
    }

    // Step 4: Build search terms
    const termSet = new Set([track_name, artistName]);
    genres.slice(0, 3).forEach(function(g) { termSet.add(g); });
    relatedArtists.slice(0, 2).forEach(function(a) { termSet.add(a); });
    const queryTerms = Array.from(termSet).slice(0, 6);

    // Step 5: Search playlists sequentially
    const playlistMap = new Map();
    for (let qi = 0; qi < queryTerms.length; qi++) {
      const query = queryTerms[qi];
      try {
        const plData = await spotFetch("https://api.spotify.com/v1/search?q=" + encodeURIComponent(query) + "&type=playlist&limit=8");
        const items = (plData && plData.playlists && plData.playlists.items) || [];
        for (let pi = 0; pi < items.length; pi++) {
          const pl = items[pi];
          if (!pl || !pl.id) continue;
          const key = "spotify:" + pl.id;
          const followerCount = (pl.followers && typeof pl.followers.total === "number") ? pl.followers.total
            : (pl.tracks && typeof pl.tracks.total === "number") ? pl.tracks.total : 0;
          if (!playlistMap.has(key)) {
            playlistMap.set(key, {
              playlist_id: key,
              platform: "spotify",
              playlist_name: pl.name,
              name: pl.name,
              curator_name: (pl.owner && pl.owner.display_name) || null,
              followers: followerCount,
              track_count: (pl.tracks && pl.tracks.total) || 0,
              matched_queries: [query],
              track_name: track_name,
              pitch_status: "not_pitched",
              research_context: { audio_features: null, genres: genres, related_artists: relatedArtists, search_term: query },
            });
          } else {
            playlistMap.get(key).matched_queries.push(query);
          }
        }
      } catch (_) {}
    }

    // Step 6: Filter + rank
    const results = [];
    for (const entry of playlistMap.values()) {
      const name = (entry.playlist_name || "").toLowerCase();
      if (!entry.playlist_name) continue;
      if (["submit", "promo", "placement", "pay"].some(function(k) { return name.includes(k); })) continue;
      results.push(entry);
    }
    results.sort(function(a, b) { return (b.matched_queries.length - a.matched_queries.length) || (b.followers - a.followers); });
    const top = results.slice(0, 50);

    // Step 7: Upsert (never crash the response)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && supabaseKey && top.length > 0) {
      try {
        const sb = createClient(supabaseUrl, supabaseKey);
        const { error: uErr } = await sb.from("playlist_targets").upsert(
          top.map(function(pl) {
            return {
              playlist_id: pl.playlist_id, platform: pl.platform,
              playlist_name: pl.playlist_name, curator_name: pl.curator_name,
              track_name: pl.track_name, followers: pl.followers,
              pitch_status: pl.pitch_status, research_context: pl.research_context,
            };
          }),
          { onConflict: "playlist_id" }
        );
        if (uErr) console.error("Upsert error:", uErr.message);
      } catch (uEx) { console.error("Upsert exception:", uEx); }
    }

    return json({
      playlists: top.map(function(p) { return { playlist_id: p.playlist_id, name: p.name || p.playlist_name, followers: p.followers, platform: p.platform }; }),
      total: top.length,
      track: { id: trackId, name: track.name, artist: artistName },
    }, 200);

  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
    });
  }
});
