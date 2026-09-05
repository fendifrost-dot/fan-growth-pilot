import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const callHubFn = vi.fn();

vi.mock("@/lib/hubApi", () => ({
  callHubFn: (...args: unknown[]) => callHubFn(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import AdminSongDna from "@/pages/admin/AdminSongDna";

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminSongDna />
    </MemoryRouter>,
  );
}

const sampleRow = {
  id: "dna-1",
  track_id: "track-1",
  track_name: "Runway Music",
  version_number: 1,
  approval_state: "draft" as const,
  primary_genre: "hip_hop_rap",
  secondary_genres: [],
  approved_lanes: ["rap_general"],
  excluded_lanes: [],
  mood_tags: [],
  context_tags: [],
  reference_artists: [],
  short_pitch: "Song pitch",
  bpm_hint: null,
  energy_hint: null,
  sample_declaration: "no" as const,
  sync_recommendation: "blocked" as const,
  notes: null,
  payload: {},
  created_by: null,
  submitted_at: null,
  approved_by: null,
  approved_at: null,
  rejected_by: null,
  rejected_at: null,
  rejection_reason: null,
  created_at: "2026-09-05T00:00:00Z",
  updated_at: "2026-09-05T00:00:00Z",
};

describe("AdminSongDna load states", () => {
  beforeEach(() => {
    callHubFn.mockReset();
  });

  it("failed list_song_dna renders error state, not empty state", async () => {
    callHubFn.mockImplementation(async (action: string) => {
      if (action === "list_tracks") return { rows: [] };
      if (action === "list_song_dna") {
        throw new Error("Song DNA query failed [PGRST201]: Could not embed because more than one relationship was found for 'tracks'");
      }
      throw new Error(`unexpected action ${action}`);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Song DNA could not be loaded")).toBeTruthy();
    });
    expect(screen.getByText(/PGRST201/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/No Song DNA versions yet/)).toBeNull();
    expect(screen.queryByText(/migration/i)).toBeNull();
  });

  it("successful empty response renders genuine empty state", async () => {
    callHubFn.mockImplementation(async (action: string) => {
      if (action === "list_tracks") return { rows: [] };
      if (action === "list_song_dna") return { rows: [] };
      throw new Error(`unexpected action ${action}`);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No Song DNA versions yet. Create a draft above.")).toBeTruthy();
    });
    expect(screen.queryByText("Song DNA could not be loaded")).toBeNull();
    expect(screen.queryByText(/migration/i)).toBeNull();
  });

  it("successful populated response renders the versions", async () => {
    callHubFn.mockImplementation(async (action: string) => {
      if (action === "list_tracks") {
        return { rows: [{ id: "track-1", name: "Runway Music" }] };
      }
      if (action === "list_song_dna") return { rows: [sampleRow] };
      throw new Error(`unexpected action ${action}`);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Runway Music")).toBeTruthy();
    });
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("hip_hop_rap")).toBeTruthy();
    expect(screen.queryByText("Song DNA could not be loaded")).toBeNull();
    expect(screen.queryByText(/No Song DNA versions yet/)).toBeNull();
  });
});
