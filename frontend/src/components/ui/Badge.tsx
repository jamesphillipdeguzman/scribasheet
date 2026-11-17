import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  processing: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  queued: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  waiting_for_worker: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  validating: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  preprocessing: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  separating: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  transcribing: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  generating_notation: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  finalizing: "bg-[#A78BFA]/15 text-[#A78BFA] border-[#A78BFA]/30",
  failed: "bg-red-500/15 text-red-300 border-red-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  draft: "bg-[#181825] text-[#A1A1AA] border-[#27273A]",
};

export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
        STATUS_STYLES[key] || STATUS_STYLES.draft
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
