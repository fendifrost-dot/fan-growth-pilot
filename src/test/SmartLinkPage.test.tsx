import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Mock supabase client
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        or: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    },
  },
}));

// Mock hls.js
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

describe("SmartLinkPage", () => {
  it("renders without crashing", async () => {
    const SmartLinkPage = (await import("../pages/SmartLinkPage")).default;
    
    const { container } = render(
      <MemoryRouter initialEntries={["/test-slug"]}>
        <Routes>
          <Route path="/:slug" element={<SmartLinkPage />} />
        </Routes>
      </MemoryRouter>
    );

    // Component should render
    expect(container).toBeTruthy();
  });
});
