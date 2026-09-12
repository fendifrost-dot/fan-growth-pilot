import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const callHubFn = vi.fn();

vi.mock("@/lib/hubApi", () => ({
  callHubFn: (...args: unknown[]) => callHubFn(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import AdminCatalogue from "@/pages/admin/AdminCatalogue";

const trackRow = {
  id: "track-generic",
  name: "Runway Music",
  isrc: null,
  spotify_url: null,
  apple_music_url: null,
  soundcloud_url: null,
  status: "active",
  release_date: null,
  default_tone: "warm_personal",
  short_pitch: null,
  pitch_angle: null,
  reference_artists: [],
  notes: null,
  updated_at: "2026-09-12T00:00:00Z",
  aggregator: "open",
  genre_stamp: "unknown",
  has_sample: "unknown",
  sync_eligible: false,
  sync_eligible_blockers: ["fendi_sample_declaration_approval", "fendi_sync_approval"],
  sync_approved_at: null,
  sync_approved_by: null,
  sample_declaration_approved_at: null,
  sample_declaration_approved_by: null,
  assets_ready: false,
  publishing_ready: false,
  splits_ready: false,
  splits_ready_source: "none",
  outreach_eligibility: "needs_song_intelligence",
  is_month1_sync_default: false,
  track_categories: [],
};

const eligibilityPayload = {
  ok: true,
  track: {
    ...trackRow,
  },
  dna: {
    id: "dna-1",
    version_number: 2,
    approval_state: "approved",
    sample_declaration: "no",
    sync_recommendation: "candidate",
    approved_lanes: ["rap_general"],
  },
  eligibility: {
    track_id: trackRow.id,
    eligible: false,
    blockers: ["fendi_sample_declaration_approval", "fendi_sync_approval", "required_splits"],
    reasons: [
      "Fendi-approved sample declaration required",
      "Fendi sync approval required",
      "Authoritative finalized split sheet required",
    ],
    song_dna_version_id: "dna-1",
    computed_at: "2026-09-12T00:00:00Z",
  },
  dna_sync_recommendation: "candidate",
  track_sync_eligible: false,
  computed_sync_eligible: false,
  dna_conflicts_with_computed: false,
  playlist_vs_sync: {
    outreach_eligibility: "needs_song_intelligence",
    note: "Playlist/outreach eligibility and Song DNA approved_lanes do not grant sync eligibility.",
  },
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminCatalogue />
    </MemoryRouter>,
  );
}

describe("AdminCatalogue sync eligibility panel", () => {
  beforeEach(() => {
    callHubFn.mockReset();
  });

  it("opens a saved track and shows blockers, sample confirm, and YES/NO without title hardcodes", async () => {
    callHubFn.mockImplementation(async (action: string) => {
      if (action === "list_tracks") return { rows: [trackRow] };
      if (action === "list_categories") return { rows: [] };
      if (action === "get_sync_eligibility") return eligibilityPayload;
      throw new Error(`unexpected action ${action}`);
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Runway Music")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Runway Music"));

    await waitFor(() => {
      expect(screen.getByTestId("sync-eligibility-panel")).toBeTruthy();
    });
    expect(screen.getByTestId("confirm-sample-declaration")).toBeTruthy();
    expect(screen.getByTestId("sync-eligibility-yes")).toBeTruthy();
    expect(screen.getByTestId("sync-eligibility-no")).toBeTruthy();
    expect(screen.getByTestId("sync-eligibility-blockers").textContent).toMatch(
      /Fendi sample-declaration approval/,
    );
    expect(screen.getByText(/Playlist\/outreach status/)).toBeTruthy();
    expect(screen.getByText(/do not grant sync/)).toBeTruthy();
    expect(screen.queryByText(/Meditate/)).toBeNull();
    expect(screen.queryByText(/Designed For Me/)).toBeNull();
  });

  it("confirm sample and set YES call the existing gate actions", async () => {
    callHubFn.mockImplementation(async (action: string, body?: Record<string, unknown>) => {
      if (action === "list_tracks") return { rows: [trackRow] };
      if (action === "list_categories") return { rows: [] };
      if (action === "get_sync_eligibility") return eligibilityPayload;
      if (action === "approve_sample_declaration") {
        expect(body?.track_id).toBe("track-generic");
        expect(body?.sample_declaration).toBe("unknown");
        return { ok: true, eligibility: { eligible: false } };
      }
      if (action === "approve_sync_eligibility") {
        expect(body?.track_id).toBe("track-generic");
        expect(body?.decision).toBe("yes");
        return { ok: true, eligibility: { eligible: false } };
      }
      throw new Error(`unexpected action ${action}`);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("Runway Music")).toBeTruthy());
    fireEvent.click(screen.getByText("Runway Music"));
    await waitFor(() => expect(screen.getByTestId("confirm-sample-declaration")).toBeTruthy());

    fireEvent.click(screen.getByTestId("confirm-sample-declaration"));
    await waitFor(() => {
      expect(callHubFn).toHaveBeenCalledWith(
        "approve_sample_declaration",
        expect.objectContaining({ track_id: "track-generic", sample_declaration: "unknown" }),
      );
    });

    fireEvent.click(screen.getByTestId("sync-eligibility-yes"));
    await waitFor(() => {
      expect(callHubFn).toHaveBeenCalledWith(
        "approve_sync_eligibility",
        expect.objectContaining({ track_id: "track-generic", decision: "yes" }),
      );
    });
  });
});
