import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Track rpc calls
const rpcMock = vi.fn((..._args: any[]) => Promise.resolve({ data: null, error: null }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "smart_links") {
        return {
          select: () => ({
            or: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: "test-link-id",
                      title: "Test Link",
                      slug: "test-slug",
                      destination_url: "https://example.com",
                      is_active: true,
                      user_id: "user-1",
                      show_email_form: true,
                      theme_preset: "default",
                      bullet_point_1: "First point",
                    },
                    error: null,
                  }),
              }),
            }),
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: "test-link-id",
                    title: "Test Link",
                    slug: "test-slug",
                    destination_url: "https://example.com",
                    is_active: true,
                    user_id: "user-1",
                    show_email_form: true,
                    theme_preset: "default",
                    bullet_point_1: "First point",
                  },
                  error: null,
                }),
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
    rpc: rpcMock,
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({ data: null, error: { message: "not found" } }),
      }),
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      getSession: () =>
        Promise.resolve({ data: { session: null }, error: null }),
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

const originalLocation = window.location;
beforeEach(() => {
  rpcMock.mockClear();
  Object.defineProperty(window, "location", {
    writable: true,
    value: { ...originalLocation, href: originalLocation.href },
  });
});

async function renderPage() {
  const SmartLinkPage = (await import("../pages/SmartLinkPage")).default;
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={["/test-slug"]}>
        <Routes>
          <Route path="/:slug" element={<SmartLinkPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
  // Wait for async data fetch
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return result;
}

function click(el: Element) {
  const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(evt);
}

describe("Conversion Tracking", () => {
  it("CTA click triggers increment_cta_click RPC before redirect", async () => {
    const { container } = await renderPage();
    const cta = container.querySelector('[data-testid="album-cta"]');
    expect(cta).toBeTruthy();

    await act(async () => { click(cta!); });

    const ctaCalls = rpcMock.mock.calls.filter(
      (c) => c[0] === "increment_cta_click"
    );
    expect(ctaCalls.length).toBe(1);
    expect((ctaCalls[0] as any[])[1]).toEqual({ link_id: "test-link-id" });
  });

  it("Accordion open triggers increment_accordion_open RPC only once", async () => {
    const { container } = await renderPage();
    const trigger = container.querySelector('[data-testid="email-plaque-trigger"]');
    expect(trigger).toBeTruthy();

    // First open
    await act(async () => { click(trigger!); });

    let accordionCalls = rpcMock.mock.calls.filter(
      (c) => c[0] === "increment_accordion_open"
    );
    expect(accordionCalls.length).toBe(1);

    // Close
    await act(async () => { click(trigger!); });
    // Re-open — should NOT fire again
    await act(async () => { click(trigger!); });

    accordionCalls = rpcMock.mock.calls.filter(
      (c) => c[0] === "increment_accordion_open"
    );
    expect(accordionCalls.length).toBe(1);
  });

  it("Email submit triggers increment_email_submit RPC only on success", async () => {
    const { container } = await renderPage();

    // Open accordion
    const trigger = container.querySelector('[data-testid="email-plaque-trigger"]');
    await act(async () => { click(trigger!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const form = container.querySelector('[data-testid="email-form"]');
    expect(form).toBeTruthy();

    const emailInput = form!.querySelector('input[type="email"]') as HTMLInputElement;
    expect(emailInput).toBeTruthy();

    // Set value natively
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "value"
    )!.set!;
    nativeInputValueSetter.call(emailInput, "test@example.com");
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));
    emailInput.dispatchEvent(new Event("change", { bubbles: true }));

    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

    const emailCalls = rpcMock.mock.calls.filter(
      (c) => c[0] === "increment_email_submit"
    );
    expect(emailCalls.length).toBe(1);
    expect((emailCalls[0] as any[])[1]).toEqual({ link_id: "test-link-id" });
  });

  it("No video RPC called when video_url is null", async () => {
    await renderPage();

    const videoPlayCalls = rpcMock.mock.calls.filter(
      (c) => c[0] === "increment_video_play"
    );
    expect(videoPlayCalls.length).toBe(0);
  });
});
