import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SATBMixerPanel } from "@/features/editor/SATBMixerPanel";
import { api } from "@/services/api";
import type { ScoreData } from "@/types/api";

const sampleSatbScore: ScoreData = {
  title: "Hymn SATB",
  tempo_bpm: 100,
  tempo_estimated: false,
  time_signature: "4/4",
  time_signature_estimated: false,
  key_signature: "C major",
  key_signature_estimated: false,
  duration_seconds: 2.0,
  tracks: [
    { index: 0, name: "Soprano", instrument: "choir_aahs", clef: "treble", program: 52, muted: false },
    { index: 1, name: "Alto", instrument: "choir_aahs", clef: "treble", program: 52, muted: false },
    { index: 2, name: "Tenor", instrument: "choir_aahs", clef: "treble", program: 52, muted: false },
    { index: 3, name: "Bass", instrument: "choir_aahs", clef: "bass", program: 52, muted: false },
  ],
  notes: [
    { id: "n1", pitch_midi: 72, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 0 },
    { id: "n2", pitch_midi: 67, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 1 },
    { id: "n3", pitch_midi: 64, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 2 },
    { id: "n4", pitch_midi: 48, onset_sec: 0, offset_sec: 1, velocity: 80, track_index: 3 },
  ],
  chords: [],
  analysis: {
    mode: "satb_pdf",
    satb: { needs_review: false, warnings: [] },
  },
};

describe("SATBMixerPanel", () => {
  it("supports Solo/Mute/Volume/Tempo, saves assignments, and downloads SATB MP3s", async () => {
    const exportSpy = vi.spyOn(api, "exportSatbAudio").mockResolvedValue(undefined);
    const assignSpy = vi.spyOn(api, "updateSatbAssignments").mockResolvedValue({
      id: "score-1",
      project_id: "proj-satb",
      version: 2,
      score_json: sampleSatbScore,
      musicxml: null,
      updated_at: new Date().toISOString(),
    });

    render(<SATBMixerPanel projectId="proj-satb" projectTitle="Hymn SATB" scoreData={sampleSatbScore} />);

    // Solo & Mute toggles
    const soloButtons = screen.getAllByRole("button", { name: /^solo$/i });
    fireEvent.click(soloButtons[0]);
    expect(soloButtons[0]).toHaveAttribute("aria-pressed", "true");

    const muteButtons = screen.getAllByRole("button", { name: /^mute$/i });
    fireEvent.click(muteButtons[1]);
    expect(muteButtons[1]).toHaveAttribute("aria-pressed", "true");

    // Tempo & Volume adjustment
    fireEvent.change(screen.getByLabelText(/satb tempo/i), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText(/soprano volume/i), { target: { value: "1.2" } });

    // Export Combined MP3
    fireEvent.click(screen.getByRole("button", { name: /combined mp3/i }));
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith(
        "proj-satb",
        expect.objectContaining({ part: "combined", format: "mp3", tempo_bpm: 90 }),
        "Hymn_SATB_SATB_Combined.mp3",
      );
    });

    // Save SATB assignments without rerunning OMR
    fireEvent.click(screen.getByRole("button", { name: /save assignments/i }));
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("disables unassigned voices on Piano + Vocal scores and sends unsaved voice_assignments on export", async () => {
    const pianoVocalScore: ScoreData = {
      ...sampleSatbScore,
      title: "Pop Ballad",
      tracks: [
        { index: 0, name: "Vocal Melody", instrument: "vocals", clef: "treble", program: 0, muted: false },
        { index: 1, name: "Piano Accompaniment", instrument: "piano", clef: "bass", program: 0, muted: false },
      ],
      notes: [
        { id: "m1", pitch_midi: 64, onset_sec: 0, offset_sec: 1, velocity: 90, track_index: 0 },
        { id: "a1", pitch_midi: 48, onset_sec: 0, offset_sec: 1, velocity: 75, track_index: 1 },
      ],
      analysis: { mode: "piano_vocal" },
    };

    const exportSpy = vi.spyOn(api, "exportSatbAudio").mockResolvedValue(undefined);
    render(<SATBMixerPanel projectId="proj-pv" projectTitle="Pop Ballad" scoreData={pianoVocalScore} />);

    // Part 1 defaults to Soprano; Part 2 (Piano Accompaniment) defaults to Unassigned ("")
    expect((screen.getByLabelText("Assign Part 1") as HTMLSelectElement).value).toBe("Soprano");
    expect((screen.getByLabelText("Assign Part 2") as HTMLSelectElement).value).toBe("");

    // Unassigned voices (Alto, Tenor, Bass) show indicator & have disabled download controls
    expect(screen.getAllByText(/not assigned in score/i)).toHaveLength(3);
    const wavButtons = screen.getAllByRole("button", { name: /^wav$/i }) as HTMLButtonElement[];
    expect(wavButtons[0].disabled).toBe(false); // Soprano
    expect(wavButtons[1].disabled).toBe(true); // Alto
    expect(wavButtons[2].disabled).toBe(true); // Tenor
    expect(wavButtons[3].disabled).toBe(true); // Bass

    // Change Part 2 to Bass WITHOUT clicking Save Assignments -> Bass immediately becomes enabled and exports with override
    fireEvent.change(screen.getByLabelText("Assign Part 2"), { target: { value: "Bass" } });
    expect(wavButtons[3].disabled).toBe(false);

    fireEvent.click(wavButtons[3]);
    await waitFor(() => {
      expect(exportSpy).toHaveBeenCalledWith(
        "proj-pv",
        expect.objectContaining({
          part: "bass",
          format: "wav",
          voice_assignments: { 0: "Soprano", 1: "Bass" },
        }),
        "Pop_Ballad_Bass.wav",
      );
    });
  });
});
