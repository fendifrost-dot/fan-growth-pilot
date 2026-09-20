import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.fn();
const from = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    from: (...a: unknown[]) => from(...a),
  },
}));

import { useArtistStats } from "@/hooks/useArtistStats";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useArtistStats refresh (Spotify metrics fix)", () => {
  beforeEach(() => {
    invoke.mockReset();
    from.mockReset();
    // fan_data read used by the query
    from.mockReturnValue({
      select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
    });
    invoke.mockResolvedValue({ data: {}, error: null });
  });

  it("refreshes Spotify via scrape-chartmetric, never the broken fetch-public-spotify-data", async () => {
    const { result } = renderHook(() => useArtistStats(), { wrapper });

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(invoke).toHaveBeenCalled());

    const invokedFns = invoke.mock.calls.map((c) => c[0]);
    expect(invokedFns).toContain("scrape-chartmetric");
    // The empty-body call to this function always 400s — it must not be used.
    expect(invokedFns).not.toContain("fetch-public-spotify-data");
  });

  it("surfaces a hard failure of the primary Spotify source", async () => {
    invoke.mockImplementation((fn: string) => {
      if (fn === "scrape-chartmetric") {
        return Promise.resolve({ data: null, error: { message: "chartmetric down" } });
      }
      return Promise.resolve({ data: {}, error: null });
    });

    const { result } = renderHook(() => useArtistStats(), { wrapper });

    let caught: unknown = null;
    await act(async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          result.current.refresh(undefined, {
            onSuccess: () => resolve(),
            onError: (e) => {
              caught = e;
              reject(e);
            },
          });
        });
      } catch {
        /* expected */
      }
    });

    expect(caught).toBeTruthy();
  });
});
