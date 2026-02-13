import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { UploadEvenCSV } from "../components/UploadEvenCSV";

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "test" } }, error: null }),
    },
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  },
}));

describe("UploadEvenCSV", () => {
  it("renders upload button", () => {
    const { getByText } = render(<UploadEvenCSV />);
    expect(getByText("Upload EVEN CSV")).toBeTruthy();
  });

  it("renders description text", () => {
    const { getByText } = render(<UploadEvenCSV />);
    expect(getByText(/cross-reference with smart link leads/)).toBeTruthy();
  });

  it("has hidden file input", () => {
    render(<UploadEvenCSV />);
    const input = document.getElementById("even-csv-upload") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".csv");
  });
});
