import { useQuery } from "@tanstack/react-query";
import { Cpu, Loader2 } from "lucide-react";
import { useWorkerConnection } from "@/features/worker/useWorkerConnection";
import { api, ApiError, isAuthError } from "@/services/api";
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
    (candidate.status === "online" ||
      candidate.status === "busy" ||
      candidate.status === "stale" ||
      candidate.status === "offline") &&
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
  const { isConnecting } = useWorkerConnection();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => api.getWorkerStatus(),
    refetchInterval: (query) =>
      isAuthError(query.state.error) ? false : isConnecting ? 1500 : 12000,
    refetchOnWindowFocus: false,
    retry: (failureCount, err) => !isAuthError(err) && failureCount < 1,
    staleTime: 0,
  });

  useWorkerConnection(data?.worker_online);

  if (isLoading) {
    return (
      <span
        data-status="loading"
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs text-slate-700 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA]",
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
          "inline-flex items-center gap-2 rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs text-slate-700 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA]",
          className
        )}
      >
        <span className="h-2 w-2 rounded-full bg-zinc-500" />
        Worker status unavailable
      </span>
    );
  }

  const online = data.worker_online;
  const connecting = !online && isConnecting;
  const isBusy = online && data.status === "busy";
  const isStale = online && data.status === "stale";
  const dataStatus = connecting
    ? "connecting"
    : !online
      ? "offline"
      : isStale
        ? "stale"
        : isBusy
          ? "busy"
          : "online";

  return (
    <span
      data-status={dataStatus}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap shrink-0 rounded-full border px-3 py-1 text-xs",
        online && !isStale
          ? isBusy
            ? "bg-indigo-50 text-indigo-800 border-indigo-300 font-semibold dark:bg-indigo-500/15 dark:text-indigo-200 dark:border-indigo-500/35 dark:font-medium"
            : "bg-emerald-50 text-emerald-800 border-emerald-300 font-semibold dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/35 dark:font-medium"
          : connecting
            ? "bg-violet-50 text-violet-900 border-violet-300 font-semibold dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/35 dark:font-medium"
            : "bg-amber-50 text-amber-800 border-amber-300 font-semibold dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-500/30 dark:font-medium",
        className
      )}
      data-testid="worker-status-badge"
    >
      {connecting ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-violet-600 dark:text-violet-300" />
      ) : (
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            online && !isStale
              ? isBusy
                ? "bg-indigo-600 dark:bg-indigo-400 animate-pulse"
                : "bg-emerald-600 dark:bg-emerald-400"
              : "bg-amber-600 dark:bg-amber-400"
          )}
        />
      )}
      <span>
        {connecting
          ? "Connecting Desktop Worker..."
          : !online
            ? "Desktop Worker Offline"
            : isStale
              ? "Desktop Worker Stale"
              : isBusy
                ? "Desktop Worker Busy"
                : "Desktop Worker Online"}
      </span>
      {(!online || isStale) && !connecting && data.last_seen_seconds !== null && (
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
