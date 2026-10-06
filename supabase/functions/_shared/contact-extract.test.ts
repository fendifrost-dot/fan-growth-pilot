import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractIgHandle,
  isValidCuratorIgHandle,
  sanitizeCuratorIgHandle,
} from "./contact-extract.ts";

Deno.test("dotted IG handles pass; URLs and web domains fail", () => {
  assertEquals(isValidCuratorIgHandle("inharmony.wav"), true);
  assertEquals(isValidCuratorIgHandle("@dlo.chi"), true);
  assertEquals(isValidCuratorIgHandle("curator.music"), true);
  assertEquals(sanitizeCuratorIgHandle("inharmony.wav"), "inharmony.wav");
  assertEquals(sanitizeCuratorIgHandle("@dlo.chi"), "dlo.chi");

  assertEquals(isValidCuratorIgHandle("www.example.com"), false);
  assertEquals(isValidCuratorIgHandle("instagram.com/foo"), false);
  assertEquals(sanitizeCuratorIgHandle("www.example.com"), null);
  assertEquals(sanitizeCuratorIgHandle("instagram.com/foo"), null);
  assertEquals(sanitizeCuratorIgHandle("https://instagram.com/inharmony.wav"), null);
  assertEquals(isValidCuratorIgHandle("example.com"), false);
  assertEquals(isValidCuratorIgHandle("example.net"), false);
  assertEquals(isValidCuratorIgHandle("example.org"), false);
  assertEquals(isValidCuratorIgHandle("example.io"), false);
  assertEquals(isValidCuratorIgHandle("example.co"), false);
});

Deno.test("IG handle shape: no edge or consecutive periods; corporate and chrome stay rejected", () => {
  assertEquals(isValidCuratorIgHandle(".wav"), false);
  assertEquals(isValidCuratorIgHandle("dlo."), false);
  assertEquals(isValidCuratorIgHandle("in..harmony"), false);
  assertEquals(isValidCuratorIgHandle("a_b.1"), true);
  assertEquals(isValidCuratorIgHandle("spotify"), false);
  assertEquals(isValidCuratorIgHandle("spotifyusa"), false);
  assertEquals(isValidCuratorIgHandle("instagram"), false);
  assertEquals(isValidCuratorIgHandle("explore"), false);
  assertEquals(isValidCuratorIgHandle("reels"), false);
  assertEquals(extractIgHandle("https://www.instagram.com/inharmony.wav/"), "inharmony.wav");
  assertEquals(extractIgHandle("https://www.instagram.com/example.com/"), null);
  assertEquals(extractIgHandle("https://www.instagram.com/spotify/"), null);
});
