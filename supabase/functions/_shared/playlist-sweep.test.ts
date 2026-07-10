import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BOT_RISK_THRESHOLD,
  classifyFeel,
  computeBotRisk,
  FEEL_MIN_CONFIDENCE,
} from "./playlist-sweep.ts";

// --- bot_risk: known-bot fixtures ------------------------------------------

Deno.test("computeBotRisk flags a Spotify editorial playlist as high-risk", () => {
  const { bot_risk, reasons } = computeBotRisk({
    playlist_id: "spotify:37i9dQZF1DX0XUsuxWHRQd",
    name: "RapCaviar",
    description: "The world's biggest hip-hop playlist.",
    owner: "Spotify",
    owner_id: "spotify",
    followers: 15_000_000,
    track_count: 50,
  });
  assertEquals(bot_risk >= BOT_RISK_THRESHOLD, true, `editorial should exceed threshold, got ${bot_risk}`);
  assertEquals(reasons.includes("editorial_prefix"), true);
});

Deno.test("computeBotRisk flags a nameless, ownerless, empty playlist", () => {
  const { bot_risk, reasons } = computeBotRisk({
    playlist_id: "spotify:abc123",
    name: "Playlist a1b2c3",
    description: "",
    owner: "",
    owner_id: "",
    followers: 5000,
    track_count: 0,
  });
  // missing_identity(25) + generic_name(20) + empty_description(10) + followers_without_tracks(15) = 70
  assertEquals(bot_risk >= BOT_RISK_THRESHOLD, true, `got ${bot_risk}`);
  assertEquals(reasons.includes("missing_identity"), true);
  assertEquals(reasons.includes("generic_name"), true);
  assertEquals(reasons.includes("followers_without_tracks"), true);
});

Deno.test("computeBotRisk flags an implausible follower:track ratio", () => {
  const { reasons } = computeBotRisk({
    playlist_id: "spotify:xyz",
    name: "Fresh Trap Bangers",
    description: "Weekly trap picks.",
    owner: "beatplug",
    owner_id: "beatplug",
    followers: 800_000,
    track_count: 10, // 80k followers/track
  });
  assertEquals(reasons.includes("implausible_follower_track_ratio"), true);
});

// --- bot_risk: known-good fixtures -----------------------------------------

Deno.test("computeBotRisk keeps a real independent curator low-risk", () => {
  const { bot_risk } = computeBotRisk({
    playlist_id: "spotify:realcurator1",
    name: "Underground Boom Bap Weekly",
    description: "Handpicked boom bap gems, updated every Friday by a lifelong crate digger.",
    owner: "cratedigger",
    owner_id: "cratedigger",
    followers: 12_000,
    track_count: 90,
  });
  assertEquals(bot_risk < BOT_RISK_THRESHOLD, true, `real curator should be low-risk, got ${bot_risk}`);
});

Deno.test("computeBotRisk never exceeds 100 and never throws on partial data", () => {
  const { bot_risk } = computeBotRisk({});
  assertEquals(bot_risk >= 0 && bot_risk <= 100, true);
});

// --- feel classifier: known-good buckets -----------------------------------

Deno.test("classifyFeel buckets a workout playlist as gym_workout", () => {
  const { category } = classifyFeel(
    "Gym Rap Workout Motivation",
    "Hard hitting tracks for the gym and heavy lifting sessions.",
    ["trap"],
  );
  assertEquals(category, "gym_workout");
});

Deno.test("classifyFeel buckets a late-night lofi playlist as late_night_chill", () => {
  const { category } = classifyFeel(
    "Late Night Lofi Chill",
    "Mellow lo-fi and deep house to unwind after hours.",
    ["deep house"],
  );
  assertEquals(category, "late_night_chill");
});

Deno.test("classifyFeel buckets a club playlist as party_house", () => {
  const { category } = classifyFeel(
    "Weekend Tech House Party",
    "Peak time club and dancefloor bangers for the rave.",
    ["tech house"],
  );
  assertEquals(category, "party_house");
});

Deno.test("classifyFeel returns confidence in [0,1]", () => {
  const { confidence } = classifyFeel("Hype Turnt Bangers", "Turn up energy", []);
  assertEquals(confidence >= 0 && confidence <= 1, true);
});

// --- feel classifier: fallback ---------------------------------------------

Deno.test("classifyFeel falls back to uncategorized on no signal", () => {
  const { category, confidence } = classifyFeel("Playlist 42", "", []);
  assertEquals(category, "uncategorized");
  assertEquals(confidence, 0);
});

Deno.test("classifyFeel falls back to uncategorized when the leader is too weak", () => {
  // One weak signal split against noise should land under FEEL_MIN_CONFIDENCE.
  const res = classifyFeel("Random Mix", "", []);
  assertEquals(res.category, "uncategorized");
  assertEquals(res.confidence < FEEL_MIN_CONFIDENCE, true);
});
