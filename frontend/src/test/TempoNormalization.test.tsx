import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { prepareDisplayMusicXml } from "@/features/editor/musicXmlNormalization";
import { ProjectStudioPage } from "@/features/projects/ProjectStudioPage";
import { api } from "@/services/api";
import type { Project, ProjectScoreResponse } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: "u1", email: "user@example.com", display_name: "James", is_unlimited: false },
    usage: {
      plan_tier: "pro",
      monthly_minutes_used: 10,
      monthly_minutes_limit: 120,
      project_count: 1,
      project_limit: 20,
      storage_used_mb: 5,
      storage_limit_mb: 500,
    },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock("opensheetmusicdisplay", () => ({
  OpenSheetMusicDisplay: function MockOSMD() {
    return {
      load: async () => undefined,
      render: () => undefined,
      Dispose: () => undefined,
      Zoom: 1,
      EngravingRules: { RenderChordSymbols: true },
      cursor: {
        cursorElement: document.createElement("img"),
        show: () => undefined,
        hide: () => undefined,
        reset: () => undefined,
        next: () => undefined,
        update: () => undefined,
        GNotesUnderCursor: () => [],
        iterator: { EndReached: true, currentTimeStamp: { RealValue: 0 } },
      },
      GraphicSheet: { MeasureList: [] },
    };
  },
}));

describe("BPM rounding and MusicXML tempo normalization", () => {
  it("rounds decimal per-minute, sound tempo, and tempo words while preserving unrelated decimals", () => {
    const legacyXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>85.7</per-minute></metronome>
        </direction-type>
        <sound tempo="85.7"/>
      </direction>
      <direction placement="above">
        <direction-type>
          <words>♩ = 85.4</words>
        </direction-type>
      </direction>
      <direction placement="above">
        <direction-type>
          <words>rit. 1.5x</words>
        </direction-type>
      </direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
        <lyric number="1"><text>1.2</text></lyric>
      </note>
    </measure>
  </part>
</score-partwise>`;

    const normalized = prepareDisplayMusicXml(legacyXml, true);
    expect(normalized).toContain("<per-minute>86</per-minute>");
    expect(normalized).toContain('tempo="86"');
    expect(normalized).toContain("<words>♩ = 85</words>");
    expect(normalized).toContain("<words>rit. 1.5x</words>");
    expect(normalized).toContain("<text>1.2</text>");
    expect(normalized).not.toContain("85.7");
    expect(normalized).not.toContain("85.4");

    // Idempotent on already-whole-number BPMs
    expect(prepareDisplayMusicXml(normalized, true)).toContain("<per-minute>86</per-minute>");
  });

  it("displays rounded whole-number BPM in ProjectStudioPage header while preserving (est.) label", async () => {
    const project: Project = {
      id: "proj-closer",
      user_id: "u1",
      title: "Closer Piano Cover",
      description: "",
      status: "ready",
      instrument: "piano",
      transcription_mode: "single_instrument",
      duration_seconds: 12,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      media_assets: [],
    };
    const scoreResp: ProjectScoreResponse = {
      id: "score-closer",
      project_id: "proj-closer",
      version: 1,
      updated_at: new Date().toISOString(),
      score_json: {
        title: "Closer Piano Cover",
        tempo_bpm: 85.7,
        tempo_estimated: true,
        key_signature: "C",
        key_signature_estimated: false,
        time_signature: "4/4",
        time_signature_estimated: false,
        duration_seconds: 4,
        tracks: [{ index: 0, name: "Piano", instrument: "piano", clef: "treble", program: 0, muted: false }],
        notes: [{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 0 }],
        chords: [],
        analysis: { mode: "single_instrument" },
      },
      musicxml: "<score-partwise/>",
    };

    vi.spyOn(api, "getProject").mockResolvedValue(project);
    vi.spyOn(api, "listTranscriptions").mockResolvedValue([]);
    vi.spyOn(api, "getScore").mockResolvedValue(scoreResp);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects/proj-closer"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<ProjectStudioPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const bpmEl = await screen.findByText(/86 BPM \(est\.\)/i);
    expect(bpmEl).toBeTruthy();
    expect(screen.queryByText(/85\.7 BPM/i)).toBeNull();
  });
});
