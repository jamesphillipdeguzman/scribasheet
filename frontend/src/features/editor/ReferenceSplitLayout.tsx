import type { CSSProperties, ReactNode } from "react";
import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ReferenceSheetViewer } from "@/features/editor/ReferenceSheetViewer";

export interface ReferenceSheetSplitConfig {
  enabled: boolean;
  collapsed: boolean;
  splitPct: number;
  onClose: () => void;
  onToggleCollapse: () => void;
  onSplitPctChange: (nextPct: number) => void;
}

interface ReferenceSplitLayoutProps {
  config?: ReferenceSheetSplitConfig;
  isFocusMode?: boolean;
  children: ReactNode;
}

export function ReferenceSplitLayout({
  config,
  isFocusMode = false,
  children,
}: ReferenceSplitLayoutProps) {
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const isSplitEnabled = Boolean(config?.enabled);
  const isCollapsed = Boolean(config?.collapsed);
  const splitPct = config?.splitPct ?? 50;

  return (
    <div
      ref={splitContainerRef}
      data-testid="playground-split-workspace"
      className={
        isSplitEnabled
          ? `flex flex-col lg:flex-row min-w-0 items-stretch gap-2 lg:gap-0 ${
              isFocusMode ? "flex-1 min-h-0" : ""
            }`
          : `min-w-0 ${isFocusMode ? "flex-1 min-h-0 flex flex-col" : ""}`
      }
    >
      {isSplitEnabled && config && (
        <>
          <div
            key="reference-sheet-pane"
            data-testid="reference-sheet-pane"
            data-collapsed={isCollapsed ? "true" : "false"}
            style={
              isCollapsed
                ? undefined
                : ({ ["--ref-split-pct"]: `${splitPct}%` } as CSSProperties)
            }
            className={`relative min-w-0 overflow-hidden ${
              isDragging ? "" : "transition-[flex-basis,width] duration-200 ease-out"
            } ${
              isCollapsed
                ? "w-full h-9 lg:h-auto lg:w-[28px] lg:basis-[28px] lg:min-w-[28px] lg:max-w-[28px] lg:shrink-0 lg:mr-2"
                : "w-full basis-auto lg:w-auto lg:basis-[var(--ref-split-pct)] lg:min-w-[260px] lg:shrink-0"
            }`}
          >
            {/* Keep ReferenceSheetViewer mounted so loaded files, PDF page, zoom & scrollTop survive collapse/expand */}
            <div
              data-testid="reference-sheet-content-host"
              aria-hidden={isCollapsed}
              className={
                isCollapsed
                  ? "invisible pointer-events-none absolute inset-y-0 left-0 w-[480px] select-none"
                  : "h-full w-full"
              }
            >
              <ReferenceSheetViewer
                onClose={config.onClose}
                onCollapse={config.onToggleCollapse}
              />
            </div>

            {isCollapsed && (
              <button
                type="button"
                data-testid="reference-collapsed-rail"
                aria-label="Expand reference sheet"
                aria-expanded={false}
                title="Expand reference sheet"
                onClick={config.onToggleCollapse}
                className="flex h-full w-full items-center justify-center gap-1.5 rounded-xl border border-stone-300 bg-stone-100 px-1.5 py-2 text-[11px] font-semibold text-stone-700 hover:bg-violet-50 hover:border-violet-400 hover:text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-[#27273A] dark:bg-[#11111B] dark:text-slate-200 dark:hover:bg-violet-500/15 dark:hover:border-violet-400/60 dark:hover:text-violet-200 transition-colors"
              >
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="lg:[writing-mode:vertical-rl] lg:rotate-180 tracking-wide whitespace-nowrap">
                  Reference
                </span>
              </button>
            )}
          </div>

          {!isCollapsed && (
            <div
              key="reference-split-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize reference sheet split view"
              aria-valuemin={25}
              aria-valuemax={75}
              aria-valuenow={splitPct}
              tabIndex={0}
              data-testid="reference-split-divider"
              onPointerDown={(e) => {
                const container = splitContainerRef.current;
                if (!container) return;
                e.preventDefault();
                setIsDragging(true);
                const onMove = (ev: PointerEvent) => {
                  const rect = container.getBoundingClientRect();
                  if (rect.width <= 0) return;
                  const pct = ((ev.clientX - rect.left) / rect.width) * 100;
                  config.onSplitPctChange(pct);
                };
                const onUp = () => {
                  setIsDragging(false);
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.dispatchEvent(new Event("resize"));
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  config.onSplitPctChange(splitPct - 5);
                  window.dispatchEvent(new Event("resize"));
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  config.onSplitPctChange(splitPct + 5);
                  window.dispatchEvent(new Event("resize"));
                }
              }}
              className="hidden lg:flex w-4 shrink-0 cursor-col-resize flex-col items-center justify-center gap-1.5 mx-0.5 rounded bg-stone-200/80 hover:bg-violet-400/40 dark:bg-[#1B1B29] dark:hover:bg-violet-500/30 transition-colors select-none"
              title="Drag or use Left/Right arrows to resize panes"
            >
              <button
                type="button"
                data-testid="reference-divider-toggle-btn"
                aria-label="Collapse reference sheet"
                aria-expanded={true}
                title="Collapse reference sheet"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  config.onToggleCollapse();
                }}
                className="inline-flex h-7 w-3.5 items-center justify-center rounded border border-stone-300 bg-white text-stone-700 hover:bg-violet-50 hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-[#34344C] dark:bg-[#141422] dark:text-slate-200 dark:hover:bg-violet-500/20 dark:hover:text-violet-200"
              >
                <ChevronLeft className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
              <div className="h-8 w-0.5 rounded-full bg-stone-400 dark:bg-slate-500" />
            </div>
          )}
        </>
      )}

      <div
        key="studio-score-canvas-pane"
        data-testid="studio-score-canvas-pane"
        className={
          isSplitEnabled
            ? `min-w-0 flex-1 flex flex-col ${isFocusMode ? "min-h-0" : ""}`
            : `min-w-0 flex flex-col ${isFocusMode ? "flex-1 min-h-0" : ""}`
        }
      >
        {children}
      </div>
    </div>
  );
}
