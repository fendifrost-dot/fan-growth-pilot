/**
 * Client helpers for the lyric-decoder slot (not active until a provider is chosen).
 */
export type LyricDecoderStatus = {
  provider: string;
  enabled: boolean;
  message?: string;
};

export const LYRIC_DECODER_HUB_ACTIONS = [
  "get_lyric_decoder_status",
  "decode_track_lyrics",
] as const;
