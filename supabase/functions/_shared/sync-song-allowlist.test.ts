import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_SYNC_SONG_ALLOWLIST,
  parseSyncSongAllowlist,
  songOnAllowlist,
} from "./sync-song-allowlist.ts";
import { syncPositiveFee, syncTermsStatusAtSend } from "./sync-fee.ts";

Deno.test("allowlist parse: missing stays null, empty array is a pause, names are trimmed", () => {
  assertEquals(parseSyncSongAllowlist(undefined), null);
  assertEquals(parseSyncSongAllowlist(null), null);
  assertEquals(parseSyncSongAllowlist([]), []);
  assertEquals(parseSyncSongAllowlist([" Meditate ", ""]), ["Meditate"]);
  assertEquals(parseSyncSongAllowlist({ songs: ["Aura"] }), ["Aura"]);
  assertEquals(parseSyncSongAllowlist({}), []);
  assertEquals(DEFAULT_SYNC_SONG_ALLOWLIST, ["Meditate"]);
});

Deno.test("allowlist match is case-insensitive on name or track id", () => {
  assertEquals(songOnAllowlist(["Meditate"], { id: "abc", name: "meditate" }), true);
  assertEquals(songOnAllowlist(["abc"], { id: "ABC", name: "Aura" }), true);
  assertEquals(songOnAllowlist(["Meditate"], { id: "abc", name: "Aura" }), false);
  assertEquals(songOnAllowlist([], { id: "abc", name: "Meditate" }), false);
});

Deno.test("sync fee: positive evidence blocks, unknown and negated notes do not", () => {
  assertEquals(syncPositiveFee({
    official_url: "https://www.taxi.com/join",
    source_evidence: "membership",
  }).blocked, true);
  assertEquals(syncPositiveFee({
    official_url: "https://www.submithub.com/p",
    source_evidence: "credits",
  }).blocked, true);
  assertEquals(syncPositiveFee({
    official_url: "https://www.songtradr.com/pricing",
    source_evidence: "Premium tier required for this catalogue.",
  }).detail, "songtradr_paid_tier");
  assertEquals(syncPositiveFee({
    official_url: "https://www.songtradr.com/",
    source_evidence: "Open submission. No fee stated.",
  }).blocked, false);
  assertEquals(syncPositiveFee({
    source_evidence: "Only open route is paid Patreon = pay-to-play.",
  }).blocked, true);
  assertEquals(syncPositiveFee({
    source_evidence: "This inbox is not pay-to-play. Terms unknown.",
  }).blocked, false);
  assertEquals(syncPositiveFee({
    submission_policy: "free_unsolicited",
    compensation_known: "",
    source_evidence: "Commission on the license only. No per submission fee.",
  }).blocked, false);
  assertEquals(syncTermsStatusAtSend({ submission_policy: "free_unsolicited" }), "free");
  assertEquals(syncTermsStatusAtSend({ source_evidence: "No fee stated" }), "unknown");
  assertEquals(syncTermsStatusAtSend(null), "unknown");
});
