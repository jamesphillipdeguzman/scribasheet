import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { VirtualPianoKeyboard } from "@/features/editor/VirtualPianoKeyboard";
import { LandingPage } from "@/features/landing/LandingPage";
import { MetronomeControl } from "@/features/editor/MetronomeControl";
import { PracticeCascade } from "@/features/editor/PracticeCascade";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { setControllerToken, workerController } from "@/services/workerController";
import type { ScoreNote, TranscriptionJob } from "@/types/api";

vi.mock("@/features/auth/AuthContext", () => ({
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
    logout: vi.fn(),
  }),
}));

vi.mock("@/features/editor/midiSynth", () => ({
  midiSynth: {
    preloadPiano: vi.fn(),
    triggerNote: vi.fn(),
    startSustainedNote: vi.fn(),
    stopSustainedNote: vi.fn(),
    stopAllSustainedNotes: vi.fn(),
    getPlaybackClock: () => ({ isPlaying: false, currentSec: 0 }),
  },
}));

describe("Light Mode Contrast & Hover-State Fixes", () => {
  it("uses Light Mode stone hover/active classes and Dark Mode white/10 classes on AppShell nav, ThemeToggle, and ghost Button", () => {
    const qc = new QueryClient();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <QueryClientProvider client={qc}>
          <AppShell>
            <Button variant="ghost" aria-label="Undo">
              Undo
            </Button>
            <ThemeToggle />
          </AppShell>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.className).toContain("bg-stone-200/90");
    expect(dashboardLink.className).toContain("text-stone-950");
    expect(dashboardLink.className).toContain("dark:bg-white/10");
    expect(dashboardLink.className).toContain("dark:text-white");

    const accountLink = screen.getByRole("link", { name: /Account/i });
    expect(accountLink.className).toContain("hover:bg-stone-200/75");
    expect(accountLink.className).toContain("hover:text-stone-950");
    expect(accountLink.className).toContain("dark:hover:bg-white/10");
    expect(accountLink.className).toContain("dark:hover:text-white");

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    expect(undoBtn.className).toContain("hover:bg-stone-200/80");
    expect(undoBtn.className).toContain("hover:text-stone-950");
    expect(undoBtn.className).toContain("dark:hover:bg-white/10");

    const themeToggles = screen.getAllByTestId("theme-toggle");
    expect(themeToggles[0].className).toContain("hover:bg-stone-200/75");
    expect(themeToggles[0].className).toContain("dark:hover:bg-white/10");
  });

  it("renders Light Mode Piano Roll lanes, pitch-axis labels, and default/sounding/selected MIDI note blocks", () => {
    const notes: ScoreNote[] = [
      { id: "n1", pitch_midi: 60, onset_sec: 0.0, offset_sec: 0.5, velocity: 85, track_index: 0 },
      { id: "n2", pitch_midi: 64, onset_sec: 0.6, offset_sec: 1.2, velocity: 85, track_index: 0 },
      { id: "n3", pitch_midi: 67, onset_sec: 1.5, offset_sec: 2.0, velocity: 85, track_index: 0 },
    ];

    const { container } = render(
      <PianoRollEditor
        notes={notes}
        durationSeconds={4}
        tempoBpm={120}
        timeSignature="4/4"
        playheadSec={0.8}
        isPlaying={true}
        selectedNoteId="n1"
        onSelectNote={vi.fn()}
        onChangeNotes={vi.fn()}
        onTogglePlay={vi.fn()}
        onStopPlay={vi.fn()}
        onPlayheadChange={vi.fn()}
        playbackRate={1}
        onPlaybackRateChange={vi.fn()}
        loop={false}
        onToggleLoop={vi.fn()}
      />,
    );

    const naturalLane = container.querySelector('[data-pitch-lane="60"]');
    const sharpLane = container.querySelector('[data-pitch-lane="61"]');
    expect(naturalLane?.className).toContain("bg-white");
    expect(naturalLane?.className).toContain("dark:bg-[#09090F]");
    expect(sharpLane?.className).toContain("bg-[#eceae4]");
    expect(sharpLane?.className).toContain("dark:bg-[#121524]");

    const selectedNote = container.querySelector('[data-note-id="n1"]');
    const soundingNote = container.querySelector('[data-note-id="n2"]');
    const defaultNote = container.querySelector('[data-note-id="n3"]');

    expect(selectedNote?.className).toContain("bg-[#4f46e5]");
    expect(selectedNote?.className).toContain("border-[#1e1b4b]");
    expect(soundingNote?.className).toContain("bg-[#059669]");
    expect(defaultNote?.className).toContain("bg-[#6d28d9]");
    expect(defaultNote?.className).toContain("border-[#4c1d95]");
    expect(defaultNote?.className).toContain("text-white");
  });

  it("renders VirtualPianoKeyboard white keys and solid dark black keys with active highlights", () => {
    render(
      <VirtualPianoKeyboard
        minPitch={60}
        maxPitch={72}
        activePlaybackNotes={[{ pitchMidi: 60, trackIndex: 0 }]}
        activeMidiPitches={new Set([61])}
        onKeyDown={vi.fn()}
        onKeyUp={vi.fn()}
      />,
    );

    const activeWhite = screen.getByRole("button", { name: "Piano key C4" });
    const inactiveWhite = screen.getByRole("button", { name: "Piano key D4" });
    const activeBlack = screen.getByRole("button", { name: "Piano key C#4" });
    const inactiveBlack = screen.getByRole("button", { name: "Piano key Eb4" });

    expect(activeWhite.className).toContain("bg-[#7c3aed]");
    expect(activeWhite.className).toContain("text-white");
    expect(inactiveWhite.className).toContain("bg-white");
    expect(inactiveWhite.className).toContain("border-slate-300");

    expect(activeBlack.className).toContain("bg-[#8b5cf6]");
    expect(inactiveBlack.className).toContain("bg-[#1e293b]");
    expect(inactiveBlack.className).toContain("border-[#0f172a]");
  });

  it("renders dynamic copyright notice for James Phillip De Guzman in both LandingPage and AppShell footers", () => {
    const year = new Date().getFullYear();
    const expectedText = `© ${year} James Phillip De Guzman. All rights reserved.`;
    const qc = new QueryClient();

    const { unmount } = render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <LandingPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const landingCopy = screen.getByText(expectedText);
    expect(landingCopy.className).toContain("text-stone-600");
    expect(landingCopy.className).toContain("dark:text-slate-500");
    unmount();

    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AppShell>
            <div>Studio Content</div>
          </AppShell>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const shellCopy = screen.getByText(expectedText);
    expect(shellCopy.className).toContain("text-stone-600");
    expect(shellCopy.className).toContain("dark:text-slate-500");
  });

  it("renders high-contrast Light Mode WorkerControlPanel messages and unclipped Audio Source select", async () => {
    vi.spyOn(workerController, "checkHealth").mockResolvedValue({ status: "ok" } as any);
    vi.spyOn(workerController, "getStatus").mockResolvedValue({
      worker_running: true,
      managed_by_controller: false,
      external_worker_detected: true,
      external_manageable: true,
      pid: 4321,
      last_error: null,
    } as any);
    vi.spyOn(workerController, "stopWorker").mockResolvedValue({
      message: "Worker stopped.",
    } as any);
    if (!window.localStorage) {
      const store: Record<string, string> = {};
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => {
            store[k] = v;
          },
          removeItem: (k: string) => {
            delete store[k];
          },
        },
      });
    }
    setControllerToken("tok");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkerControlPanel />
        <TranscriptionConfigPanel
          hasMedia={true}
          activeJob={null}
          defaultInstrument="piano"
          defaultMode="single_instrument"
          onStart={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          isStarting={false}
        />
      </QueryClientProvider>,
    );

    const extMsg = await screen.findByText(/Worker was started externally/i);
    expect(extMsg.className).toContain("text-amber-800");
    expect(extMsg.className).toContain("font-medium");
    expect(extMsg.className).toContain("dark:text-amber-300");

    const localDot = screen.getByTestId("local-process-dot");
    expect(localDot.className).toContain("bg-emerald-600");
    expect(localDot.className).toContain("ring-2");
    expect(localDot.className).toContain("dark:bg-emerald-400");

    fireEvent.click(screen.getByRole("button", { name: /Stop Worker/i }));
    const stoppedNotice = await screen.findByText("Worker stopped.");
    expect(stoppedNotice.className).toContain("text-emerald-800");
    expect(stoppedNotice.className).toContain("font-medium");
    expect(stoppedNotice.className).toContain("dark:text-emerald-300");

    const audioSourceSelect = screen.getByLabelText("Audio Source");
    expect(audioSourceSelect.className).toContain("text-[11px]");
    expect(audioSourceSelect.className).toContain("px-2");
    expect(audioSourceSelect.className).toContain("pr-6");
    expect(audioSourceSelect.textContent).toContain("Solo Piano");
  });

  it("renders high-contrast Light Mode callouts for transcription mode change and offline worker queue", () => {
    render(
      <TranscriptionConfigPanel
        hasMedia={true}
        hasScore={true}
        activeJob={null}
        workerOnline={false}
        defaultInstrument="piano"
        defaultMode="single_instrument"
        initialMode="single_instrument"
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        isStarting={false}
      />,
    );

    // Switch mode to Lead Melody to show the modeChangedSinceScore callout
    fireEvent.change(screen.getByLabelText("Output Arrangement"), { target: { value: "melody" } });
    const modeNotice = screen.getByText(/Transcription mode changed/i);
    expect(modeNotice.className).toContain("bg-violet-50");
    expect(modeNotice.className).toContain("border-violet-300");
    expect(modeNotice.className).toContain("text-violet-950");
    expect(modeNotice.className).toContain("dark:bg-violet-500/10");
    expect(modeNotice.className).toContain("dark:text-violet-200");

    // Click Re-Transcribe while workerOnline=false to show offline queue callout
    fireEvent.click(screen.getByRole("button", { name: /Re-Transcribe in Lead Melody Mode/i }));
    const offlineCopy = screen.getByText(/Desktop worker is currently offline/i);
    expect(offlineCopy.className).toContain("text-amber-950");
    expect(offlineCopy.className).toContain("font-medium");
    expect(offlineCopy.className).toContain("dark:text-amber-200");

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn.className).toContain("bg-white");
    expect(cancelBtn.className).toContain("text-stone-800");
    expect(cancelBtn.className).toContain("border-stone-300");
  });

  it("renders high-contrast Light Mode emerald checkmark badge on uploaded media items", () => {
    render(
      <MediaUploader
        projectId="p1"
        existingAssets={[
          {
            id: "a1",
            project_id: "p1",
            asset_type: "original",
            original_filename: "song.mp3",
            mime_type: "audio/mpeg",
            size_bytes: 1024000,
            duration_seconds: 120,
            sample_rate: 44100,
            channels: 2,
            created_at: "2026-11-23T00:00:00Z",
          },
        ]}
        isProcessing={false}
        onUploadComplete={vi.fn()}
        onMediaRemoved={vi.fn()}
      />,
    );

    const checkBadge = screen.getByTestId("uploaded-media-checkmark");
    expect(checkBadge.className).toContain("text-emerald-700");
    expect(checkBadge.className).toContain("bg-emerald-50");
    expect(checkBadge.className).toContain("border-emerald-300");
    expect(checkBadge.className).toContain("dark:text-emerald-400");
    expect(checkBadge.className).toContain("dark:bg-emerald-500/15");
  });

  it("renders high-contrast Light Mode Metronome pill, Stop Click button, and unclipped Subdivision select", () => {
    render(
      <MetronomeControl
        tempoBpm={120}
        scoreTimeSignature="4/4"
        isPlaybackActive={false}
        activeBeat={null}
        settings={{
          enabled: true,
          volume: 0.7,
          countInBars: 1,
          sound: "woodblock",
          subdivision: "quarter",
          accentBeatOne: true,
          timeSignatureOverride: null,
        }}
        onChangeSettings={vi.fn()}
      />,
    );

    const metroToggle = screen.getByRole("button", { name: "Metronome" });
    expect(metroToggle.className).toContain("bg-violet-100");
    expect(metroToggle.className).toContain("text-violet-900");
    expect(metroToggle.className).toContain("border-violet-300");

    const beatStep2 = screen.getByTestId("metronome-beat-indicator").querySelector('[data-beat="2"]');
    expect(beatStep2?.className).toContain("bg-white");
    expect(beatStep2?.className).toContain("text-stone-700");
    expect(beatStep2?.className).toContain("border-stone-300");

    fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
    const dialog = screen.getByRole("dialog", { name: "Metronome Settings" });
    expect(dialog.className).toContain("w-80");

    const subdivSelect = screen.getByLabelText("Metronome subdivision");
    expect(subdivSelect.textContent).toContain("Quarter (1/4)");

    const standaloneBtn = screen.getByRole("button", { name: /Standalone Click/i });
    expect(standaloneBtn.className).toContain("bg-white");
    expect(standaloneBtn.className).toContain("text-stone-800");
    expect(standaloneBtn.className).toContain("border-stone-300");

    fireEvent.click(standaloneBtn);
    const stopClickBtn = screen.getByRole("button", { name: /Stop Click/i });
    expect(stopClickBtn.className).toContain("bg-rose-50");
    expect(stopClickBtn.className).toContain("text-rose-800");
    expect(stopClickBtn.className).toContain("border-rose-300");
    expect(stopClickBtn.className).toContain("font-semibold");
  });

  it("renders high-contrast Light Mode Beat counter pill and Monitor button", () => {
    render(
      <div>
        <PracticeCascade
          notes={[{ id: "n1", pitch_midi: 60, onset_sec: 0, offset_sec: 0.5, velocity: 85, track_index: 0 }]}
          tracks={[]}
          keyboardBodyRef={{ current: null }}
          durationSeconds={4}
          tempoBpm={120}
          timeSignature="4/4"
          playheadSec={0.2}
          isPlaying={true}
          activeMidiPitches={new Set()}
          onTogglePlay={vi.fn()}
          onStop={vi.fn()}
          onPlayheadChange={vi.fn()}
          playbackRate={1}
          onPlaybackRateChange={vi.fn()}
          loop={false}
          onToggleLoop={vi.fn()}
        />
        <PianoRollEditor
          notes={[]}
          durationSeconds={4}
          tempoBpm={120}
          timeSignature="4/4"
          playheadSec={0}
          isPlaying={false}
          selectedNoteId={null}
          onSelectNote={vi.fn()}
          onChangeNotes={vi.fn()}
          onTogglePlay={vi.fn()}
          onStopPlay={vi.fn()}
          onPlayheadChange={vi.fn()}
          playbackRate={1}
          onPlaybackRateChange={vi.fn()}
          loop={false}
          onToggleLoop={vi.fn()}
        />
      </div>,
    );

    const beatPill = screen.getByTestId("cascade-beat-indicator");
    expect(beatPill.className).toContain("bg-emerald-50");
    expect(beatPill.className).toContain("text-emerald-800");
    expect(beatPill.className).toContain("border-emerald-300");
    expect(beatPill.className).toContain("dark:bg-emerald-500/15");
    expect(beatPill.className).toContain("dark:text-emerald-300");

    const monitorBtn = screen.getByRole("button", { name: "Monitor" });
    expect(monitorBtn.className).toContain("bg-emerald-600");
    expect(monitorBtn.className).toContain("text-white");
    expect(monitorBtn.className).toContain("border-emerald-700");

    const midiStatus = screen.getByTestId("midi-connection-status");
    expect(midiStatus.className).toContain("bg-amber-50");
    expect(midiStatus.className).toContain("text-amber-800");
    expect(midiStatus.className).toContain("border-amber-300");
    expect(midiStatus.className).toContain("dark:bg-amber-500/10");

    fireEvent.click(monitorBtn);
    expect(monitorBtn.className).toContain("bg-stone-100");
    expect(monitorBtn.className).toContain("text-stone-600");
    expect(monitorBtn.className).toContain("border-stone-300");
  });

  it("renders high-contrast Light Mode classes on failed StatusBadge and sidebar Retry Job error card", () => {
    render(
      <div>
        <StatusBadge status="failed" />
        <TranscriptionConfigPanel
          hasMedia={true}
          activeJob={{
            id: "job-failed-1",
            project_id: "proj-1",
            user_id: "u1",
            source_asset_id: "asset-orig-1",
            status: "failed",
            progress: 40,
            current_stage: "Failed",
            engine: "basic_pitch",
            settings_json: { instrument: "piano", mode: "single_instrument" } as TranscriptionJob["settings_json"],
            error_code: "MISSING_SOURCE_AUDIO",
            error_message: "Job has no source_download_url.",
            started_at: null,
            completed_at: null,
            created_at: new Date().toISOString(),
          }}
          defaultInstrument="piano"
          defaultMode="single_instrument"
          onStart={vi.fn()}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          isStarting={false}
        />
      </div>,
    );

    const badge = screen.getByText("failed");
    expect(badge.className).toContain("bg-red-50");
    expect(badge.className).toContain("text-red-800");
    expect(badge.className).toContain("border-red-300");
    expect(badge.className).toContain("font-semibold");
    expect(badge.className).toContain("dark:bg-red-500/15");
    expect(badge.className).toContain("dark:text-red-300");
    expect(badge.className).toContain("dark:border-red-500/35");

    const errorCard = screen.getByTestId("sidebar-job-error-card");
    expect(errorCard.className).toContain("bg-red-50");
    expect(errorCard.className).toContain("border-red-300");
    expect(errorCard.className).toContain("dark:bg-red-500/10");
    expect(errorCard.className).toContain("dark:border-red-500/30");

    const errorMsg = screen.getByText("Job has no source_download_url.");
    expect(errorMsg.className).toContain("text-red-900");
    expect(errorMsg.className).toContain("font-medium");
    expect(errorMsg.className).toContain("break-words");
    expect(errorMsg.className).toContain("dark:text-red-200");

    const retryBtn = screen.getByRole("button", { name: /Retry Job/i });
    expect(retryBtn.className).toContain("bg-white");
    expect(retryBtn.className).toContain("text-red-900");
    expect(retryBtn.className).toContain("border-red-300");
    expect(retryBtn.className).toContain("font-semibold");
    expect(retryBtn.className).toContain("dark:bg-white/10");
    expect(retryBtn.className).toContain("dark:text-white");
  });
});
