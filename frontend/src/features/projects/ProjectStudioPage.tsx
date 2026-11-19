import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
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
import { AppShell } from "@/components/AppShell";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ChordAndTabPanel } from "@/features/editor/ChordAndTabPanel";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { LyricsPanel } from "@/features/editor/LyricsPanel";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { SATBMixerPanel } from "@/features/editor/SATBMixerPanel";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api, ApiError, WS_BASE_URL, getStoredTokens } from "@/services/api";
import type { ScoreData, ScoreNote, TranscriptionJob, TranscriptionSettings } from "@/types/api";

type StudioTab = "notation" | "pianoroll" | "chords" | "lyrics" | "exports";

export function ProjectStudioPage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<StudioTab>("notation");
  const [showPartMixerOverride, setShowPartMixerOverride] = useState<boolean | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
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
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [isRegeneratingArrangement, setIsRegeneratingArrangement] = useState(false);

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
  });

  const { data: workerStatus } = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => api.getWorkerStatus(),
    refetchInterval: 12000,
    staleTime: 0,
  });

  const loadScore = useCallback(async () => {
    if (!projectId) return;
    setScoreLoadState("loading");
    setScoreLoadError(null);
    try {
      const res = await api.getScore(projectId);
      setScoreData(res.score_json);
      setMusicxml(res.musicxml);
      setScoreVersion(res.version);
      setUndoStack([]);
      setRedoStack([]);
      setSaveStatus("saved");
      setScoreLoadState(res.musicxml ? "ready" : "missing_file");
    } catch (err) {
      setScoreData(null);
      setMusicxml(null);
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setScoreLoadState("missing_score");
          return;
        }
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
    loadScore();
  }, [loadScore]);

  useEffect(() => {
    if (!projectId) return;
    api.listTranscriptions(projectId).then((jobs) => {
      if (jobs.length > 0) setActiveJob(jobs[0]);
    });
  }, [projectId]);

  // WebSocket + polling for active job
  useEffect(() => {
    if (!activeJob) return;
    if (["completed", "failed", "cancelled"].includes(activeJob.status)) return;

    let ws: WebSocket | null = null;
    const { accessToken } = getStoredTokens();
    if (accessToken) {
      try {
        ws = new WebSocket(`${WS_BASE_URL}/ws/jobs/${activeJob.id}?token=${encodeURIComponent(accessToken)}`);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          setActiveJob((prev) =>
            prev
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
            queryClient.invalidateQueries({ queryKey: ["project", projectId] });
            loadScore();
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
      try {
        const latest = await api.getJob(activeJob.id);
        setActiveJob(latest);
        if (latest.status === "completed") {
          clearInterval(pollInterval);
          queryClient.invalidateQueries({ queryKey: ["project", projectId] });
          loadScore();
        } else if (latest.status === "failed" || latest.status === "cancelled") {
          clearInterval(pollInterval);
          queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        }
      } catch {
        // ignore transient poll errors
      }
    }, pollMs);

    return () => {
      clearInterval(pollInterval);
      if (ws) ws.close();
    };
  }, [activeJob?.id, activeJob?.status, workerStatus?.worker_online, projectId, queryClient, loadScore]);

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
    async (dataToSave: ScoreData, versionToSave: number) => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const updated = await api.saveScore(projectId, dataToSave, versionToSave);
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

  const mutateScore = (updater: (prev: ScoreData) => ScoreData) => {
    if (!scoreData) return;
    setUndoStack((s) => [...s.slice(-29), scoreData]);
    setRedoStack([]);
    const next = updater(scoreData);
    setScoreData(next);
    setSaveStatus("unsaved");

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      persistScore(next, scoreVersion);
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
      setScoreData((prev) => (prev ? { ...prev, title: updated.title } : prev));
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
    setIsStartingJob(true);
    try {
      const orig = project.media_assets.find((a) => a.asset_type === "original");
      const job = await api.startTranscription(project.id, orig?.id || null, settings);
      setActiveJob(job);
    } finally {
      setIsStartingJob(false);
    }
  };

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

  const originalAsset = project.media_assets.find((a) => a.asset_type === "original") || null;

  return (
    <AppShell>
      <div className="mx-auto max-w-[1600px] px-3 sm:px-4 py-4 space-y-4 min-w-0">
        {/* Top Studio Toolbar */}
        <div
          data-testid="studio-header"
          className="flex flex-col gap-3 rounded-xl border border-[#27273A] bg-[#11111B] px-3 sm:px-4 py-3 min-w-0 sm:flex-row sm:items-center sm:justify-between"
        >
          {/* Row 1 on mobile: Navigation (left) + Actions (right); on sm+: contents flatten into single row */}
          <div className="flex items-center justify-between gap-2 w-full sm:w-auto sm:contents">
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 sm:order-1">
              <Link
                to="/dashboard"
                className="rounded-lg p-2 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF] shrink-0"
                aria-label="Back to Dashboard"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <button
                type="button"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="rounded-lg p-2 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF] shrink-0"
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
                    {saveStatus === "saving" && "Saving..."}
                    {saveStatus === "saved" && (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <Check className="h-3.5 w-3.5" /> Saved
                      </span>
                    )}
                    {saveStatus === "unsaved" && <span className="text-amber-300">Unsaved changes</span>}
                    {saveStatus === "error" && <span className="text-red-400">{saveError || "Save error"}</span>}
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
                  className="min-w-0 w-full sm:w-auto sm:min-w-[220px] max-w-full bg-[#181824] border border-indigo-500/60 rounded-md px-2 py-0.5 text-sm sm:text-base font-semibold text-[#F5F3FF] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              ) : (
                <div className="flex items-center gap-1.5 min-w-0 max-w-full">
                  <h1
                    onClick={startEditingTitle}
                    title="Rename project"
                    className="text-sm sm:text-base font-semibold truncate min-w-0 max-w-full cursor-pointer hover:text-indigo-200 transition-colors"
                  >
                    {optimisticTitle ?? project.title}
                  </h1>
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    aria-label="Rename project"
                    title="Rename project"
                    className="rounded p-1 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF] focus:outline-none focus:ring-2 focus:ring-indigo-500 shrink-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {renameStatus === "saved" && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400 whitespace-nowrap shrink-0">
                      <Check className="h-3 w-3" /> Renamed
                    </span>
                  )}
                </div>
              )}
              <StatusBadge status={project.status} />
              <WorkerStatusBadge />
            </div>
            {renameError && (
              <div role="alert" className="mt-1 text-xs text-red-400">
                {renameError}
              </div>
            )}
            {scoreData && (
              <div className="text-xs text-[#A1A1AA] flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                <span className="whitespace-nowrap">
                  {scoreData.tempo_bpm} BPM {scoreData.tempo_estimated ? "(est.)" : ""}
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
                <h2 className="text-sm font-semibold">1. Audio / Video Input</h2>
                <MediaUploader
                  projectId={project.id}
                  existingAssets={project.media_assets}
                  hasScore={Boolean(scoreData)}
                  acceptPdf={project.transcription_mode === "satb_pdf"}
                  isProcessing={
                    isStartingJob ||
                    Boolean(activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status))
                  }
                  onUploadComplete={() => queryClient.invalidateQueries({ queryKey: ["project", projectId] })}
                  onMediaRemoved={() => queryClient.invalidateQueries({ queryKey: ["project", projectId] })}
                />
              </div>

              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4 min-w-0">
                <h2 className="text-sm font-semibold">2. Transcription Settings</h2>
                <TranscriptionConfigPanel
                  hasMedia={Boolean(originalAsset)}
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
                    const retried = await api.retryJob(jobId);
                    setActiveJob(retried);
                  }}
                  onRegenerateArrangement={async (arrangementDetail, quantization, mode) => {
                    if (!projectId) return;
                    setIsRegeneratingArrangement(true);
                    try {
                      const updated = await api.regenerateArrangement(projectId, {
                        arrangement_detail: arrangementDetail,
                        quantization,
                        mode,
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
              mediaAssetId={originalAsset?.id || null}
              notes={scoreData?.notes || []}
              durationSeconds={scoreData?.duration_seconds || project.duration_seconds || 0}
              tempoBpm={scoreData?.tempo_bpm || 120}
              playheadSec={playheadSec}
              onPlayheadChange={setPlayheadSec}
              seekRequest={seekRequest}
            />

            {/* Workspace Tabs */}
            <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-3 sm:p-4 space-y-4 min-w-0">
              <div className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-[#27273A] pb-3" role="tablist">
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
                      className={`inline-flex shrink-0 min-h-[40px] items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? "bg-[#8B5CF6] text-[#F5F3FF]"
                          : "text-[#A1A1AA] hover:text-[#F5F3FF] hover:bg-[#181825]"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {scoreData &&
                (() => {
                  const isGenuineSatb =
                    project.transcription_mode === "satb_pdf" ||
                    scoreData.analysis?.mode === "satb_pdf" ||
                    Boolean(scoreData.analysis?.satb);
                  const canShowMixer = isGenuineSatb || scoreData.tracks.length > 1;
                  if (!canShowMixer) return null;
                  const mixerOpen = showPartMixerOverride ?? isGenuineSatb;
                  return (
                    <div className="space-y-2">
                      {!isGenuineSatb && (
                        <div className="flex items-center justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowPartMixerOverride(!mixerOpen)}
                          >
                            {mixerOpen ? "Hide SATB / Part Mixer" : "Show SATB / Part Mixer"}
                          </Button>
                        </div>
                      )}
                      {mixerOpen && (
                        <SATBMixerPanel
                          projectId={project.id}
                          projectTitle={project.title}
                          scoreData={scoreData}
                          onScoreUpdated={(updatedScore, updatedVersion, updatedXml) => {
                            setScoreData(updatedScore);
                            setScoreVersion(updatedVersion);
                            if (updatedXml !== null) setMusicxml(updatedXml);
                          }}
                        />
                      )}
                    </div>
                  );
                })()}

              {activeTab === "notation" &&
                (activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status) ? (
                  <div className="flex min-h-[16rem] flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-3">
                    {activeJob.status === "queued" && (workerStatus?.worker_online === false || activeJob.worker_online === false) ? (
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
                          Transcription in progress: {activeJob.current_stage} ({activeJob.progress}%)
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
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-xs text-red-300">
                    {scoreLoadError || "You are not authorized to view this score."}
                  </div>
                ) : scoreLoadState === "error" ? (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center space-y-3">
                    <div className="text-xs text-red-300">{scoreLoadError || "Failed to load score."}</div>
                    <Button size="sm" variant="secondary" onClick={loadScore}>
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
                    showChordSymbols={showChordSymbols}
                    onToggleChordSymbols={handleToggleChordSymbols}
                  />
                ))}

              {activeTab === "pianoroll" &&
                (scoreData ? (
                  <PianoRollEditor
                    notes={scoreData.notes}
                    durationSeconds={scoreData.duration_seconds}
                    tempoBpm={scoreData.tempo_bpm}
                    playheadSec={playheadSec}
                    selectedNoteId={selectedNoteId}
                    onSelectNote={setSelectedNoteId}
                    onChangeNotes={handleNotesChange}
                  />
                ) : (
                  <div className="py-12 text-center text-sm text-[#A1A1AA]">
                    Run AI transcription to edit notes in the Piano Roll.
                  </div>
                ))}

              {activeTab === "chords" &&
                (scoreData ? (
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
                  projectTitle={project.title}
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
                  projectTitle={project.title}
                  hasScore={Boolean(scoreData)}
                  showChordSymbols={showChordSymbols}
                  onToggleChordSymbols={handleToggleChordSymbols}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
