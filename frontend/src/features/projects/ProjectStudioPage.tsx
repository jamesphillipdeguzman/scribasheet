import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Download,
  FileMusic,
  Guitar,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Piano,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ChordAndTabPanel } from "@/features/editor/ChordAndTabPanel";
import { ExportCenter } from "@/features/editor/ExportCenter";
import { PianoRollEditor } from "@/features/editor/PianoRollEditor";
import { SheetMusicViewer } from "@/features/editor/SheetMusicViewer";
import { WaveformPlayer } from "@/features/editor/WaveformPlayer";
import { TranscriptionConfigPanel } from "@/features/transcription/TranscriptionConfigPanel";
import { MediaUploader } from "@/features/uploads/MediaUploader";
import { api, ApiError, WS_BASE_URL, getStoredTokens } from "@/services/api";
import type { ScoreData, ScoreNote, TranscriptionJob, TranscriptionSettings } from "@/types/api";

type StudioTab = "notation" | "pianoroll" | "chords" | "exports";

export function ProjectStudioPage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<StudioTab>("notation");
  const [playheadSec, setPlayheadSec] = useState(0);
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

  // Job tracking
  const [activeJob, setActiveJob] = useState<TranscriptionJob | null>(null);
  const [isStartingJob, setIsStartingJob] = useState(false);

  const autosaveTimerRef = useRef<number | null>(null);

  const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    enabled: Boolean(projectId),
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
    }, 1200);

    return () => {
      clearInterval(pollInterval);
      if (ws) ws.close();
    };
  }, [activeJob?.id, activeJob?.status, projectId, queryClient, loadScore]);

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
      <div className="mx-auto max-w-[1600px] px-4 py-4 space-y-4">
        {/* Top Studio Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#27273A] bg-[#11111B] px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="rounded-lg p-1.5 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF]"
              aria-label="Back to Dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded-lg p-1.5 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF]"
              aria-label="Toggle ingestion panel"
            >
              {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
            </button>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-base font-semibold">{project.title}</h1>
                <StatusBadge status={project.status} />
              </div>
              {scoreData && (
                <div className="text-xs text-[#A1A1AA] flex flex-wrap items-center gap-2 mt-0.5">
                  <span>{scoreData.tempo_bpm} BPM {scoreData.tempo_estimated ? "(est.)" : ""}</span>
                  <span>•</span>
                  <span>{scoreData.time_signature}</span>
                  <span>•</span>
                  <span>Key: {scoreData.key_signature} {scoreData.key_signature_estimated ? "(est.)" : ""}</span>
                  <span>•</span>
                  <span>{scoreData.notes.length} notes</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {scoreData && (
              <>
                <Button size="sm" variant="ghost" onClick={handleUndo} disabled={undoStack.length === 0} aria-label="Undo">
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={handleRedo} disabled={redoStack.length === 0} aria-label="Redo">
                  <Redo2 className="h-4 w-4" />
                </Button>
                <span className="text-xs text-[#A1A1AA] hidden sm:inline px-2">
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
                >
                  <Save className="h-3.5 w-3.5" />
                  Save Score
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Main Studio Grid */}
        <div className={`grid gap-4 ${sidebarOpen ? "lg:grid-cols-12" : "grid-cols-1"}`}>
          {sidebarOpen && (
            <aside className="lg:col-span-4 xl:col-span-3 space-y-4">
              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4">
                <h2 className="text-sm font-semibold">1. Audio / Video Input</h2>
                <MediaUploader
                  projectId={project.id}
                  existingAssets={project.media_assets}
                  onUploadComplete={() => queryClient.invalidateQueries({ queryKey: ["project", projectId] })}
                />
              </div>

              <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4">
                <h2 className="text-sm font-semibold">2. Transcription Settings</h2>
                <TranscriptionConfigPanel
                  hasMedia={Boolean(originalAsset)}
                  activeJob={activeJob}
                  defaultInstrument={project.instrument}
                  defaultMode={project.transcription_mode}
                  onStart={handleStartTranscription}
                  onCancel={async (jobId) => {
                    const updated = await api.cancelJob(jobId);
                    setActiveJob(updated);
                  }}
                  onRetry={async (jobId) => {
                    const retried = await api.retryJob(jobId);
                    setActiveJob(retried);
                  }}
                  isStarting={isStartingJob}
                />
              </div>
            </aside>
          )}

          {/* Main Editor Canvas */}
          <section className={`${sidebarOpen ? "lg:col-span-8 xl:col-span-9" : ""} space-y-4`}>
            {/* Playback Bar */}
            <WaveformPlayer
              mediaAssetId={originalAsset?.id || null}
              notes={scoreData?.notes || []}
              durationSeconds={scoreData?.duration_seconds || project.duration_seconds || 0}
              tempoBpm={scoreData?.tempo_bpm || 120}
              playheadSec={playheadSec}
              onPlayheadChange={setPlayheadSec}
            />

            {/* Workspace Tabs */}
            <div className="rounded-xl border border-[#27273A] bg-[#11111B] p-4 space-y-4">
              <div className="flex flex-wrap items-center gap-1 border-b border-[#27273A] pb-3" role="tablist">
                {[
                  { id: "notation" as const, label: "Sheet Music", icon: FileMusic },
                  { id: "pianoroll" as const, label: "Piano Roll Editor", icon: Piano },
                  { id: "chords" as const, label: "Chords & Guitar Tab", icon: Guitar },
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
                      className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
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

              {activeTab === "notation" &&
                (activeJob && !["completed", "failed", "cancelled"].includes(activeJob.status) ? (
                  <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-[#27273A] bg-[#09090F] p-6 text-center space-y-2">
                    <Loader2 className="h-6 w-6 animate-spin text-[#A78BFA]" />
                    <div className="text-sm font-medium text-[#F5F3FF]">
                      Transcription in progress: {activeJob.current_stage} ({activeJob.progress}%)
                    </div>
                    <p className="text-xs text-[#A1A1AA]">
                      Sheet music will appear here automatically once a valid score is generated.
                    </p>
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
                  <SheetMusicViewer musicxml={musicxml} />
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

              {activeTab === "exports" && (
                <ExportCenter
                  projectId={project.id}
                  projectTitle={project.title}
                  hasScore={Boolean(scoreData)}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
