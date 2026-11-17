import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { api, ApiError } from "@/services/api";
import { cn } from "@/lib/utils";
import type { WorkerStatus } from "@/types/api";

function formatLastSeen(sec: number | null): string {
  if (sec === null) return "never seen";
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function isValidWorkerStatus(data: unknown): data is WorkerStatus {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<WorkerStatus>;
  return (
    typeof candidate.worker_online === "boolean" &&
    (candidate.status === "online" || candidate.status === "offline") &&
    typeof candidate.queue_depth === "number"
  );
}

function getUnavailableReason(error: unknown, data: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return `Authentication required to check worker status (HTTP ${error.status}).`;
    }
    if (error.status === 404) {
      return "Worker status endpoint not found on API (HTTP 404).";
    }
    if (error.status >= 500) {
      return `API server error while checking worker status (HTTP ${error.status}).`;
    }
    return `Worker status request failed (HTTP ${error.status}).`;
  }
  if (data !== undefined && !isValidWorkerStatus(data)) {
    return "Unexpected response format from worker status endpoint.";
  }
  return "Cannot reach API to check worker status.";
}

export function WorkerStatusBadge({ className }: { className?: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => api.getWorkerStatus(),
    refetchInterval: 12000,
    refetchOnWindowFocus: false,
    retry: 1,
    staleTime: 0,
  });

  if (isLoading) {
    return (
      <span
        data-status="loading"
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-[#27273A] bg-[#11111B] px-3 py-1 text-xs text-[#A1A1AA]",
          className
        )}
      >
        <Cpu className="h-3.5 w-3.5" />
        Checking worker...
      </span>
    );
  }

  if (isError || !isValidWorkerStatus(data)) {
    const reason = getUnavailableReason(error, data);
    return (
      <span
        data-status="unavailable"
        title={reason}
        aria-label={`Worker status unavailable: ${reason}`}
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-[#27273A] bg-[#11111B] px-3 py-1 text-xs text-[#A1A1AA]",
          className
        )}
      >
        <span className="h-2 w-2 rounded-full bg-zinc-500" />
        Worker status unavailable
      </span>
    );
  }

  const online = data.worker_online;
  return (
    <span
      data-status={online ? "online" : "offline"}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        online
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-200",
        className
      )}
      data-testid="worker-status-badge"
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", online ? "bg-emerald-400" : "bg-amber-400")} />
      <span>{online ? "Desktop Worker Online" : "Desktop Worker Offline"}</span>
      {!online && data.last_seen_seconds !== null && (
        <span className="text-[11px] opacity-80">({formatLastSeen(data.last_seen_seconds)})</span>
      )}
      {data.queue_depth > 0 && (
        <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px]">
          {data.queue_depth} queued
        </span>
      )}
    </span>
  );
}
