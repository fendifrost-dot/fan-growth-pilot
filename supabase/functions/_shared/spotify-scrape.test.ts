import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseEmbedNextData, parseOEmbedTitle } from "./spotify-scrape.ts";

// A trimmed-but-faithful Spotify embed (`/embed/playlist/<id>`) __NEXT_DATA__ blob:
// the page is server-rendered, so the entity (name, owner, description, trackList)
// is present in the HTML with no JS execution required.
function embedHtml(entity: unknown): string {
  const nextData = { props: { pageProps: { state: { data: { entity } } } } };
  return `<!DOCTYPE html><html><head><title>Spotify</title></head><body>` +
    `<div id="__next"></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` +
    `</body></html>`;
}

const FULL_ENTITY = {
  type: "playlist",
  name: "Underground Rap Heat 🔥",
  title: "Underground Rap Heat 🔥",
  subtitle: "DJ Coldcuts",
  description: "Weekly drops of the hardest underground bars. Submit via link in bio.",
  uri: "spotify:playlist:0KLdaP12abZ34cd56ef78g",
  trackList: [
    { uri: "spotify:track:a", title: "Trenches", subtitle: "Some Rapper, Another Guy" },
    { uri: "spotify:track:b", title: "Night Shift", subtitle: "Third Artist feat. Some Rapper" },
    { uri: "spotify:track:c", title: "No Hook", subtitle: "Fourth Artist" },
  ],
};

// --- happy path -------------------------------------------------------------

Deno.test("parseEmbedNextData pulls name/description/curator/tracks from a full entity", () => {
  const d = parseEmbedNextData(embedHtml(FULL_ENTITY));
  assertEquals(d?.name, "Underground Rap Heat 🔥");
  assertEquals(d?.description, "Weekly drops of the hardest underground bars. Submit via link in bio.");
  assertEquals(d?.owner_name, "DJ Coldcuts");
  assertEquals(d?.track_count, 3);
  // Artists are split on commas / feat. and de-duplicated across tracks.
  assertEquals(d?.track_artists?.includes("Some Rapper"), true);
  assertEquals(d?.track_artists?.includes("Another Guy"), true);
  assertEquals(d?.track_artists?.includes("Third Artist"), true);
  // "Some Rapper" appears in two tracks but must not be duplicated.
  assertEquals(d?.track_artists?.filter((a) => a === "Some Rapper").length, 1);
});

Deno.test("parseEmbedNextData reads an `owner` object when subtitle is absent", () => {
  const d = parseEmbedNextData(embedHtml({
    type: "playlist",
    name: "House Grooves",
    owner: { id: "curator123", name: "Deep Selects" },
    trackList: [{ uri: "spotify:track:x", title: "Groove", subtitle: "Producer X" }],
  }));
  assertEquals(d?.name, "House Grooves");
  assertEquals(d?.owner_name, "Deep Selects");
  assertEquals(d?.owner_id, "curator123");
});

Deno.test("parseEmbedNextData handles a playlist entity with no trackList", () => {
  const d = parseEmbedNextData(embedHtml({
    type: "playlist",
    name: "Just A Name",
    subtitle: "Curator",
  }));
  assertEquals(d?.name, "Just A Name");
  assertEquals(d?.owner_name, "Curator");
  // No trackList → no track_count / track_artists fabricated.
  assertEquals(d?.track_count, undefined);
  assertEquals(d?.track_artists, undefined);
});

Deno.test("parseEmbedNextData finds a deeply-nested entity", () => {
  const html = embedHtml({ irrelevant: true });
  // Bury a real entity elsewhere in the tree; the DFS should still locate it.
  const nested = {
    props: { pageProps: { extra: [{ data: { entity: FULL_ENTITY } }] } },
  };
  const buried = html.replace(
    /(<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>)/,
    `$1${JSON.stringify(nested)}$3`,
  );
  const d = parseEmbedNextData(buried);
  assertEquals(d?.name, "Underground Rap Heat 🔥");
  assertEquals(d?.track_count, 3);
});

// --- graceful failure -------------------------------------------------------

Deno.test("parseEmbedNextData returns null on malformed JSON", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{ not: valid json ,,, }</script>`;
  assertEquals(parseEmbedNextData(html), null);
});

Deno.test("parseEmbedNextData returns null when there is no __NEXT_DATA__ script", () => {
  assertEquals(parseEmbedNextData("<html><body>client shell, no data</body></html>"), null);
});

Deno.test("parseEmbedNextData returns null on empty / whitespace input", () => {
  assertEquals(parseEmbedNextData(""), null);
  assertEquals(parseEmbedNextData("   "), null);
});

Deno.test("parseEmbedNextData returns null when the entity has no name", () => {
  assertEquals(parseEmbedNextData(embedHtml({ type: "playlist", subtitle: "No Name Here" })), null);
});

// --- oEmbed fallback --------------------------------------------------------

Deno.test("parseOEmbedTitle extracts the title", () => {
  const json = JSON.stringify({
    title: "Chill House Sessions",
    thumbnail_url: "https://i.scdn.co/image/abc",
    provider_name: "Spotify",
  });
  assertEquals(parseOEmbedTitle(json), "Chill House Sessions");
});

Deno.test("parseOEmbedTitle returns null on malformed or titleless JSON", () => {
  assertEquals(parseOEmbedTitle("{ broken"), null);
  assertEquals(parseOEmbedTitle(JSON.stringify({ thumbnail_url: "x" })), null);
  assertEquals(parseOEmbedTitle(JSON.stringify({ title: "   " })), null);
});
