import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// ─── Helpers ───

const makeSmartLink = (overrides: Record<string, any> = {}) => ({
  id: "test-id-123",
  title: "Heart Chakra",
  slug: "heart-chakra",
  destination_url: "https://music.example.com/heart-chakra",
  description: "The debut album",
  image_url: "https://example.com/cover.jpg",
  video_url: null,
  button_text: null,
  button_color: null,
  background_color: "#000000",
  background_image_url: null,
  user_id: "user-1",
  headline: "Heart Chakra",
  subheadline: "A sonic journey",
  video_autoplay: false,
  show_email_form: true,
  bullet_point_1: null,
  bullet_point_2: null,
  bullet_point_3: null,
  testimonial_text: null,
  testimonial_author: null,
  theme_preset: "default",
  is_active: true,
  short_code: "abc123",
  og_image_url: null,
  click_count: 0,
  conversion_count: 0,
  ...overrides,
});

let mockSmartLinkData: any = null;

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        or: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: mockSmartLinkData, error: null }),
          }),
        }),
        eq: (_col: string, _val: any) => ({
          eq: (_col2: string, _val2: any) => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      insert: () => Promise.resolve({ data: null, error: null }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: "no-op" }),
      }),
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
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

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const renderSmartLinkPage = async (slug = "heart-chakra") => {
  const SmartLinkPage = (await import("../pages/SmartLinkPage")).default;
  let container: HTMLElement;
  await act(async () => {
    const result = render(
      <MemoryRouter initialEntries={[`/${slug}`]}>
        <Routes>
          <Route path="/:slug" element={<SmartLinkPage />} />
        </Routes>
      </MemoryRouter>
    );
    container = result.container;
    await wait(100);
  });
  return container!;
};

// ─── Tests ───

describe("Music Template v2 — CTA Label Resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 'Listen Now' when button_text is null", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: null });
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta).toBeTruthy();
    expect(cta!.textContent).toContain("Listen Now");
  });

  it("renders 'Listen Now' when button_text is empty string", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: "" });
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta!.textContent).toContain("Listen Now");
  });

  it("renders 'Listen Now' when button_text is 'Click Here'", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: "Click Here" });
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta!.textContent).toContain("Listen Now");
    expect(cta!.textContent).not.toContain("Click Here");
  });

  it("renders 'Listen Now' when button_text is ' click here ' (case/whitespace)", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: " click here " });
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta!.textContent).toContain("Listen Now");
  });

  it("renders custom button_text 'Stream Heart Chakra' as-is", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: "Stream Heart Chakra" });
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta!.textContent).toContain("Stream Heart Chakra");
  });

  it("NEVER renders 'Click Here' on any music page (default theme)", async () => {
    mockSmartLinkData = makeSmartLink({ button_text: "Click Here", theme_preset: "default" });
    const container = await renderSmartLinkPage();
    expect(container.textContent).not.toContain("Click Here");
  });

  it("NEVER renders 'Click Here' on runway theme", async () => {
    mockSmartLinkData = makeSmartLink({
      button_text: "Click Here",
      theme_preset: "runway",
      video_url: "https://example.com/video.mp4",
    });
    const container = await renderSmartLinkPage("runway-music");
    expect(container.textContent).not.toContain("Click Here");
  });
});

describe("Music Template v2 — Above-the-fold CTA (mobile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CTA button is present and visible in DOM", async () => {
    mockSmartLinkData = makeSmartLink();
    const container = await renderSmartLinkPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta).toBeTruthy();
  });

  it("email accordion content is collapsed by default", async () => {
    mockSmartLinkData = makeSmartLink({ show_email_form: true });
    const container = await renderSmartLinkPage();
    const trigger = container.querySelector('[data-testid="email-plaque-trigger"]');
    expect(trigger).toBeTruthy();
    const form = container.querySelector('[data-testid="email-form"]');
    expect(form).toBeNull();
  });
});

describe("Music Template v2 — No fashion leakage on music pages", () => {
  const FORBIDDEN_TERMS = ["bemoremodest", "discount", "capsule", "clothing"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Heart Chakra page contains no fashion/discount terms", async () => {
    mockSmartLinkData = makeSmartLink({ slug: "heart-chakra", title: "Heart Chakra" });
    const container = await renderSmartLinkPage();
    const text = container.textContent?.toLowerCase() || "";
    for (const term of FORBIDDEN_TERMS) {
      expect(text).not.toContain(term);
    }
  });

  it("Runway Music page contains no fashion/discount terms", async () => {
    mockSmartLinkData = makeSmartLink({
      slug: "runway-music",
      title: "Runway Music",
      theme_preset: "runway",
      video_url: "https://example.com/runway.mp4",
    });
    const container = await renderSmartLinkPage("runway-music");
    const text = container.textContent?.toLowerCase() || "";
    for (const term of FORBIDDEN_TERMS) {
      expect(text).not.toContain(term);
    }
  });
});

describe("Music Template v2 — Email capture accordion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expanding accordion reveals email form", async () => {
    mockSmartLinkData = makeSmartLink({ show_email_form: true });
    const container = await renderSmartLinkPage();
    const trigger = container.querySelector('[data-testid="email-plaque-trigger"]');
    expect(trigger).toBeTruthy();

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await wait(100);
    });

    const form = container.querySelector('[data-testid="email-form"]');
    expect(form).toBeTruthy();
  });
});
