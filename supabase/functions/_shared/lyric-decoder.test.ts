import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decodeLyrics,
  isLyricDecoderAction,
  nullLyricDecoder,
  runLyricDecoderAction,
  setLyricDecoderProvider,
} from "./lyric-decoder.ts";

Deno.test("lyric decoder wiring is present and disabled by default", async () => {
  setLyricDecoderProvider(nullLyricDecoder);
  assertEquals(isLyricDecoderAction("get_lyric_decoder_status"), true);
  assertEquals(isLyricDecoderAction("draft_pitch"), false);
  const status = await runLyricDecoderAction("get_lyric_decoder_status", {});
  assertEquals(status.status, 200);
  assertEquals(status.data.enabled, false);
  const decoded = await decodeLyrics({ trackId: "t1" });
  assertEquals(decoded.status, "disabled");
});
