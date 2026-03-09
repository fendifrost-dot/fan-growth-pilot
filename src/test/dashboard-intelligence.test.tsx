import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { 
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user" } } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          gt: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          gte: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          is: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    }),
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: { from: vi.fn(() => ({ createSignedUrl: vi.fn() })) },
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
};

describe("Dashboard Intelligence Sections", () => {
  it("renders the main dashboard with new intelligence sections", async () => {
    const Index = (await import("@/pages/Index")).default;
    const { container } = render(<Index />, { wrapper });
    expect(container.querySelector("main")).toBeTruthy();
    expect(container.textContent).toContain("Performance Overview");
    expect(container.textContent).toContain("Fan Intelligence");
    expect(container.textContent).toContain("Fan Database");
  });

  it("FanDatabaseOverview renders", async () => {
    const { FanDatabaseOverview } = await import("@/components/FanDatabaseOverview");
    const { container } = render(<FanDatabaseOverview />, { wrapper });
    expect(container.firstChild).toBeTruthy();
  });

  it("MomentumAlerts renders", async () => {
    const { MomentumAlerts } = await import("@/components/MomentumAlerts");
    const { container } = render(<MomentumAlerts />, { wrapper });
    expect(container.firstChild).toBeTruthy();
  });

  it("MarketingRecommendations renders", async () => {
    const { MarketingRecommendations } = await import("@/components/MarketingRecommendations");
    const { container } = render(<MarketingRecommendations />, { wrapper });
    expect(container.firstChild).toBeTruthy();
  });

  it("IntelligenceControl renders", async () => {
    const { IntelligenceControl } = await import("@/components/IntelligenceControl");
    const { container } = render(<IntelligenceControl />, { wrapper });
    expect(container.textContent).toContain("Fan Intelligence Engine");
  });

  it("preserves existing Smart Links section", async () => {
    const Index = (await import("@/pages/Index")).default;
    const { container } = render(<Index />, { wrapper });
    expect(container.textContent).toContain("Smart Links");
    expect(container.textContent).toContain("Ready to grow your fanbase?");
  });
});
