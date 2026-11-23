import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, Cpu, KeyRound, Play, RotateCw, Smartphone, Square, Terminal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { api } from "@/services/api";
import {
  clearControllerToken,
  ControllerError,
  getControllerToken,
  isMobileDevice,
  setControllerToken,
  workerController,
} from "@/services/workerController";

interface WorkerControlPanelProps {
  currentJobLabel?: string | null;
}

const PAIRING_TOKEN_COMMAND = "type logs\\worker_controller.token | clip & type logs\\worker_controller.token";

export function WorkerControlPanel({ currentJobLabel }: WorkerControlPanelProps) {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [actionPending, setActionPending] = useState<"start" | "stop" | "restart" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const mobile = isMobileDevice();
  const hasToken = Boolean(getControllerToken());

  const { data: railwayStatus } = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => api.getWorkerStatus(),
    refetchInterval: 12000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const {
    data: controllerStatus,
    isError: controllerErrorFlag,
    error: controllerError,
    refetch: refetchController,
  } = useQuery({
    queryKey: ["controller-status", hasToken],
    queryFn: async () => {
      await workerController.checkHealth();
      if (!getControllerToken()) {
        throw new ControllerError(401, "Pairing token required.");
      }
      return workerController.getStatus();
    },
    enabled: !mobile,
    refetchInterval: 8000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const needsPairing =
    !mobile &&
    controllerErrorFlag &&
    controllerError instanceof ControllerError &&
    controllerError.status === 401;

  const notConnected = !mobile && controllerErrorFlag && !needsPairing;

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setActionNotice(null);
    if (!tokenInput.trim()) return;
    setControllerToken(tokenInput.trim());
    setTokenInput("");
    await refetchController();
  };

  const runAction = async (action: "start" | "stop" | "restart") => {
    setActionError(null);
    setActionNotice(null);
    setActionPending(action);
    try {
      const res =
        action === "start"
          ? await workerController.startWorker()
          : action === "stop"
            ? await workerController.stopWorker()
            : await workerController.restartWorker();
      if (res.message) {
        setActionNotice(res.message);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["controller-status"] }),
        queryClient.invalidateQueries({ queryKey: ["worker-status"] }),
      ]);
    } catch (err) {
      if (err instanceof ControllerError && err.status === 401) {
        clearControllerToken();
        await refetchController();
      }
      setActionError(err instanceof Error ? err.message : "Failed to communicate with local controller.");
    } finally {
      setActionPending(null);
    }
  };

  return (
    <Card className="border-[#27273A] bg-[#11111B]">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-[#A78BFA]" />
            <h2 className="text-sm font-semibold text-[#F5F3FF]">Worker Control</h2>
          </div>
          {railwayStatus && (
            <span className="text-xs text-[#A1A1AA]">
              Railway Heartbeat:{" "}
              <span
                className={
                  railwayStatus.worker_online
                    ? "text-emerald-700 font-semibold dark:text-emerald-400"
                    : "text-amber-700 font-semibold dark:text-amber-300"
                }
              >
                {railwayStatus.worker_online ? "Online" : "Offline"}
              </span>
              {railwayStatus.active_job_count > 0 && ` • ${railwayStatus.active_job_count} active`}
              {railwayStatus.queue_depth > 0 && ` • ${railwayStatus.queue_depth} queued`}
            </span>
          )}
        </div>

        {currentJobLabel && (
          <div className="text-xs text-[#A1A1AA]">
            Current Job: <span className="text-[#F5F3FF]">{currentJobLabel}</span>
          </div>
        )}

        {mobile ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-[#27273A] bg-[#09090F] p-3 text-xs text-[#A1A1AA]">
            <Smartphone className="h-4 w-4 shrink-0 text-[#A78BFA] mt-0.5" />
            <p>
              The local worker controller is installed on your Windows PC (<code className="text-[#F5F3FF]">127.0.0.1</code>).
              A mobile browser cannot start or stop a worker on another device through its own localhost address. You can still submit jobs, monitor Railway worker availability, and access your projects and sheet music here.
            </p>
          </div>
        ) : notConnected ? (
          <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-3 space-y-2 text-xs">
            <div className="font-medium text-amber-200">Local Controller Not Connected</div>
            <p className="text-[#A1A1AA]">
              Start or install the lightweight Windows controller on <code className="text-[#F5F3FF]">127.0.0.1:47832</code> to control your local worker from this browser:
            </p>
            <div className="flex items-center gap-2 rounded bg-[#181825] px-2.5 py-1.5 font-mono text-[11px] text-[#E4E4E7] overflow-x-auto">
              <Terminal className="h-3.5 w-3.5 shrink-0 text-[#A78BFA]" />
              <span>powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_worker_controller.ps1</span>
            </div>
          </div>
        ) : needsPairing ? (
          <form onSubmit={handlePair} className="rounded-lg border border-[#27273A] bg-[#09090F] p-3 space-y-3 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-[#F5F3FF]">
              <KeyRound className="h-3.5 w-3.5 text-[#A78BFA]" />
              <span>Pair Local Controller</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste controller pairing token"
                aria-label="Controller pairing token"
                className="flex-1 min-w-[200px] h-9 rounded-lg border border-[#27273A] bg-[#11111B] px-3 text-xs text-[#F5F3FF]"
              />
              <Button type="submit" size="sm">
                Pair Controller
              </Button>
            </div>
            <div className="rounded-md border border-[#27273A] bg-[#11111B] p-2.5 space-y-2 text-[11px] text-[#A1A1AA]">
              <div className="font-medium text-[#F5F3FF]">Where do I get my pairing token?</div>
              <p>
                The token is saved in <code className="text-[#F5F3FF]">logs\worker_controller.token</code> inside your ScribaSheet project folder.
              </p>
              <p>Open PowerShell in your ScribaSheet project root and run:</p>
              <div className="flex items-center justify-between gap-2 rounded bg-[#181825] px-2.5 py-1.5 font-mono text-[11px] text-[#E4E4E7] overflow-x-auto">
                <span className="truncate">{PAIRING_TOKEN_COMMAND}</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(PAIRING_TOKEN_COMMAND);
                    setCopiedCommand(true);
                    window.setTimeout(() => setCopiedCommand(false), 1800);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-[#27273A] bg-[#11111B] px-2 py-1 text-[10px] font-sans text-[#F5F3FF] hover:border-[#A78BFA]"
                >
                  {copiedCommand ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copiedCommand ? "Copied" : "Copy Command"}
                </button>
              </div>
              <p>
                The command copies your token to the clipboard and displays it in the terminal. Return here and paste it into the Pairing Token field.
              </p>
              <p className="text-[#71717A]">
                If <code className="text-[#A1A1AA]">logs\worker_controller.token</code> is missing, install or start the local worker controller first (<code className="text-[#A1A1AA]">.\scripts\install_worker_controller.ps1</code>).
              </p>
            </div>
          </form>
        ) : controllerStatus ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#27273A] bg-[#09090F] p-3">
            <div className="space-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    controllerStatus.worker_running ? "bg-emerald-400" : "bg-zinc-500"
                  }`}
                />
                <span className="font-medium text-[#F5F3FF]">
                  Local Process:{" "}
                  {!controllerStatus.worker_running
                    ? "Stopped"
                    : controllerStatus.managed_by_controller
                      ? `Running (controller-managed${controllerStatus.pid ? `, PID: ${controllerStatus.pid}` : ""})`
                      : controllerStatus.pid
                        ? `Running (external, PID: ${controllerStatus.pid} — manageable by controller)`
                        : "Running (external)"}
                </span>
              </div>
              {controllerStatus.external_worker_detected && (
                <div className="text-amber-300">
                  Worker was started externally and can be stopped or restarted from here.
                </div>
              )}
              {controllerStatus.last_error && (
                <div className="text-red-300">Last error: {controllerStatus.last_error}</div>
              )}
              {actionNotice && <div className="text-emerald-300">{actionNotice}</div>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!controllerStatus.worker_running ? (
                <Button
                  size="sm"
                  onClick={() => void runAction("start")}
                  disabled={actionPending !== null}
                >
                  <Play className="h-3.5 w-3.5" />
                  {actionPending === "start" ? "Starting..." : "Start Worker"}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void runAction("stop")}
                    disabled={
                      actionPending !== null ||
                      (controllerStatus.external_worker_detected && controllerStatus.external_manageable === false)
                    }
                  >
                    <Square className="h-3.5 w-3.5" />
                    {actionPending === "stop" ? "Stopping..." : "Stop Worker"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runAction("restart")}
                    disabled={
                      actionPending !== null ||
                      (controllerStatus.external_worker_detected && controllerStatus.external_manageable === false)
                    }
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    {actionPending === "restart" ? "Restarting..." : "Restart Worker"}
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="text-xs text-[#A1A1AA]">Checking local controller...</div>
        )}

        {actionError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
