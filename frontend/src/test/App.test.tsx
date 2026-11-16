import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api, ApiError } from "@/services/api";
import { midiToNoteName, formatDuration, formatBytes } from "@/lib/utils";

vi.mock("@/features/auth/AuthContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/auth/AuthContext")>();
  return {
    ...actual,
    useAuth: () => ({
      user: { id: "u1", email: "test@example.com", display_name: "Tester", email_verified: true, plan_tier: "free", created_at: "", updated_at: "" },
      usage: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    }),
  };
});

describe("ScribaSheet Frontend", () => {
  it("renders landing page headline and primary CTA", () => {
    render(<App />);
    expect(screen.getByText(/Turn Any Performance Into Sheet Music/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Transcribing/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /See How It Works/i })).toBeInTheDocument();
  });

  it("formats musical pitch and media helpers accurately", () => {
    expect(midiToNoteName(60)).toBe("C4");
    expect(midiToNoteName(69)).toBe("A4");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("displays clear empty state when score does not exist yet (404)", async () => {
    vi.spyOn(api, "getProject").mockResolvedValueOnce({
      id: "p1",
      user_id: "u1",
      title: "test1",
      description: "",
      status: "draft",
      instrument: "piano",
      transcription_mode: "single_instrument",
      duration_seconds: 13.2,
      created_at: "",
      updated_at: "",
      media_assets: [],
    });
    vi.spyOn(api, "listTranscriptions").mockResolvedValueOnce([]);
    vi.spyOn(api, "getScore").mockRejectedValueOnce(new ApiError(404, "No transcription score exists yet for this project."));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/p1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/No Transcription Score Generated Yet/i)).toBeInTheDocument();
    });
  });
});
