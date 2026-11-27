import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Edit3,
  GalleryHorizontal,
  LayoutGrid,
  List,
  Music2,
  Piano,
  Trash2,
} from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import {
  cn,
  formatDuration,
  formatLocalDateTime,
  TRANSCRIPTION_MODES,
} from "@/lib/utils";
import type { Project } from "@/types/api";

export type DashboardViewMode = "grid" | "list" | "carousel";

export const DASHBOARD_VIEW_STORAGE_KEY = "scribasheet_dashboard_view";

const MODE_LABELS: Record<string, string> = Object.fromEntries(
  TRANSCRIPTION_MODES.map((m) => [m.id, m.label]),
);
MODE_LABELS.midi_playground = "MIDI Playground";

export function parseDashboardViewMode(value: unknown): DashboardViewMode {
  if (value === "grid" || value === "list" || value === "carousel") {
    return value;
  }
  return "grid";
}

export function loadDashboardViewMode(): DashboardViewMode {
  if (typeof window === "undefined") {
    return "grid";
  }
  try {
    return parseDashboardViewMode(window.localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY));
  } catch {
    return "grid";
  }
}

export function saveDashboardViewMode(mode: DashboardViewMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, mode);
  } catch {
    // Ignore storage quota or private browsing write failures
  }
}

export interface ProjectActionHandlers {
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onOpenStudio: (projectId: string) => void;
  onStartRename: (project: Project) => void;
  onSubmitRename: (projectId: string, title: string) => void;
  onCancelRename: () => void;
  onArchive: (project: Project) => void;
  onDuplicate: (projectId: string) => void;
  onDelete: (projectId: string) => void;
}

const SECONDARY_ICON_BTN_CLASS =
  "p-2 rounded-lg text-stone-600 hover:bg-violet-50 hover:text-violet-700 border border-transparent hover:border-violet-200 transition-colors dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white dark:hover:border-white/10";
const DELETE_ICON_BTN_CLASS =
  "p-2 rounded-lg text-stone-600 hover:bg-rose-50 hover:text-rose-700 border border-transparent hover:border-rose-200 transition-colors dark:text-slate-400 dark:hover:bg-rose-500/15 dark:hover:text-rose-300 dark:hover:border-rose-500/30";

function ProjectActionButtons({
  project,
  actions,
}: {
  project: Project;
  actions: ProjectActionHandlers;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        title="Rename project"
        aria-label="Rename project"
        onClick={() => actions.onStartRename(project)}
        className={SECONDARY_ICON_BTN_CLASS}
      >
        <Edit3 className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Archive session (.scribasheet)"
        aria-label="Archive session (.scribasheet)"
        data-testid={`archive-project-${project.id}`}
        onClick={() => actions.onArchive(project)}
        className={SECONDARY_ICON_BTN_CLASS}
      >
        <Archive className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Duplicate project"
        aria-label="Duplicate project"
        onClick={() => actions.onDuplicate(project.id)}
        className={SECONDARY_ICON_BTN_CLASS}
      >
        <Copy className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Delete project"
        aria-label="Delete project"
        onClick={() => actions.onDelete(project.id)}
        className={DELETE_ICON_BTN_CLASS}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ProjectTitleOrRenameForm({
  project,
  actions,
}: {
  project: Project;
  actions: ProjectActionHandlers;
}) {
  if (actions.renamingId === project.id) {
    return (
      <form
        className="flex-1 flex gap-2 min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (actions.renameValue.trim()) {
            actions.onSubmitRename(project.id, actions.renameValue.trim());
          }
        }}
      >
        <input
          value={actions.renameValue}
          onChange={(e) => actions.onRenameValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              actions.onCancelRename();
            }
          }}
          autoFocus
          className="flex-1 min-w-0 h-9 rounded px-2 text-sm bg-white text-stone-900 border border-violet-500 ring-2 ring-violet-500/20 placeholder:text-stone-400 focus:outline-none dark:bg-slate-900 dark:text-white dark:border-violet-400 dark:ring-violet-400/25"
        />
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => actions.onOpenStudio(project.id)}
      className="min-w-0 flex-1 text-left font-semibold text-[#F5F3FF] hover:text-[#A78BFA] transition-colors truncate"
    >
      {project.title}
    </button>
  );
}

export function DashboardViewSwitcher({
  viewMode,
  onChange,
}: {
  viewMode: DashboardViewMode;
  onChange: (mode: DashboardViewMode) => void;
}) {
  const options: Array<{
    mode: DashboardViewMode;
    label: string;
    tooltip: string;
    Icon: typeof LayoutGrid;
  }> = [
    { mode: "grid", label: "Grid view", tooltip: "Grid view", Icon: LayoutGrid },
    { mode: "list", label: "List view", tooltip: "List view", Icon: List },
    { mode: "carousel", label: "Carousel view", tooltip: "Carousel view", Icon: GalleryHorizontal },
  ];

  return (
    <div
      role="group"
      aria-label="Project view mode"
      data-testid="dashboard-view-switcher"
      className="inline-flex h-10 shrink-0 items-center rounded-lg border border-stone-200 bg-white p-1 gap-1 dark:border-[#27273A] dark:bg-[#11111B]"
    >
      {options.map(({ mode, label, tooltip, Icon }) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            title={tooltip}
            aria-pressed={active}
            data-testid={`view-mode-${mode}`}
            onClick={() => onChange(mode)}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
              active
                ? "bg-violet-600 text-white shadow-sm dark:bg-[#8B5CF6] dark:text-[#F5F3FF]"
                : "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export function ProjectCard({
  project,
  actions,
  isActive = false,
}: {
  project: Project;
  actions: ProjectActionHandlers;
  isActive?: boolean;
}) {
  return (
    <Card
      className={cn(
        "min-w-0 hover:border-[#A78BFA]/40 transition-colors flex flex-col justify-between h-full",
        isActive &&
          "border-violet-500/60 ring-2 ring-violet-500/35 dark:border-[#A78BFA]/60 dark:ring-[#A78BFA]/40",
      )}
    >
      <CardContent className="p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <ProjectTitleOrRenameForm project={project} actions={actions} />
          <StatusBadge status={project.status} />
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-[#A1A1AA]">
          <span className="inline-flex items-center gap-1 capitalize">
            <Music2 className="h-3.5 w-3.5 text-[#A78BFA]" aria-hidden="true" />
            {project.instrument.replace(/_/g, " ")}
          </span>
          {project.transcription_mode === "midi_playground" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              <Piano className="h-2.5 w-2.5" aria-hidden="true" />
              MIDI Playground
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {formatDuration(project.duration_seconds)}
          </span>
        </div>

        <div className="text-xs text-[#71717A]">
          Updated {formatLocalDateTime(project.updated_at)}
        </div>

        <div className="pt-2 border-t border-[#27273A] flex items-center justify-between gap-2">
          <Button size="sm" onClick={() => actions.onOpenStudio(project.id)}>
            Open Studio
          </Button>
          <ProjectActionButtons project={project} actions={actions} />
        </div>
      </CardContent>
    </Card>
  );
}

export function ProjectGridView({
  projects,
  actions,
}: {
  projects: Project[];
  actions: ProjectActionHandlers;
}) {
  return (
    <div
      data-testid="projects-grid-view"
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
    >
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} actions={actions} />
      ))}
    </div>
  );
}

export function ProjectListView({
  projects,
  actions,
}: {
  projects: Project[];
  actions: ProjectActionHandlers;
}) {
  return (
    <div
      data-testid="projects-list-view"
      className="rounded-xl border border-[#27273A] bg-[#11111B] overflow-hidden divide-y divide-[#27273A]"
    >
      <div className="hidden lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.5fr)_5.5rem_7rem_10.5rem_auto] gap-3 items-center px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#A1A1AA]">
        <span>Title</span>
        <span>Type / Instrument</span>
        <span>Duration</span>
        <span>Status</span>
        <span>Last Updated</span>
        <span className="text-right">Actions</span>
      </div>
      {projects.map((project) => {
        const modeLabel =
          MODE_LABELS[project.transcription_mode] ||
          project.transcription_mode.replace(/_/g, " ");
        const instrumentLabel = project.instrument.replace(/_/g, " ");
        return (
          <div
            key={project.id}
            data-testid={`project-list-row-${project.id}`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3 hover:bg-stone-50/80 dark:hover:bg-[#181825]/60 transition-colors lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.5fr)_5.5rem_7rem_10.5rem_auto] lg:items-center lg:gap-3"
          >
            <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 lg:flex-none flex items-center">
              <ProjectTitleOrRenameForm project={project} actions={actions} />
            </div>

            <div className="flex items-center gap-1 text-xs text-[#A1A1AA] min-w-0 capitalize truncate">
              {project.transcription_mode === "midi_playground" ? (
                <Piano className="h-3.5 w-3.5 shrink-0 text-[#A78BFA]" aria-hidden="true" />
              ) : (
                <Music2 className="h-3.5 w-3.5 shrink-0 text-[#A78BFA]" aria-hidden="true" />
              )}
              <span className="truncate">
                {modeLabel} &middot; {instrumentLabel}
              </span>
            </div>

            <div className="flex items-center gap-1 text-xs text-[#A1A1AA] whitespace-nowrap">
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{formatDuration(project.duration_seconds)}</span>
            </div>

            <div className="flex items-center">
              <StatusBadge status={project.status} />
            </div>

            <div className="text-xs text-[#71717A] whitespace-nowrap">
              {formatLocalDateTime(project.updated_at)}
            </div>

            <div className="flex items-center justify-between sm:justify-end gap-2 basis-full sm:basis-auto lg:justify-end">
              <Button size="sm" onClick={() => actions.onOpenStudio(project.id)}>
                Open Studio
              </Button>
              <ProjectActionButtons project={project} actions={actions} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectCarouselView({
  projects,
  actions,
}: {
  projects: Project[];
  actions: ProjectActionHandlers;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeProjectIdRef = useRef<string | null>(projects[0]?.id ?? null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const rafRef = useRef<number | null>(null);

  const clampedIndex =
    projects.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), projects.length - 1);

  // Reconcile tracked project position when search/filter/sort/duplicate/delete mutates list
  useEffect(() => {
    if (projects.length === 0) {
      activeProjectIdRef.current = null;
      setActiveIndex(0);
      return;
    }

    const trackedId = activeProjectIdRef.current;
    if (trackedId) {
      const preservedIdx = projects.findIndex((p) => p.id === trackedId);
      if (preservedIdx !== -1) {
        setActiveIndex(preservedIdx);
        return;
      }
    }

    const nextIdx = Math.min(activeIndex, projects.length - 1);
    activeProjectIdRef.current = projects[nextIdx].id;
    setActiveIndex(nextIdx);
  }, [projects, activeIndex]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  if (projects.length === 0) {
    return null;
  }

  const scrollToIndex = (targetIdx: number) => {
    const clamped = Math.min(Math.max(targetIdx, 0), projects.length - 1);
    activeProjectIdRef.current = projects[clamped]?.id ?? null;
    setActiveIndex(clamped);

    const trackEl = trackRef.current;
    const cardEl = cardRefs.current[clamped];
    if (trackEl && cardEl && typeof trackEl.scrollTo === "function") {
      trackEl.scrollTo({ left: cardEl.offsetLeft, behavior: "smooth" });
    }
  };

  const handleTrackScroll = () => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      const trackEl = trackRef.current;
      if (!trackEl || trackEl.scrollWidth <= trackEl.clientWidth) {
        return;
      }
      const scrollLeft = trackEl.scrollLeft;
      let nearestIdx = 0;
      let nearestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < projects.length; i += 1) {
        const cardEl = cardRefs.current[i];
        if (!cardEl) continue;
        const dist = Math.abs(cardEl.offsetLeft - scrollLeft);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }
      activeProjectIdRef.current = projects[nearestIdx]?.id ?? null;
      setActiveIndex(nearestIdx);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const targetTag = (e.target as HTMLElement | null)?.tagName;
    if (targetTag === "INPUT" || targetTag === "TEXTAREA" || targetTag === "SELECT") {
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollToIndex(clampedIndex + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollToIndex(clampedIndex - 1);
    }
  };

  return (
    <div data-testid="projects-carousel-view" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-[#A1A1AA]">
          Use arrows, swipe, or Left/Right keys when focused to browse projects
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            data-testid="carousel-position"
            className="text-xs font-mono font-medium text-[#A1A1AA] min-w-[3.5rem] text-center"
          >
            {clampedIndex + 1} / {projects.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous project"
            data-testid="carousel-prev-btn"
            disabled={clampedIndex <= 0}
            onClick={() => scrollToIndex(clampedIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next project"
            data-testid="carousel-next-btn"
            disabled={clampedIndex >= projects.length - 1}
            onClick={() => scrollToIndex(clampedIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        ref={trackRef}
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label="Projects carousel"
        data-testid="projects-carousel-track"
        onScroll={handleTrackScroll}
        onKeyDown={handleKeyDown}
        className="flex overflow-x-auto snap-x snap-mandatory gap-4 scroll-smooth pb-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#A78BFA]/60"
      >
        {projects.map((project, idx) => (
          <div
            key={project.id}
            ref={(el) => {
              cardRefs.current[idx] = el;
            }}
            data-testid={`carousel-card-${project.id}`}
            className="snap-start shrink-0 w-[85vw] sm:w-[340px] lg:w-[360px]"
          >
            <ProjectCard
              project={project}
              actions={actions}
              isActive={idx === clampedIndex}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
