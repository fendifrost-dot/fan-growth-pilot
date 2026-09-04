/**
 * Lyric decoder provider slot.
 *
 * Not wired to a live vendor yet — keep this interface stable so a real decoder
 * can be dropped in without touching outreach / catalog paths.
 *
 * Config: artist_config key `lyric_decoder` = { "provider": "none"|"...", "enabled": false }
 * Default: disabled. Do not invent lyrics.
 */

export type LyricDecoderProviderId = "none" | "custom";

export type LyricDecoderRequest = {
  trackId: string;
  audioUrl?: string | null;
  title?: string | null;
  artistName?: string | null;
};

export type LyricDecoderResult = {
  provider: LyricDecoderProviderId;
  status: "disabled" | "ok" | "error" | "not_configured";
  lyrics?: string | null;
  language?: string | null;
  confidence?: number | null;
  error?: string;
};

export type LyricDecoderProvider = {
  id: LyricDecoderProviderId;
  decode(req: LyricDecoderRequest): Promise<LyricDecoderResult>;
};

/** Null provider — always returns disabled. Swap this for a real implementation later. */
export const nullLyricDecoder: LyricDecoderProvider = {
  id: "none",
  async decode(_req) {
    return {
      provider: "none",
      status: "disabled",
      lyrics: null,
      error: "Lyric decoder not configured. Set artist_config.lyric_decoder when a provider is chosen.",
    };
  },
};

let activeProvider: LyricDecoderProvider = nullLyricDecoder;

/** Register a provider implementation (tests / future edge wiring). */
export function setLyricDecoderProvider(provider: LyricDecoderProvider | null): void {
  activeProvider = provider ?? nullLyricDecoder;
}

export function getLyricDecoderProvider(): LyricDecoderProvider {
  return activeProvider;
}

export async function decodeLyrics(req: LyricDecoderRequest): Promise<LyricDecoderResult> {
  if (!req.trackId?.trim()) {
    return { provider: activeProvider.id, status: "error", error: "trackId required" };
  }
  return activeProvider.decode(req);
}

/** Hub action names reserved for when a provider is plugged in. */
export const LYRIC_DECODER_ACTIONS = [
  "decode_track_lyrics",
  "get_lyric_decoder_status",
] as const;

export function isLyricDecoderAction(action: string): boolean {
  return (LYRIC_DECODER_ACTIONS as readonly string[]).includes(action);
}

export async function runLyricDecoderAction(
  action: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (action === "get_lyric_decoder_status") {
    return {
      status: 200,
      data: {
        ok: true,
        provider: activeProvider.id,
        enabled: false,
        message: "Wiring ready — no lyric decoder plugged in.",
      },
    };
  }
  if (action === "decode_track_lyrics") {
    const result = await decodeLyrics({
      trackId: String(body.track_id ?? ""),
      audioUrl: body.audio_url == null ? null : String(body.audio_url),
      title: body.title == null ? null : String(body.title),
      artistName: body.artist_name == null ? null : String(body.artist_name),
    });
    return { status: result.status === "error" ? 400 : 200, data: { ok: result.status !== "error", ...result } };
  }
  return { status: 400, data: { error: `Unknown lyric decoder action: ${action}` } };
}
