import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Copy,
  Edit3,
  FolderPlus,
  Loader2,
  Music2,
  Piano,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AmbientScoreBackdrop } from "@/components/AmbientScoreBackdrop";
import { AppShell } from "@/components/AppShell";
import { WorkerControlPanel } from "@/components/WorkerControlPanel";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/features/auth/AuthContext";
import { ArchiveExportModal } from "@/features/projects/ArchiveExportModal";
import { ArchiveImportModal } from "@/features/projects/ArchiveImportModal";
import { formatBytes, formatDuration, formatLocalDateTime, SUPPORTED_INSTRUMENTS, TRANSCRIPTION_MODES } from "@/lib/utils";
import { api, ApiError } from "@/services/api";
import type { Project } from "@/types/api";

export function DashboardPage() {
  const { user, usage, refreshUser } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("updated_at");
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    if (!showCreateModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !createMutation.isPending) {
        setShowCreateModal(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const [newTitle, setNewTitle] = useState("");
  const [newInstrument, setNewInstrument] = useState("piano");
  const [newMode, setNewMode] = useState("piano");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archivingProject, setArchivingProject] = useState<Project | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects", search, statusFilter, sortBy],
    queryFn: () =>
      api.listProjects({
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        sort_by: sortBy,
        sort_dir: sortBy === "title" ? "asc" : "desc",
      }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createProject({
        title: newTitle.trim() || "Untitled Transcription",
        instrument: newInstrument,
        transcription_mode: newMode,
      }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setShowCreateModal(false);
      setNewTitle("");
      navigate(`/projects/${project.id}`);
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => api.duplicateProject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  const createPlaygroundMutation = useMutation({
    mutationFn: () =>
      api.createPlaygroundProject({
        title: "Untitled Playground",
        key_signature: "C Major",
        time_signature: "4/4",
        tempo_bpm: 120,
        clef_mode: "grand",
        measures: 4,
      }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${project.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => {
      setActionError(null);
      return api.deleteProject(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void refreshUser();
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete project and reclaim storage.");
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.updateProject(id, { title }),
    onSuccess: () => {
      setRenamingId(null);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const projects = data?.items || [];

  return (
    <AppShell>
      <div className="relative mx-auto max-w-7xl px-4 pt-10 pb-8 sm:px-6 sm:pt-12 space-y-6">
        <AmbientScoreBackdrop variant="watermark" className="h-64 sm:h-72" />
        {/* Top Welcome & CTA */}
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight break-words">
              Welcome back, {user?.display_name || "Musician"}
            </h1>
            <p className="text-sm text-[#A1A1AA]">
              Manage your transcription projects, review sheet music, and export your scores.
            </p>
            <WorkerStatusBadge />
          </div>
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 w-full sm:w-auto shrink-0">
            <Button
              variant="outline"
              onClick={() => setShowImportModal(true)}
              data-testid="import-archive-btn"
              title="Restore a backed-up .scribasheet project archive."
              className="w-full sm:w-auto min-h-[44px]"
            >
              <ArchiveRestore className="h-4 w-4 text-[#A78BFA]" />
              Import Archive (.scribasheet)
            </Button>
            <Button
              variant="secondary"
              onClick={() => createPlaygroundMutation.mutate()}
              disabled={createPlaygroundMutation.isPending}
              data-testid="new-midi-playground-btn"
              title="Open a blank grand-staff score for live MIDI keyboard & notation editing."
              className="w-full sm:w-auto min-h-[44px] border border-violet-400/50 bg-violet-50 text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
            >
              {createPlaygroundMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Piano className="h-4 w-4" />
              )}
              MIDI Playground
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setNewMode("satb_pdf");
                setNewInstrument("piano");
                setShowCreateModal(true);
              }}
              title="Upload a PDF or sheet music photos (JPG, PNG, WebP) and turn them into playable scores & audio."
              className="w-full sm:w-auto min-h-[44px]"
            >
              <Music2 className="h-4 w-4" />
              Sheet Music to Audio
            </Button>
            <Button
              onClick={() => {
                setNewInstrument("piano");
                setNewMode("piano");
                setShowCreateModal(true);
              }}
              className="w-full sm:w-auto min-h-[44px]"
            >
              <Plus className="h-4 w-4" />
              New Transcription
            </Button>
          </div>
        </div>

        <WorkerControlPanel />

        {actionError && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/35 bg-red-500/10 p-3 text-xs text-red-300 flex items-center justify-between gap-3"
          >
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="text-red-200 hover:text-white">
              Dismiss
            </button>
          </div>
        )}

        {/* Usage Summary */}
        {usage && (() => {
          const isUnlimited = Boolean(usage.is_unlimited || user?.is_unlimited);
          const planLabel = usage.plan_label || (isUnlimited ? "UNLIMITED" : usage.plan_tier);
          return (
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="p-4">
                  <div className="text-xs text-[#A1A1AA]">Monthly Transcription Allowance</div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="text-xl font-semibold">
                      {usage.monthly_minutes_used}{" "}
                      <span className="text-sm font-normal text-[#A1A1AA]">
                        {isUnlimited ? "min used" : `/ ${usage.monthly_minutes_limit} min`}
                      </span>
                    </span>
                    <span className="text-xs uppercase text-[#A78BFA]">{planLabel}</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-xs text-[#A1A1AA]">Active Projects</div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="text-xl font-semibold">
                      {usage.project_count}{" "}
                      <span className="text-sm font-normal text-[#A1A1AA]">stored</span>
                    </span>
                    <span className="text-[11px] text-[#A1A1AA]">Uncapped</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[#A1A1AA]">Private Media Storage</span>
                    {(usage.storage_status === "low_space" ||
                      usage.storage_status === "full" ||
                      usage.storage_status === "unavailable") && (
                      <span
                        data-testid="dashboard-storage-warning"
                        className="whitespace-nowrap shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30"
                      >
                        {usage.storage_status === "full"
                          ? "Volume Full"
                          : usage.storage_status === "unavailable"
                            ? "Unavailable"
                            : "Low Disk Space"}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span className="text-xl font-semibold" data-testid="dashboard-storage-used">
                      {typeof usage.storage_used_bytes === "number"
                        ? formatBytes(usage.storage_used_bytes)
                        : `${usage.storage_used_mb} MB`}
                    </span>
                    <span className="text-[11px] text-[#A1A1AA]">
                      {typeof usage.file_count === "number"
                        ? `${usage.file_count} ${usage.file_count === 1 ? "file" : "files"}`
                        : "No app quota"}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        })()}

        {/* Search, Filter & Sort Bar */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#A1A1AA]" />
            <input
              type="search"
              placeholder="Search projects by title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-10 rounded-lg border border-[#27273A] bg-[#11111B] pl-9 pr-3 text-sm text-[#F5F3FF] placeholder:text-[#52526B] focus:border-[#A78BFA] focus:outline-none"
            />
          </div>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-10 rounded-lg border border-[#27273A] bg-[#11111B] px-3 text-sm text-[#F5F3FF] focus:border-[#A78BFA] focus:outline-none"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="processing">Processing</option>
            <option value="ready">Ready</option>
            <option value="failed">Failed</option>
          </select>
          <select
            aria-label="Sort projects"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="h-10 rounded-lg border border-[#27273A] bg-[#11111B] px-3 text-sm text-[#F5F3FF] focus:border-[#A78BFA] focus:outline-none"
          >
            <option value="updated_at">Last Modified</option>
            <option value="created_at">Date Created</option>
            <option value="title">Title (A–Z)</option>
          </select>
        </div>

        {/* Project List */}
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-44 rounded-xl border border-[#27273A] bg-[#11111B] animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <Card className="border-red-500/30">
            <CardContent className="p-6 text-sm text-red-300">
              Failed to load projects. Please refresh or check your connection.
            </CardContent>
          </Card>
        ) : projects.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center space-y-4">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[#27273A] bg-[#181825]">
                <FolderPlus className="h-6 w-6 text-[#A78BFA]" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">No transcription projects yet</h2>
                <p className="mt-1 text-sm text-[#A1A1AA] max-w-md mx-auto">
                  Create your first project to upload an audio or video performance and transcribe it into editable sheet music.
                </p>
              </div>
              <Button onClick={() => setShowCreateModal(true)} className="min-h-[44px]">
                <Plus className="h-4 w-4" />
                Create First Project
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p: Project) => (
              <Card key={p.id} className="min-w-0 hover:border-[#A78BFA]/40 transition-colors flex flex-col justify-between">
                <CardContent className="p-4 sm:p-5 space-y-4 min-w-0">
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    {renamingId === p.id ? (
                      <form
                        className="flex-1 flex gap-2 min-w-0"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (renameValue.trim()) {
                            renameMutation.mutate({ id: p.id, title: renameValue.trim() });
                          }
                        }}
                      >
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          autoFocus
                          className="flex-1 min-w-0 h-9 rounded px-2 text-sm bg-white text-stone-900 border border-violet-500 ring-2 ring-violet-500/20 placeholder:text-stone-400 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-violet-400 dark:ring-violet-400/25"
                        />
                        <Button type="submit" size="sm">Save</Button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(`/projects/${p.id}`)}
                        className="min-w-0 flex-1 text-left font-semibold text-[#F5F3FF] hover:text-[#A78BFA] transition-colors truncate"
                      >
                        {p.title}
                      </button>
                    )}
                    <StatusBadge status={p.status} />
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-[#A1A1AA]">
                    <span className="inline-flex items-center gap-1 capitalize">
                      <Music2 className="h-3.5 w-3.5 text-[#A78BFA]" />
                      {p.instrument.replace(/_/g, " ")}
                    </span>
                    {p.transcription_mode === "midi_playground" && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                        <Piano className="h-2.5 w-2.5" />
                        MIDI Playground
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {formatDuration(p.duration_seconds)}
                    </span>
                  </div>

                  <div className="text-xs text-[#71717A]">
                    Updated {formatLocalDateTime(p.updated_at)}
                  </div>

                  <div className="pt-2 border-t border-[#27273A] flex items-center justify-between gap-2">
                    <Button size="sm" onClick={() => navigate(`/projects/${p.id}`)}>
                      Open Studio
                    </Button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="Rename project"
                        aria-label="Rename project"
                        onClick={() => {
                          setRenamingId(p.id);
                          setRenameValue(p.title);
                        }}
                        className="p-2 rounded-lg text-stone-600 hover:bg-violet-50 hover:text-violet-700 border border-transparent hover:border-violet-200 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white dark:hover:border-white/10"
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Archive session (.scribasheet)"
                        aria-label="Archive session (.scribasheet)"
                        data-testid={`archive-project-${p.id}`}
                        onClick={() => setArchivingProject(p)}
                        className="p-2 rounded-lg text-stone-600 hover:bg-violet-50 hover:text-violet-700 border border-transparent hover:border-violet-200 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white dark:hover:border-white/10"
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Duplicate project"
                        aria-label="Duplicate project"
                        onClick={() => duplicateMutation.mutate(p.id)}
                        className="p-2 rounded-lg text-stone-600 hover:bg-violet-50 hover:text-violet-700 border border-transparent hover:border-violet-200 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white dark:hover:border-white/10"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Delete project"
                        aria-label="Delete project"
                        onClick={() => deleteMutation.mutate(p.id)}
                        className="p-2 rounded-lg text-stone-600 hover:bg-rose-50 hover:text-rose-700 border border-transparent hover:border-rose-200 transition-colors dark:text-slate-400 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 dark:hover:border-rose-500/30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !createMutation.isPending) {
              setShowCreateModal(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-[#27273A] bg-[#11111B] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="text-lg font-semibold">New Transcription Project</h2>
              <button
                type="button"
                onClick={() => {
                  if (!createMutation.isPending) setShowCreateModal(false);
                }}
                disabled={createMutation.isPending}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors dark:text-slate-400 dark:hover:text-white dark:hover:bg-white/10 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <Input
              label="Project Title"
              placeholder="e.g., Chopin Prelude Sketch"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#A1A1AA]">Primary Instrument</label>
              <select
                value={newInstrument}
                onChange={(e) => {
                  const inst = e.target.value;
                  setNewInstrument(inst);
                  if (inst === "piano" && newMode === "single_instrument") {
                    setNewMode("piano");
                  } else if (inst !== "piano" && newMode === "piano") {
                    setNewMode("single_instrument");
                  }
                }}
                className="w-full h-10 rounded-lg border border-[#27273A] bg-[#09090F] px-3 text-sm text-[#F5F3FF]"
              >
                {SUPPORTED_INSTRUMENTS.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#A1A1AA]">Transcription Mode</label>
              <select
                value={newMode}
                onChange={(e) => setNewMode(e.target.value)}
                className="w-full h-10 rounded-lg border border-[#27273A] bg-[#09090F] px-3 text-sm text-[#F5F3FF]"
              >
                {TRANSCRIPTION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create & Open Studio"}
              </Button>
            </div>
          </div>
        </div>
      )}
      <ArchiveExportModal
        isOpen={Boolean(archivingProject)}
        project={archivingProject}
        onClose={() => setArchivingProject(null)}
        onDeleteProject={async (id) => {
          await deleteMutation.mutateAsync(id);
        }}
      />

      <ArchiveImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onRestored={(restored) => {
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
          void refreshUser();
          navigate(`/projects/${restored.id}`);
        }}
      />
    </AppShell>
  );
}
