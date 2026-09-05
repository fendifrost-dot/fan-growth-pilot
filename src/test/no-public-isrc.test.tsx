import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EVEN_ARTIST_URL } from "@/lib/syncRegisters";

const SECRET_ISRC = "QZNWX2480001";

let mockSmartLinkData: Record<string, unknown> | null = null;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        or: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: mockSmartLinkData, error: null }),
          })),
        })),
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      })),
      insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: "no-op" }),
      })),
    },
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
  },
}));

vi.mock("hls.js", () => ({
  default: class {
    static isSupported() { return false; }
    static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    loadSource() {}
    attachMedia() {}
    on() {}
    destroy() {}
  },
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderPage(slug: string) {
  const SmartLinkPage = (await import("@/pages/SmartLinkPage")).default;
  let container: HTMLElement;
  await act(async () => {
    const result = render(
      <MemoryRouter initialEntries={[`/${slug}`]}>
        <Routes>
          <Route path="/:slug" element={<SmartLinkPage />} />
        </Routes>
      </MemoryRouter>,
    );
    container = result.container;
    await wait(120);
  });
  return container!;
}

describe("public pages never leak ISRC", () => {
  beforeEach(() => {
    mockSmartLinkData = {
      id: "sl-1",
      title: "Meditate",
      slug: "meditate",
      destination_url: "https://open.spotify.com/track/x",
      theme_preset: "default",
      is_active: true,
      show_email_form: false,
      metadata: {
        spotify_url: "https://open.spotify.com/track/x",
        isrc: SECRET_ISRC,
      },
    };
  });

  it("does not render an ISRC that was stuffed into smart-link metadata", async () => {
    const container = await renderPage("meditate");
    expect(container.textContent).not.toContain(SECRET_ISRC);
    expect(container.textContent).not.toMatch(/ISRC/i);
  });

  it("adds the locked EVEN artist URL to an existing listen-pills stack", async () => {
    const container = await renderPage("meditate");
    const even = container.querySelector('[data-testid="dsp-even"]');
    expect(even).toBeTruthy();
    expect(EVEN_ARTIST_URL).toContain("even.biz/artists/fendi-frost");
  });

  it("does not invent a listen-pills stack on runway when none exists", async () => {
    mockSmartLinkData = {
      id: "sl-2",
      title: "Runway Music",
      slug: "runwaymusic",
      destination_url: "https://links.fendifrost.com/runwaymusic",
      theme_preset: "runway",
      is_active: true,
      show_email_form: false,
      metadata: {},
    };
    const container = await renderPage("runwaymusic");
    expect(container.querySelector('[data-testid="dsp-even"]')).toBeNull();
    expect(container.textContent).not.toMatch(/ISRC/i);
  });
});
