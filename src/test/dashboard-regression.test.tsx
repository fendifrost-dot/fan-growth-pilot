import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user" } } }), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(() => ({ data: [], error: null })), maybeSingle: vi.fn(() => ({ data: null, error: null })) })) })) })),
    rpc: vi.fn(),
    storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn() })) },
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: vi.fn(() => vi.fn()), Navigate: () => null };
});

describe("Dashboard regression: no Connected Accounts", () => {
  it("Index page does not render legacy 'Connected Accounts' section", async () => {
    const { default: Index } = await import("@/pages/Index");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { BrowserRouter } = await import("react-router-dom");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <Index />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const text = container.textContent ?? "";
    // Legacy OAuth account panel must stay gone.
    expect(text).not.toContain("Connected Accounts");
    // Current dashboard anchors.
    expect(text).toMatch(/Smart Links/);
    expect(text).toMatch(/Performance Overview/);
  });
});
