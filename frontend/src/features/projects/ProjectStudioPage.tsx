import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  FileMusic,
  FileText,
  Guitar,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Piano,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { AmbientScoreBackdrop } from "@/components/AmbientScoreBackdrop";
import { AppShell } from "@/components/AppShell";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { printScorePdf } from "@/lib/pdfPrint";
import { ChordAndTabPanel } from "@/features/editor/ChordAndTabPanel";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { LyricsPanel } from "@/features/editor/LyricsPanel";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { metronomeEngine } from "@/features/editor/metronome";
import { midiSynth } from "@/features/editor/midiSynth";
import { musicXmlToScoreNotes } from "@/features/editor/musicXmlEditor";
import { applyScoreTitleToMusicXml } from "@/features/editor/musicXmlNormalization";
import {
  loadMetronomeSettings,
  type MetronomeSettings,
  saveMetronomeSettings,
} from "@/features/editor/metronome";
import { SATBMixerPanel } from "@/features/editor/SATBMixerPanel";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { AudioTrimPanel } from "@/features/editor/AudioTrimPanel";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api, ApiError, WS_BASE_URL, getStoredTokens, isAuthError } from "@/services/api";
import { isScoreMediaAsset, isVideoMediaAsset, resolveDisplayScoreTitle } from "@/lib/utils";
import type { Project, ScoreData, ScoreNote, TranscriptionJob, TranscriptionSettings } from "@/types/api";

type StudioTab = "notation" | "pianoroll" | "chords" | "lyrics" | "exports";

export function ProjectStudioPage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<StudioTab>("notation");
  const [isFocusMode, setIsFocusMode] = useState(false);

  useEffect(() => {
    if (!isFocusMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFocusMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFocusMode]);
  const [showPartMixerOverride, setShowPartMixerOverride] = useState<boolean | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaybackActive, setIsPlaybackActive] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [togglePlaySignal, setTogglePlaySignal] = useState(0);
  const [stopPlaySignal, setStopPlaySignal] = useState(0);
  const [satbSoloVoice, setSatbSoloVoice] = useState<string | null>(null);
  const [satbMutedVoices, setSatbMutedVoices] = useState<Record<string, boolean>>({});
  const [metronomeSettings, setMetronomeSettings] = useState<MetronomeSettings>(() =>
    loadMetronomeSettings(),
  );
  const [activeMetronomeBeat, setActiveMetronomeBeat] = useState<number | null>(null);
  const handleMetronomeSettingsChange = (next: MetronomeSettings) => {
    setMetronomeSettings(next);
    saveMetronomeSettings(next);
  };
  const [seekRequest, setSeekRequest] = useState<{ sec: number; autoplay?: boolean; nonce: number } | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // Score state + Undo/Redo history
  const [scoreData, setScoreData] = useState<ScoreData | null>(null);
  const [musicxml, setMusicxml] = useState<string | null>(null);
  const [scoreVersion, setScoreVersion] = useState<number>(1);
  const [scoreLoadState, setScoreLoadState] = useState<
    "idle" | "loading" | "ready" | "missing_score" | "missing_file" | "unauthorized" | "error"
  >("idle");
  const [scoreLoadError, setScoreLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<ScoreData[]>([]);
  const [redoStack, setRedoStack] = useState<ScoreData[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Shared chord-symbol display & export preference
  const chordPrefKey = projectId ? `scribasheet:show_chords:${projectId}` : null;
  const [showChordSymbols, setShowChordSymbols] = useState<boolean>(() => {
    if (!chordPrefKey) return true;
    try {
      const saved = window.localStorage.getItem(chordPrefKey);
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const handleToggleChordSymbols = (next: boolean) => {
    setShowChordSymbols(next);
    if (chordPrefKey) {
      try {
        window.localStorage.setItem(chordPrefKey, String(next));
      } catch {
        // Ignore storage restrictions
      }
    }
  };

  // Job tracking
  const [activeJob, setActiveJob] = useState<TranscriptionJob | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [pollAuthError, setPollAuthError] = useState<string | null>(null);
  const [pollResumeNonce, setPollResumeNonce] = useState(0);
  const activeJobIdRef = useRef<string | null>(null);
  const processingGenerationRef = useRef<number>(0);
  const scoreLoadTokenRef = useRef<number>(0);
  const initialScoreAttemptedForRef = useRef<string | null>(null);
  const isJobRunningRef = useRef<boolean>(false);
  const projectStatusRef = useRef<string | undefined>(undefined);
  const isRetryingRef = useRef<boolean>(false);
  activeJobIdRef.current = activeJob?.id ?? null;
  const [runtimeNowMs, setRuntimeNowMs] = useState<number>(() => Date.now());
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [selectedSourceAssetId, setSelectedSourceAssetId] = useState<string | null>(null);
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(0);
  const [waveformDurationSec, setWaveformDurationSec] = useState<number>(0);
  const [waveformSignedUrl, setWaveformSignedUrl] = useState<string | null>(null);
  const [waveformDecodedBuffer, setWaveformDecodedBuffer] = useState<AudioBuffer | null>(null);
  const lastTrimAssetIdRef = useRef<string | null>(null);
  const [isRegeneratingArrangement, setIsRegeneratingArrangement] = useState(false);
  const [isPrintingPdf, setIsPrintingPdf] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const isPrintingPdfRef = useRef<boolean>(false);
  const projectTitleRef = useRef<string | undefined>(undefined);

  const creditPrefKey = projectId ? `scribasheet:transcribed_by:${projectId}` : null;
  const creditEnabledKey = projectId ? `scribasheet:include_transcribed_by:${projectId}` : null;
  const [transcribedBy, setTranscribedBy] = useState<string | undefined>(() => {
    if (!creditPrefKey) return undefined;
    try {
      const saved = window.localStorage.getItem(creditPrefKey);
      return saved === null ? undefined : saved;
    } catch {
      return undefined;
    }
  });
  const [includeTranscribedBy, setIncludeTranscribedBy] = useState<boolean>(() => {
    if (!creditEnabledKey) return true;
    try {
      const saved = window.localStorage.getItem(creditEnabledKey);
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  const handleTranscribedByChange = (next: string) => {
    setTranscribedBy(next);
    if (creditPrefKey) {
      try {
        window.localStorage.setItem(creditPrefKey, next);
      } catch {
        // Ignore storage restrictions
      }
    }
  };

  const handleToggleTranscribedBy = (next: boolean) => {
    setIncludeTranscribedBy(next);
    if (creditEnabledKey) {
      try {
        window.localStorage.setItem(creditEnabledKey, String(next));
      } catch {
        // Ignore storage restrictions
      }
    }
  };

  const canPrintSheetMusic = Boolean(projectId && scoreData && musicxml && !isStartingJob);

  const handlePrintPdf = useCallback(async () => {
    if (!projectId || !scoreData || !musicxml || isPrintingPdfRef.current) return;
    isPrintingPdfRef.current = true;
    setPrintError(null);
    setIsPrintingPdf(true);
    try {
      const { blob } = await api.generateScorePdfBlob(projectId, {
        include_chords: showChordSymbols,
        transcribed_by: transcribedBy,
        include_transcribed_by: includeTranscribedBy,
      });
      await printScorePdf(blob, {
        title: scoreData.title || projectTitleRef.current || "ScribaSheet Score",
      });
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "Failed to prepare sheet music PDF for printing.");
    } finally {
      isPrintingPdfRef.current = false;
      setIsPrintingPdf(false);
    }
  }, [projectId, scoreData, musicxml, showChordSymbols, transcribedBy, includeTranscribedBy]);

  useEffect(() => {
    if (activeTab !== "notation" || !canPrintSheetMusic) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "p") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      void handlePrintPdf();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, canPrintSheetMusic, handlePrintPdf]);

  // Inline project rename state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);
  const [renameStatus, setRenameStatus] = useState<"idle" | "saved" | "error">("idle");
  const [renameError, setRenameError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const isCommittingTitleRef = useRef(false);
  const isCancelledTitleRef = useRef(false);

  const autosaveTimerRef = useRef<number | null>(null);

  const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
    retry: (failureCount, err) => !isAuthError(err) && failureCount < 1,
  });
  projectTitleRef.current = project?.title;
  projectStatusRef.current = project?.status;

  const { data: workerStatus } = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => api.getWorkerStatus(),
    refetchInterval: (query) => (isAuthError(query.state.error) ? false : 12000),
    retry: (failureCount, err) => !isAuthError(err) && failureCount < 1,
    staleTime: 0,
  });

  const clearWorkspaceForNewProcessing = useCallback(() => {
    setPollAuthError(null);
    // 1. Stop active audio/MIDI playback & reset playhead immediately
    midiSynth.stop();
    if (metronomeEngine.getMode() !== "standalone") {
      metronomeEngine.stop();
    }
    setStopPlaySignal((n) => n + 1);
    setIsPlaybackActive(false);
    setPlayheadSec(0);
    setSeekRequest(null);

    // 2. Clear previous score, SATB mixer, notes, chords, MusicXML, and undo/redo state
    setScoreData(null);
    setMusicxml(null);
    setScoreVersion(1);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedNoteId(null);
    setSatbSoloVoice(null);
    setSatbMutedVoices({});
    setShowPartMixerOverride(null);
    setSaveStatus("saved");
    setSaveError(null);
    setScoreLoadError(null);
    setScoreLoadState("loading");

    // 3. Cancel & invalidate stale React Query cache entries
    if (projectId) {
      void queryClient.cancelQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["score", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  }, [projectId, queryClient]);

  const loadScore = useCallback(async (expectedJobId?: string | null) => {
    if (!projectId) return;
    const token = ++scoreLoadTokenRef.current;
    const targetJobId = expectedJobId !== undefined ? expectedJobId : activeJobIdRef.current;
    setScoreLoadState("loading");
    setScoreLoadError(null);
    try {
      const res = await api.getScore(projectId);
      if (token !== scoreLoadTokenRef.current) return;
      if (targetJobId && activeJobIdRef.current && targetJobId !== activeJobIdRef.current) return;
      const resJobId = (res.score_json?.analysis as Record<string, unknown> | undefined)?.job_id;
      if (targetJobId && typeof resJobId === "string" && resJobId !== targetJobId) {
        return;
      }
      const syncedScore = {
        ...res.score_json,
        title: resolveDisplayScoreTitle(projectTitleRef.current || res.score_json.title),
      };
      setScoreData(syncedScore);
      setMusicxml(
        res.musicxml
          ? applyScoreTitleToMusicXml(res.musicxml, syncedScore.title, {
              deduplicateMovementTitle: false,
            })
          : res.musicxml,
      );
      setScoreVersion(res.version);
      setUndoStack([]);
      setRedoStack([]);
      setSaveStatus("saved");
      setScoreLoadState(res.musicxml ? "ready" : "missing_file");
    } catch (err) {
      if (token !== scoreLoadTokenRef.current) return;
      setScoreData(null);
      setMusicxml(null);
      const errStatus =
        err instanceof ApiError
          ? err.status
          : typeof err === "object" &&
              err !== null &&
              "status" in err &&
              typeof (err as { status?: unknown }).status === "number"
            ? (err as { status: number }).status
            : null;
      if (errStatus === 404) {
        if (isJobRunningRef.current || projectStatusRef.current === "processing") {
          setScoreLoadState("idle");
          setScoreLoadError(null);
          return;
        }
        setScoreLoadState("missing_score");
        return;
      }
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setScoreLoadState("unauthorized");
          setScoreLoadError(err.message);
          return;
        }
        setScoreLoadState("error");
        setScoreLoadError(err.message);
        return;
      }
      setScoreLoadState("error");
      setScoreLoadError("Unexpected error while loading project score.");
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    setJobsLoaded(false);
    initialScoreAttemptedForRef.current = null;
    const gen = processingGenerationRef.current;
    api
      .listTranscriptions(projectId)
      .then((jobs) => {
        if (gen !== processingGenerationRef.current) return;
        if (jobs.length > 0 && !activeJobIdRef.current) {
          activeJobIdRef.current = jobs[0].id;
          setActiveJob(jobs[0]);
        }
      })
      .catch(() => {
        // Initial job list failure is non-fatal; user can still start a job
      })
      .finally(() => {
        if (gen === processingGenerationRef.current) {
          setJobsLoaded(true);
        }
      });
  }, [projectId]);

  // WebSocket + polling for active job
  useEffect(() => {
    if (!activeJob) return;
    if (["completed", "failed", "cancelled"].includes(activeJob.status)) return;

    const trackedJobId = activeJob.id;
    const trackedGen = processingGenerationRef.current;
    const isStaleTracker = () =>
      trackedJobId !== activeJobIdRef.current || trackedGen !== processingGenerationRef.current;

    let ws: WebSocket | null = null;
    const { accessToken } = getStoredTokens();
    if (accessToken) {
      try {
        ws = new WebSocket(`${WS_BASE_URL}/ws/jobs/${trackedJobId}?token=${encodeURIComponent(accessToken)}`);
        ws.onmessage = (ev) => {
          if (isStaleTracker()) return;
          const msg = JSON.parse(ev.data);
          if (msg.job_id && msg.job_id !== trackedJobId) return;
          setActiveJob((prev) =>
            prev && prev.id === trackedJobId
              ? {
                ...prev,
                status: msg.status,
                progress: msg.progress,
                current_stage: msg.current_stage,
                error_message: msg.error_message,
              }
              : prev
          );
          if (msg.status === "completed") {
            isJobRunningRef.current = false;
            projectStatusRef.current = "ready";
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            void loadScore(trackedJobId);
          } else if (msg.status === "failed" || msg.status === "cancelled") {
            setScoreData(null);
            setMusicxml(null);
            setScoreLoadState("error");
            setScoreLoadError(msg.error_message || "Score processing failed.");
          }
        };
      } catch {
        // Polling fallback handles updates below
      }
    }

    const pollMs =
      activeJob.status === "queued" && workerStatus?.worker_online === false
        ? 5000
        : 1500;

    const pollInterval = window.setInterval(async () => {
      if (isStaleTracker()) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const latest = await api.getJob(trackedJobId);
        if (isStaleTracker() || latest.id !== trackedJobId) return;
        setPollAuthError(null);
        setActiveJob(latest);
        if (latest.status === "completed") {
          isJobRunningRef.current = false;
          projectStatusRef.current = "ready";
          clearInterval(pollInterval);
          queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          void loadScore(trackedJobId);
        } else if (latest.status === "failed" || latest.status === "cancelled") {
          clearInterval(pollInterval);
          queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          setScoreData(null);
          setMusicxml(null);
          setScoreLoadState("error");
          setScoreLoadError(latest.error_message || "Score processing failed.");
        }
      } catch (err) {
        if (isAuthError(err)) {
          clearInterval(pollInterval);
          if (ws) ws.close();
          setPollAuthError(
            err instanceof ApiError && err.message
              ? err.message
              : "Your session has expired. Please sign in again to resume monitoring your transcription.",
          );
        }
        // ignore transient non-auth poll errors and continue polling
      }
    }, pollMs);

    return () => {
      clearInterval(pollInterval);
      if (ws) ws.close();
    };
  }, [activeJob?.id, activeJob?.status, workerStatus?.worker_online, projectId, queryClient, loadScore, pollResumeNonce]);

  const isJobRunning = Boolean(
    activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status),
  );
  isJobRunningRef.current = isJobRunning || isStartingJob;

  useEffect(() => {
    if (!projectId || !project || !jobsLoaded) return;
    if (initialScoreAttemptedForRef.current === projectId) return;
    initialScoreAttemptedForRef.current = projectId;
    if (project.status === "processing" || isJobRunning || isStartingJob) {
      setScoreLoadState("idle");
      setScoreLoadError(null);
      return;
    }
    void loadScore();
  }, [projectId, project, jobsLoaded, isJobRunning, isStartingJob, loadScore]);

  useEffect(() => {
    if (!isJobRunning) return;
    setRuntimeNowMs(Date.now());
    const timer = window.setInterval(() => setRuntimeNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isJobRunning, activeJob?.id, activeJob?.started_at, activeJob?.created_at]);

  const formatRuntimeMmSs = (totalSeconds: number): string => {
    const clamped = Math.max(0, Math.floor(totalSeconds));
    const mins = Math.floor(clamped / 60);
    const secs = clamped % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const runtimeBadgeText = (() => {
    if (!activeJob) return null;
    const startIso = activeJob.started_at || activeJob.created_at;
    const startMs = startIso ? Date.parse(startIso) : NaN;
    if (!Number.isFinite(startMs)) return null;

    if (isJobRunning) {
      return `Elapsed: ${formatRuntimeMmSs((runtimeNowMs - startMs) / 1000)}`;
    }
    if (activeJob.status === "completed" && activeJob.completed_at) {
      const completedMs = Date.parse(activeJob.completed_at);
      if (!Number.isFinite(completedMs)) return null;
      return `Completed in ${formatRuntimeMmSs((completedMs - startMs) / 1000)}`;
    }
    return null;
  })();

  const isGenuineSatb = Boolean(
    scoreData &&
    (project?.transcription_mode === "satb_pdf" ||
      scoreData.analysis?.mode === "satb_pdf" ||
      Boolean(scoreData.analysis?.satb)),
  );
  const canShowMixer = Boolean(scoreData && (isGenuineSatb || scoreData.tracks.length > 1));
  const mixerOpen = showPartMixerOverride ?? isGenuineSatb;

  // Warn on unsaved changes before unload
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveStatus === "unsaved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  const persistScore = useCallback(
    async (dataToSave: ScoreData, versionToSave: number, xmlOverride?: string | null) => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const updated = await api.saveScore(projectId, dataToSave, versionToSave, xmlOverride);
        setScoreVersion(updated.version);
        setMusicxml(updated.musicxml);
        setSaveStatus("saved");
      } catch (err) {
        setSaveStatus("error");
        setSaveError(err instanceof ApiError ? err.message : "Failed to save score.");
      }
    },
    [projectId]
  );

  const mutateScore = (updater: (prev: ScoreData) => ScoreData, xmlOverride?: string | null) => {
    if (!scoreData) return;
    setUndoStack((s) => [...s.slice(-29), scoreData]);
    setRedoStack([]);
    const next = updater(scoreData);
    setScoreData(next);
    if (xmlOverride !== undefined) {
      setMusicxml(xmlOverride);
    }
    setSaveStatus("unsaved");

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      persistScore(next, scoreVersion, xmlOverride);
    }, 1500);
  };

  const handleUndo = () => {
    if (undoStack.length === 0 || !scoreData) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, scoreData]);
    setScoreData(prev);
    setSaveStatus("unsaved");
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !scoreData) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((s) => [...s, scoreData]);
    setScoreData(next);
    setSaveStatus("unsaved");
  };

  const handleNotesChange = (newNotes: ScoreNote[]) => {
    mutateScore((prev) => ({ ...prev, notes: newNotes }));
  };

  const handleMusicXmlChange = (nextXml: string) => {
    if (!scoreData) return;
    const synced = musicXmlToScoreNotes(nextXml, scoreData.tracks, scoreData.tempo_bpm);
    mutateScore(
      (prev) => ({
        ...prev,
        notes: synced.notes,
        duration_seconds: Math.max(synced.durationSeconds, 0.5),
      }),
      nextXml,
    );
  };

  const handleUpdateChord = (chordId: string, symbol: string) => {
    mutateScore((prev) => ({
      ...prev,
      chords: prev.chords.map((c) => (c.id === chordId ? { ...c, symbol } : c)),
    }));
  };

  const handleUpdateNoteTab = (noteId: string, stringNum: number, fretNum: number) => {
    mutateScore((prev) => ({
      ...prev,
      notes: prev.notes.map((n) =>
        n.id === noteId ? { ...n, string_num: stringNum, fret_num: fretNum } : n
      ),
    }));
  };

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const startEditingTitle = () => {
    if (!project) return;
    isCommittingTitleRef.current = false;
    isCancelledTitleRef.current = false;
    setRenameError(null);
    setRenameStatus("idle");
    setDraftTitle(optimisticTitle ?? project.title);
    setIsEditingTitle(true);
  };

  const cancelTitleRename = () => {
    isCancelledTitleRef.current = true;
    setIsEditingTitle(false);
    setDraftTitle(project?.title ?? "");
  };

  const commitTitleRename = async () => {
    if (!project || isCommittingTitleRef.current || isCancelledTitleRef.current) {
      return;
    }
    isCommittingTitleRef.current = true;
    const trimmed = draftTitle.trim().slice(0, 120);
    if (!trimmed || trimmed === project.title) {
      setIsEditingTitle(false);
      setDraftTitle(project.title);
      isCommittingTitleRef.current = false;
      return;
    }

    setIsEditingTitle(false);
    setOptimisticTitle(trimmed);
    setRenameError(null);

    try {
      const updated = await api.updateProject(project.id, { title: trimmed });
      queryClient.setQueryData(["project", projectId], updated);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["exports", projectId] });
      const nextScoreTitle = resolveDisplayScoreTitle(updated.title);
      setScoreData((prev) => (prev ? { ...prev, title: nextScoreTitle } : prev));
      setMusicxml((prev) =>
        prev ? applyScoreTitleToMusicXml(prev, updated.title, { deduplicateMovementTitle: false }) : prev,
      );
      if (scoreData) {
        setScoreVersion((v) => v + 1);
      }
      setOptimisticTitle(null);
      setRenameStatus("saved");
      window.setTimeout(() => {
        setRenameStatus((curr) => (curr === "saved" ? "idle" : curr));
      }, 2500);
    } catch (err) {
      setOptimisticTitle(null);
      setRenameStatus("error");
      setRenameError(err instanceof ApiError ? err.message : "Failed to rename project.");
    } finally {
      isCommittingTitleRef.current = false;
    }
  };

  const handleStartTranscription = async (settings: TranscriptionSettings) => {
    if (!project) return;
    const gen = ++processingGenerationRef.current;
    scoreLoadTokenRef.current++;
    activeJobIdRef.current = null;
    clearWorkspaceForNewProcessing();
    setIsStartingJob(true);
    try {
      const sortedOriginals = [...project.media_assets]
        .filter((a) => a.asset_type === "original")
        .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));
      const validSelected =
        selectedSourceAssetId && project.media_assets.some((a) => a.id === selectedSourceAssetId)
          ? selectedSourceAssetId
          : null;
      const sourceId = validSelected || sortedOriginals[0]?.id || null;
      const job = await api.startTranscription(project.id, sourceId, settings);
      if (gen !== processingGenerationRef.current) return;
      activeJobIdRef.current = job.id;
      setActiveJob(job);
    } catch (err) {
      if (gen !== processingGenerationRef.current) return;
      setScoreLoadState("error");
      setScoreLoadError(err instanceof ApiError ? err.message : "Failed to start score processing.");
      throw err;
    } finally {
      if (gen === processingGenerationRef.current) {
        setIsStartingJob(false);
      }
    }
  };

  const projectMediaAssets = project?.media_assets || [];
  const sortedProjectOriginals = [...projectMediaAssets]
    .filter((a) => a.asset_type === "original")
    .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));
  const topOriginalAsset = sortedProjectOriginals[0] || null;
  const extractedProjectAudioAssets = projectMediaAssets.filter((a) => a.asset_type === "extracted_audio");
  const topUploadedVideoAsset =
    topOriginalAsset && isVideoMediaAsset(topOriginalAsset) ? topOriginalAsset : null;
  const effectiveSourceAssetId =
    selectedSourceAssetId && projectMediaAssets.some((a) => a.id === selectedSourceAssetId)
      ? selectedSourceAssetId
      : topOriginalAsset?.id || null;
  const selectedAssetObj = effectiveSourceAssetId
    ? projectMediaAssets.find((a) => a.id === effectiveSourceAssetId) || null
    : null;
  const activeAudioAsset = (() => {
    if (selectedAssetObj && !isScoreMediaAsset(selectedAssetObj) && !isVideoMediaAsset(selectedAssetObj)) {
      return selectedAssetObj;
    }
    if (topUploadedVideoAsset) {
      return (
        extractedProjectAudioAssets.find((a) => a.mime_type === "audio/wav") ||
        extractedProjectAudioAssets[0] ||
        null
      );
    }
    return topOriginalAsset && !isScoreMediaAsset(topOriginalAsset) && !isVideoMediaAsset(topOriginalAsset)
      ? topOriginalAsset
      : null;
  })();
  const waveformMediaAssetId = activeAudioAsset?.id || (topUploadedVideoAsset ? topOriginalAsset?.id || null : null);
  const trimTotalDuration =
    waveformDurationSec > 0
      ? waveformDurationSec
      : activeAudioAsset?.duration_seconds || project?.duration_seconds || 0;

  useEffect(() => {
    if (lastTrimAssetIdRef.current !== waveformMediaAssetId) {
      lastTrimAssetIdRef.current = waveformMediaAssetId;
      const resetDur = activeAudioAsset?.duration_seconds || project?.duration_seconds || 0;
      setTrimStartSec(0);
      setTrimEndSec(resetDur);
      setWaveformDurationSec(resetDur);
      setWaveformDecodedBuffer(null);
      return;
    }
    if (trimEndSec === 0 && trimTotalDuration > 0) {
      setTrimEndSec(trimTotalDuration);
    }
  }, [
    waveformMediaAssetId,
    activeAudioAsset?.duration_seconds,
    project?.duration_seconds,
    trimEndSec,
    trimTotalDuration,
  ]);

  if (projectLoading) {
    return (
      <AppShell>
        <div className="flex h-96 items-center justify-center text-sm text-[#A1A1AA]">
          <Loader2 className="h-5 w-5 animate-spin mr-2 text-[#A78BFA]" />
          Loading ScribaSheet Studio...
        </div>
      </AppShell>
    );
  }

  if (projectError || !project) {
    const isUnauthorized = projectError instanceof ApiError && (projectError.status === 401 || projectError.status === 403);
    const isNotFound = projectError instanceof ApiError && projectError.status === 404;
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center space-y-4">
          <h1 className="text-xl font-bold">
            {isUnauthorized ? "Access Denied" : isNotFound ? "Project Not Found" : "Unable to Load Project"}
          </h1>
          <p className="text-sm text-[#A1A1AA]">
            {isUnauthorized
              ? "You do not have permission to view this project."
              : isNotFound
                ? "This project does not exist or may have been deleted."
                : projectError instanceof ApiError
                  ? projectError.message
                  : "An unexpected error occurred while loading the project."}
          </p>
          <Link to="/dashboard">
            <Button>Back to Dashboard</Button>
          </Link>
        </div>
      </AppShell>
    );
  }

  const originalAsset = topOriginalAsset;
  const extractedAudioAssets = extractedProjectAudioAssets;
  const uploadedVideoAsset = topUploadedVideoAsset;
  const isScoreAsset = isScoreMediaAsset(originalAsset);
  const isScoreProject =
    isScoreAsset ||
    (!originalAsset &&
      (project?.transcription_mode === "satb_pdf" || scoreData?.analysis?.mode === "satb_pdf"));

  const effectiveProjectTitle = optimisticTitle ?? project.title;
  const effectiveScoreTitle = resolveDisplayScoreTitle(effectiveProjectTitle);

  return (
    <AppShell>
      <div className="relative mx-auto max-w-[1600px] px-3 sm:px-4 pt-8 pb-4 sm:pt-10 space-y-4 min-w-0">
        <AmbientScoreBackdrop variant="watermark" className="h-44 sm:h-52" />
        {/* Top Studio Toolbar */}
        <div
          data-testid="studio-header"
          className="relative z-10 flex flex-col gap-3 rounded-xl border border-[#27273A] bg-[#11111B]/90 backdrop-blur-sm px-3 sm:px-4 py-3 min-w-0 sm:flex-row sm:items-center sm:justify-between"
        >
          {/* Row 1 on mobile: Navigation (left) + Actions (right); on sm+: contents flatten into single row */}
          <div className="flex items-center justify-between gap-2 w-full sm:w-auto sm:contents">
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 sm:order-1">
              <Link
                to="/dashboard"
                className="rounded-lg p-2 text-stone-600 hover:bg-stone-200/80 hover:text-stone-950 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white shrink-0"
                aria-label="Back to Dashboard"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <button
                type="button"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="rounded-lg p-2 text-stone-600 hover:bg-stone-200/80 hover:text-stone-950 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white shrink-0"
                aria-label="Toggle ingestion panel"
              >
                {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
              </button>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 sm:order-3">
              {scoreData && (
                <>
                  <Button size="sm" variant="ghost" onClick={handleUndo} disabled={undoStack.length === 0} aria-label="Undo" className="shrink-0">
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleRedo} disabled={redoStack.length === 0} aria-label="Redo" className="shrink-0">
                    <Redo2 className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-[#A1A1AA] hidden md:inline px-2 whitespace-nowrap">
                    {saveStatus === "saving" && (
                      <span className="text-violet-700 font-medium dark:text-violet-400">Saving...</span>
                    )}
                    {saveStatus === "saved" && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium dark:text-emerald-400">
                        <Check className="h-3.5 w-3.5" /> Saved
                      </span>
                    )}
                    {saveStatus === "unsaved" && (
                      <span className="text-amber-700 font-medium dark:text-amber-400">Unsaved changes</span>
                    )}
                    {saveStatus === "error" && (
                      <span className="text-red-700 font-medium dark:text-red-400">{saveError || "Save error"}</span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => persistScore(scoreData, scoreVersion)}
                    disabled={saveStatus === "saving"}
                    className="whitespace-nowrap shrink-0"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save Score
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Row 2 on mobile: Project title, badges, and score metadata */}
          <div className="min-w-0 flex-1 sm:order-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {isEditingTitle ? (
                <input
                  ref={titleInputRef}
                  type="text"
                  aria-label="Project title"
                  maxLength={120}
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitTitleRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelTitleRename();
                    }
                  }}
                  onBlur={() => {
                    void commitTitleRename();
                  }}
                  className="min-w-0 w-full sm:w-auto sm:min-w-[220px] max-w-full rounded-md px-2 py-0.5 text-sm sm:text-base font-semibold bg-white text-stone-900 border border-violet-500 ring-2 ring-violet-500/20 placeholder:text-stone-400 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-violet-400 dark:ring-violet-400/25"
                />
              ) : (
                <div className="flex items-center gap-1.5 min-w-0 max-w-full">
                  <h1
                    onClick={startEditingTitle}
                    title="Rename project"
                    className="text-sm sm:text-base font-semibold truncate min-w-0 max-w-full cursor-pointer text-stone-950 hover:text-violet-700 dark:text-[#F5F3FF] dark:hover:text-indigo-200 transition-colors"
                  >
                    {optimisticTitle ?? project.title}
                  </h1>
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    aria-label="Rename project"
                    title="Rename project"
                    className="rounded-lg p-1 text-stone-600 hover:bg-stone-200/80 hover:text-stone-950 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 shrink-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {renameStatus === "saved" && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium dark:text-emerald-400 whitespace-nowrap shrink-0">
                      <Check className="h-3 w-3" /> Renamed
                    </span>
                  )}
                </div>
              )}
              <StatusBadge status={project.status} />
              <WorkerStatusBadge />
            </div>
            {renameError && (
              <div role="alert" className="mt-1 text-xs text-red-700 font-medium dark:text-red-400">
                {renameError}
              </div>
            )}
            {scoreData && (
              <div className="text-xs text-[#A1A1AA] flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                <span className="whitespace-nowrap">
                  {Math.round(scoreData.tempo_bpm)} BPM {scoreData.tempo_estimated ? "(est.)" : ""}
                </span>
                <span aria-hidden="true">•</span>
                <span className="whitespace-nowrap">{scoreData.time_signature}</span>
                <span aria-hidden="true">•</span>
                <span className="whitespace-nowrap">
                  Key: {scoreData.key_signature} {scoreData.key_signature_estimated ? "(est.)" : ""}
                </span>
                <span aria-hidden="true">•</span>
                <span className="whitespace-nowrap">{scoreData.notes.length} notes</span>
              </div>
            )}
          </div>
        </div>

        {/* Main Studio Grid */}
        <div className={`grid gap-4 min-w-0 ${sidebarOpen ? "lg:grid-cols-12" : "grid-cols-1"}`}>
          {sidebarOpen && (
            <aside className="lg:col-span-4 xl:col-span-3 space-y-4 min-w-0">
              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4 min-w-0">
                <h2 className="text-sm font-semibold">1. Media or Score Input</h2>
                <MediaUploader
                  projectId={project.id}
                  projectTitle={effectiveProjectTitle}
                  existingAssets={project.media_assets}
                  selectedSourceAssetId={effectiveSourceAssetId}
                  onSelectSourceAsset={setSelectedSourceAssetId}
                  onAudioExtracted={() => queryClient.invalidateQueries({ queryKey: ["project", projectId] })}
                  hasScore={Boolean(scoreData)}
                  acceptPdf={project.transcription_mode === "satb_pdf"}
                  isProcessing={
                    isStartingJob ||
                    Boolean(activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status))
                  }
                  onUploadComplete={(asset) => {
                    setSelectedSourceAssetId(asset.id);
                    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                  }}
                  onMediaRemoved={() => {
                    setSelectedSourceAssetId(null);
                    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                  }}
                />
              </div>

              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4 min-w-0">
                <h2 className="text-sm font-semibold">
                  {isScoreAsset ? "2. Score & Voice Settings" : "2. Transcription Settings"}
                </h2>
                <TranscriptionConfigPanel
                  hasMedia={Boolean(originalAsset)}
                  isScoreFile={isScoreAsset}
                  hasScore={Boolean(scoreData)}
                  activeJob={activeJob}
                  workerOnline={workerStatus?.worker_online ?? null}
                  defaultInstrument={project.instrument}
                  defaultMode={project.transcription_mode}
                  initialMode={
                    (scoreData?.analysis?.mode as string | undefined) ||
                    activeJob?.settings_json?.mode
                  }
                  initialArrangementDetail={
                    (scoreData?.analysis?.arrangement_detail as "simple" | "balanced" | "detailed" | undefined) ||
                    activeJob?.settings_json?.arrangement_detail
                  }
                  initialPlayabilitySmoothing={
                    (scoreData?.analysis?.playability_smoothing as "original" | "standard" | "simplified" | undefined) ||
                    activeJob?.settings_json?.playability_smoothing
                  }
                  initialQuantization={
                    (scoreData?.analysis?.quantization as TranscriptionSettings["quantization"] | undefined) ||
                    activeJob?.settings_json?.quantization
                  }
                  onStart={handleStartTranscription}
                  onCancel={async (jobId) => {
                    const updated = await api.cancelJob(jobId);
                    setActiveJob(updated);
                  }}
                  onRetry={async (jobId) => {
                    if (isStartingJob || isRetryingRef.current) return;
                    isRetryingRef.current = true;
                    const gen = ++processingGenerationRef.current;
                    scoreLoadTokenRef.current++;
                    activeJobIdRef.current = null;
                    clearWorkspaceForNewProcessing();
                    setIsStartingJob(true);
                    try {
                      let retried: TranscriptionJob;
                      try {
                        retried = await api.retryJob(jobId);
                      } catch (err) {
                        const orig = project.media_assets.find((a) => a.asset_type === "original");
                        const canFallback =
                          orig &&
                          err instanceof ApiError &&
                          (err.status === 400 || err.status === 404 || err.status === 422);
                        if (!canFallback) {
                          throw err;
                        }
                        const savedSettings = activeJob?.settings_json as TranscriptionSettings | undefined;
                        retried = await api.startTranscription(project.id, orig.id, {
                          ...(savedSettings || {}),
                          instrument: savedSettings?.instrument || project.instrument,
                          mode: savedSettings?.mode || project.transcription_mode,
                        } as TranscriptionSettings);
                      }
                      if (gen !== processingGenerationRef.current) return;
                      activeJobIdRef.current = retried.id;
                      setActiveJob(retried);
                    } catch (err) {
                      if (gen !== processingGenerationRef.current) return;
                      setScoreLoadState("error");
                      setScoreLoadError(
                        err instanceof ApiError ? err.message : "Failed to retry transcription.",
                      );
                    } finally {
                      isRetryingRef.current = false;
                      if (gen === processingGenerationRef.current) {
                        setIsStartingJob(false);
                      }
                    }
                  }}
                  onRegenerateArrangement={async (arrangementDetail, quantization, mode, playabilitySmoothing) => {
                    if (!projectId) return;
                    setIsRegeneratingArrangement(true);
                    try {
                      const updated = await api.regenerateArrangement(projectId, {
                        arrangement_detail: arrangementDetail,
                        quantization,
                        mode,
                        ...(playabilitySmoothing ? { playability_smoothing: playabilitySmoothing } : {}),
                      });
                      setScoreData(updated.score_json);
                      setMusicxml(updated.musicxml);
                      setScoreVersion(updated.version);
                      setUndoStack([]);
                      setRedoStack([]);
                      setSaveStatus("saved");
                    } finally {
                      setIsRegeneratingArrangement(false);
                    }
                  }}
                  isRegeneratingArrangement={isRegeneratingArrangement}
                  isStarting={isStartingJob}
                />
              </div>

              <WorkerControlPanel
                currentJobLabel={
                  activeJob ? `${activeJob.current_stage} (${activeJob.progress}%)` : null
                }
              />
            </aside>
          )}

          {/* Main Editor Canvas */}
          <section className={`${sidebarOpen ? "lg:col-span-8 xl:col-span-9" : ""} space-y-4 min-w-0`}>
            {/* Playback Bar */}
            <WaveformPlayer
              mediaAssetId={isScoreProject ? null : waveformMediaAssetId}
              isScoreOnly={isScoreProject}
              notes={scoreData?.notes || []}
              durationSeconds={scoreData?.duration_seconds || activeAudioAsset?.duration_seconds || project.duration_seconds || 0}
              tempoBpm={scoreData?.tempo_bpm || 120}
              playheadSec={playheadSec}
              onPlayheadChange={setPlayheadSec}
              seekRequest={seekRequest}
              onPlayingChange={setIsPlaybackActive}
              externalToggleSignal={togglePlaySignal}
              externalStopSignal={stopPlaySignal}
              externalPlaybackRate={playbackRate}
              onPlaybackRateChange={setPlaybackRate}
              externalLoop={loopPlayback}
              onLoopChange={setLoopPlayback}
              timeSignature={scoreData?.time_signature || "4/4"}
              metronomeSettings={metronomeSettings}
              onMetronomeSettingsChange={handleMetronomeSettingsChange}
              activeBeat={activeMetronomeBeat}
              onActiveBeatChange={setActiveMetronomeBeat}
              trimStartSec={!isScoreProject && activeAudioAsset ? trimStartSec : null}
              trimEndSec={!isScoreProject && activeAudioAsset ? trimEndSec : null}
              onTrimChange={(nextStart, nextEnd) => {
                setTrimStartSec(nextStart);
                setTrimEndSec(nextEnd);
              }}
              onDecodedAudioReady={({ durationSec, audioBuffer, signedUrl }) => {
                setWaveformSignedUrl(signedUrl);
                setWaveformDecodedBuffer(audioBuffer);
                if (durationSec > 0) {
                  setWaveformDurationSec(durationSec);
                  setTrimEndSec((prevEnd) => (prevEnd <= 0 || prevEnd > durationSec + 0.05 ? durationSec : prevEnd));
                }
              }}
            />

            {!isScoreProject && activeAudioAsset && (
              <AudioTrimPanel
                projectId={project.id}
                projectTitle={effectiveProjectTitle}
                mediaAsset={activeAudioAsset}
                signedAudioUrl={waveformSignedUrl}
                decodedAudioBuffer={waveformDecodedBuffer}
                durationSec={trimTotalDuration}
                playheadSec={playheadSec}
                trimStartSec={trimStartSec}
                trimEndSec={trimEndSec}
                isProcessing={isJobRunning || isStartingJob}
                onTrimChange={(nextStart, nextEnd) => {
                  setTrimStartSec(nextStart);
                  setTrimEndSec(nextEnd);
                }}
                onSeek={(sec) => setSeekRequest({ sec, autoplay: false, nonce: Date.now() })}
                onTrimApplied={(newAsset, replacedAssetId) => {
                  setStopPlaySignal((n) => n + 1);
                  setPlayheadSec(0);
                  setSeekRequest(null);
                  setSelectedSourceAssetId(newAsset.id);
                  const nextDur = newAsset.duration_seconds || 0;
                  setTrimStartSec(0);
                  setTrimEndSec(nextDur);
                  setWaveformDurationSec(nextDur);
                  setWaveformDecodedBuffer(null);
                  lastTrimAssetIdRef.current = newAsset.id;
                  queryClient.setQueryData<Project | undefined>(["project", projectId], (prev) => {
                    if (!prev) return prev;
                    const replaced = prev.media_assets.find((m) => m.id === replacedAssetId);
                    const shouldDropOld =
                      replaced && replaced.asset_type === "original" && !isVideoMediaAsset(replaced);
                    const filtered = shouldDropOld
                      ? prev.media_assets.filter((m) => m.id !== replacedAssetId)
                      : prev.media_assets;
                    return {
                      ...prev,
                      duration_seconds: newAsset.duration_seconds ?? prev.duration_seconds,
                      media_assets: [newAsset, ...filtered.filter((m) => m.id !== newAsset.id)],
                    };
                  });
                  void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                }}
              />
            )}

            {/* Workspace Tabs */}
            <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 sm:p-4 space-y-4 min-w-0">
              <div className="flex flex-nowrap items-center justify-between gap-2 overflow-x-auto border-b border-[#27273A] pb-3" role="tablist">
                <div className="flex flex-nowrap items-center gap-1 min-w-0">
                  {[
                    { id: "notation" as const, label: "Sheet Music", icon: FileMusic },
                    { id: "pianoroll" as const, label: "Piano Roll Editor", icon: Piano },
                    { id: "chords" as const, label: "Chords & Guitar Tab", icon: Guitar },
                    { id: "lyrics" as const, label: "Lyrics", icon: FileText },
                    { id: "exports" as const, label: "Export Center", icon: Download },
                  ].map((t) => {
                    const Icon = t.icon;
                    const active = activeTab === t.id;
                    return (
                      <button
                        key={t.id}
                        role="tab"
                        aria-selected={active}
                        onClick={() => setActiveTab(t.id)}
                        className={`inline-flex shrink-0 min-h-[40px] items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${active
                          ? "bg-violet-600 text-white font-semibold shadow-sm dark:bg-[#8B5CF6] dark:text-[#F5F3FF] dark:font-medium"
                          : "text-stone-700 hover:text-stone-950 hover:bg-stone-200/60 font-medium dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF] dark:hover:bg-[#181825]"
                          }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {(runtimeBadgeText || (canShowMixer && !isGenuineSatb)) && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center">
                    {runtimeBadgeText && (
                      <span
                        data-testid="job-runtime-badge"
                        className="inline-flex items-center gap-1.5 rounded-md border border-[#27273A] bg-[#181825] px-2.5 py-1 text-[11px] font-medium tabular-nums text-[#A1A1AA]"
                      >
                        <Clock className="h-3 w-3 shrink-0 text-[#8B5CF6]" />
                        {runtimeBadgeText}
                      </span>
                    )}
                  </div>
                  {canShowMixer && !isGenuineSatb && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowPartMixerOverride(!mixerOpen)}
                    >
                      {mixerOpen ? "Hide SATB / Part Mixer" : "Show SATB / Part Mixer"}
                    </Button>
                  )}
                </div>
              )}

              {canShowMixer && scoreData && mixerOpen && !isJobRunning && !isStartingJob && (
                <SATBMixerPanel
                  projectId={project.id}
                  projectTitle={effectiveProjectTitle}
                  scoreData={scoreData}
                  soloVoice={satbSoloVoice}
                  onSoloVoiceChange={setSatbSoloVoice}
                  mutedVoices={satbMutedVoices}
                  onMutedVoicesChange={setSatbMutedVoices}
                  metronomeSettings={metronomeSettings}
                  onActiveBeatChange={setActiveMetronomeBeat}
                  onScoreUpdated={(updatedScore, updatedVersion, updatedXml) => {
                    setScoreData(updatedScore);
                    setScoreVersion(updatedVersion);
                    if (updatedXml !== null) setMusicxml(updatedXml);
                  }}
                />
              )}

              {pollAuthError && (
                <div
                  data-testid="auth-session-expired-banner"
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-semibold">{pollAuthError}</div>
                    <p className="text-[11px] opacity-90">
                      Your active transcription job remains queued/processing in the background; authentication expired before status polling could continue.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setPollAuthError(null);
                        setPollResumeNonce((n) => n + 1);
                      }}
                    >
                      Retry Monitoring
                    </Button>
                    <Link to="/login">
                      <Button size="sm">Sign In Again</Button>
                    </Link>
                  </div>
                </div>
              )}

              {activeTab === "notation" &&
                (isStartingJob || (activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status)) ? (
                  <div
                    data-testid="notation-processing-state"
                    className="flex min-h-[16rem] flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-3"
                  >
                    {activeJob?.status === "queued" && (workerStatus?.worker_online === false || activeJob?.worker_online === false) ? (
                      <>
                        <div className="text-sm font-semibold text-amber-200">
                          Waiting for Desktop Worker
                        </div>
                        <p className="max-w-md text-xs text-[#A1A1AA]">
                          Your song is safely queued. ScribaSheet&apos;s desktop transcription worker is currently offline. Keep your Windows PC awake and the ScribaSheet worker running to begin transcription.
                        </p>
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-6 w-6 animate-spin text-[#A78BFA]" />
                        <div className="text-sm font-medium text-[#F5F3FF]">
                          {isScoreProject || activeJob?.settings_json?.mode === "satb_pdf"
                            ? "Score Processing in Progress"
                            : "Transcription in progress"}
                          : {activeJob?.current_stage || "Starting"} ({activeJob?.progress ?? 0}%)
                        </div>
                        <p className="text-xs text-[#A1A1AA]">
                          Sheet music will appear here automatically once a valid score is generated.
                        </p>
                      </>
                    )}
                  </div>
                ) : scoreLoadState === "missing_file" ? (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6 text-center space-y-2">
                    <div className="text-sm font-semibold text-amber-200">Score File Missing from Storage</div>
                    <p className="text-xs text-amber-100/80">
                      A score record exists in the database, but its MusicXML file could not be found in storage. You can still inspect or re-save notes from the Piano Roll, or re-run transcription.
                    </p>
                  </div>
                ) : scoreLoadState === "unauthorized" ? (
                  <div className="rounded-xl bg-red-50 border border-red-300 p-6 text-center text-xs text-red-900 font-medium break-words dark:bg-red-500/10 dark:border-red-500/30 dark:text-red-200">
                    {scoreLoadError || "You are not authorized to view this score."}
                  </div>
                ) : scoreLoadState === "error" ? (
                  <div
                    data-testid="workspace-score-error-card"
                    className="rounded-xl bg-red-50 border border-red-300 p-6 text-center space-y-3 dark:bg-red-500/10 dark:border-red-500/30"
                  >
                    <div className="text-xs text-red-900 font-medium break-words dark:text-red-200">
                      {scoreLoadError || "Failed to load score."}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void loadScore()}
                      className="bg-white hover:bg-red-100/70 text-red-900 border border-red-300 font-semibold shadow-xs dark:bg-white/10 dark:hover:bg-white/15 dark:text-white dark:border-white/15"
                    >
                      Retry Loading Score
                    </Button>
                  </div>
                ) : scoreLoadState === "missing_score" ? (
                  <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-2">
                    <FileMusic className="h-7 w-7 text-[#A78BFA]" />
                    <div className="text-sm font-medium text-[#F5F3FF]">No Transcription Score Generated Yet</div>
                    <p className="max-w-md text-xs text-[#A1A1AA]">
                      {activeJob?.status === "completed"
                        ? "The latest worker job completed without generating a musical score (for example, a Phase A simulated test job)."
                        : "Upload audio and run transcription to generate editable sheet music."}
                    </p>
                  </div>
                ) : (
                  <SheetMusicViewer
                    musicxml={musicxml}
                    scoreTitle={effectiveScoreTitle}
                    notes={scoreData?.notes}
                    chords={scoreData?.chords}
                    showChordSymbols={showChordSymbols}
                    onToggleChordSymbols={handleToggleChordSymbols}
                    playheadSec={playheadSec}
                    isPlaying={isPlaybackActive}
                    tempoBpm={scoreData?.tempo_bpm || 120}
                    playbackRate={playbackRate}
                    tracks={scoreData?.tracks || []}
                    onPrintPdf={() => void handlePrintPdf()}
                    isPrintingPdf={isPrintingPdf}
                    canPrintPdf={canPrintSheetMusic}
                    printError={printError}
                    satbSoloVoice={satbSoloVoice}
                    satbMutedVoices={satbMutedVoices}
                    onTogglePlay={() => setTogglePlaySignal((n) => n + 1)}
                    onStopPlay={() => setStopPlaySignal((n) => n + 1)}
                    onSeek={(sec) => setSeekRequest({ sec, autoplay: isPlaybackActive, nonce: Date.now() })}
                    isFocusMode={isFocusMode}
                    onToggleFocusMode={() => setIsFocusMode((v) => !v)}
                    onMusicXmlChange={handleMusicXmlChange}
                  />
                ))}

              {activeTab === "pianoroll" &&
                (isJobRunning || isStartingJob ? (
                  <div
                    data-testid="pianoroll-processing-state"
                    className="flex min-h-[16rem] flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-3"
                  >
                    <Loader2 className="h-6 w-6 animate-spin text-[#A78BFA]" />
                    <div className="text-sm font-medium text-[#F5F3FF]">
                      Processing: {activeJob?.current_stage || "Starting"} ({activeJob?.progress ?? 0}%)
                    </div>
                  </div>
                ) : scoreData ? (
                  <PianoRollEditor
                    notes={scoreData.notes}
                    chords={scoreData.chords}
                    tracks={scoreData.tracks}
                    durationSeconds={scoreData.duration_seconds}
                    tempoBpm={scoreData.tempo_bpm}
                    timeSignature={scoreData.time_signature}
                    playheadSec={playheadSec}
                    selectedNoteId={selectedNoteId}
                    onSelectNote={setSelectedNoteId}
                    onChangeNotes={handleNotesChange}
                    onPlayheadChange={setPlayheadSec}
                    isPlaying={isPlaybackActive}
                    onTogglePlay={() => setTogglePlaySignal((n) => n + 1)}
                    onStopPlay={() => setStopPlaySignal((n) => n + 1)}
                    playbackRate={playbackRate}
                    onPlaybackRateChange={setPlaybackRate}
                    satbSoloVoice={satbSoloVoice}
                    satbMutedVoices={satbMutedVoices}
                    onSatbSoloChange={setSatbSoloVoice}
                    loop={loopPlayback}
                    onToggleLoop={() => setLoopPlayback((v) => !v)}
                    metronomeSettings={metronomeSettings}
                    onMetronomeSettingsChange={handleMetronomeSettingsChange}
                    activeBeat={activeMetronomeBeat}
                    onActiveBeatChange={setActiveMetronomeBeat}
                    musicxml={musicxml}
                    scoreTitle={effectiveScoreTitle}
                    showChordSymbols={showChordSymbols}
                    onToggleChordSymbols={handleToggleChordSymbols}
                    isFocusMode={isFocusMode}
                    onToggleFocusMode={() => setIsFocusMode((v) => !v)}
                    onMusicXmlChange={handleMusicXmlChange}
                  />
                ) : (
                  <div className="py-12 text-center text-sm text-[#A1A1AA]">
                    Run AI transcription to edit notes in the Piano Roll.
                  </div>
                ))}

              {activeTab === "chords" &&
                (isJobRunning || isStartingJob ? (
                  <div
                    data-testid="chords-processing-state"
                    className="flex min-h-[16rem] flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-3"
                  >
                    <Loader2 className="h-6 w-6 animate-spin text-[#A78BFA]" />
                    <div className="text-sm font-medium text-[#F5F3FF]">
                      Processing: {activeJob?.current_stage || "Starting"} ({activeJob?.progress ?? 0}%)
                    </div>
                  </div>
                ) : scoreData ? (
                  <ChordAndTabPanel
                    chords={scoreData.chords}
                    notes={scoreData.notes}
                    onUpdateChord={handleUpdateChord}
                    onUpdateNoteTab={handleUpdateNoteTab}
                  />
                ) : (
                  <div className="py-12 text-center text-sm text-[#A1A1AA]">
                    Run AI transcription to inspect detected chords and guitar tablature.
                  </div>
                ))}

              {activeTab === "lyrics" && (
                <LyricsPanel
                  projectId={project.id}
                  projectTitle={effectiveProjectTitle}
                  hasMedia={Boolean(originalAsset)}
                  activeJob={activeJob}
                  onJobStarted={(job) => setActiveJob(job)}
                  onSeek={(sec) => setSeekRequest({ sec, autoplay: true, nonce: Date.now() })}
                  onLyricsSaved={() => loadScore()}
                />
              )}

              {activeTab === "exports" && (
                <ExportCenter
                  projectId={project.id}
                  projectTitle={effectiveProjectTitle}
                  scoreTitle={effectiveScoreTitle}
                  hasScore={Boolean(scoreData)}
                  isSatbScore={isGenuineSatb}
                  uploadedVideoAsset={uploadedVideoAsset}
                  extractedAudioAssets={extractedAudioAssets}
                  onAudioExtracted={() => queryClient.invalidateQueries({ queryKey: ["project", projectId] })}
                  showChordSymbols={showChordSymbols}
                  onToggleChordSymbols={handleToggleChordSymbols}
                  transcribedBy={transcribedBy}
                  includeTranscribedBy={includeTranscribedBy}
                  onTranscribedByChange={handleTranscribedByChange}
                  onToggleTranscribedBy={handleToggleTranscribedBy}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
