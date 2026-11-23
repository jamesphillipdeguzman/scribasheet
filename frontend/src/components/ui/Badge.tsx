import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  ready:
    "bg-emerald-50 text-emerald-800 border-emerald-300 font-semibold dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/35",
  completed:
    "bg-emerald-50 text-emerald-800 border-emerald-300 font-semibold dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/35",
  processing:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  queued:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  waiting_for_worker:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
  validating:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  preprocessing:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  separating:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  transcribing:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  generating_notation:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  finalizing:
    "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-[#A78BFA]/15 dark:text-[#A78BFA] dark:border-[#A78BFA]/30",
  failed:
    "bg-red-50 text-red-800 border-red-300 font-semibold dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/35",
  cancelled:
    "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/30",
  draft:
    "bg-slate-100 text-slate-700 border-slate-300 dark:bg-[#181825] dark:text-[#A1A1AA] dark:border-[#27273A]",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const key = status.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        STATUS_STYLES[key] || STATUS_STYLES.draft,
        className
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
