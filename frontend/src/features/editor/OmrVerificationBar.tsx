import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "@/services/api";
import type {
  OmrFinding,
  OmrVerificationReport,
  OmrVerificationStatusResponse,
  ProjectScoreResponse,
} from "@/types/api";

interface OmrVerificationBarProps {
  projectId: string;
  initialReport?: OmrVerificationReport | null;
  hasUnsavedChanges: boolean;
  isJobRunning: boolean;
  canReTranscribe: boolean;
  lastJobFailedOrCancelled: boolean;
  onReTranscribe: () => void;
  onScoreReplaced: (scoreResp: ProjectScoreResponse) => void;
}

function getBadgeToneClasses(score: number): string {
  if (score >= 90) {
    return "border-emerald-400/60 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200";
  }
  if (score >= 75) {
    return "border-amber-400/60 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200";
  }
  return "border-red-400/60 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200";
}

export function OmrVerificationBar({
  projectId,
  initialReport = null,
  hasUnsavedChanges,
  isJobRunning,
  canReTranscribe,
  lastJobFailedOrCancelled,
  onReTranscribe,
  onScoreReplaced,
}: OmrVerificationBarProps) {
  const [statusData, setStatusData] = useState<OmrVerificationStatusResponse | null>(() =>
    initialReport
      ? {
          verification: initialReport,
          gemini_configured: true,
          source_available: initialReport.source_available,
          source_message: initialReport.source_message ?? null,
          can_revert: initialReport.can_revert,
          can_restore_previous: false,
        }
      : null,
  );
  const [expanded, setExpanded] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [confirmRetranscribe, setConfirmRetranscribe] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const req = api.getOmrVerification?.(projectId);
    if (!req || typeof req.then !== "function") return;
    req
      .then((res) => {
        if (cancelled || !res) return;
        setStatusData(res);
      })
      .catch(() => {
        // Keep initialReport if verification fetch fails transiently
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const report = statusData?.verification ?? initialReport;

  const visibleFindings: OmrFinding[] = useMemo(() => {
    if (!report) return [];
    const appliedSet = new Set(report.applied_finding_ids || []);
    return (report.findings || []).filter(
      (f) => !dismissedIds.has(f.id) && !appliedSet.has(f.id),
    );
  }, [dismissedIds, report]);

  const fixableFindings = useMemo(
    () => visibleFindings.filter((f) => Boolean(f.proposed_fix)),
    [visibleFindings],
  );

  const handleRunVisionVerify = async () => {
    setActionError(null);
    setActionNotice(null);
    setIsVerifying(true);
    try {
      const res = await api.runOmrVisionVerify(projectId, Boolean(report?.ai_verified));
      setStatusData(res);
      setExpanded(true);
      const fixIds = (res.verification.findings || [])
        .filter((f) => Boolean(f.proposed_fix))
        .map((f) => f.id);
      setSelectedFindingIds(new Set(fixIds));
      if (res.verification.score_status === "ai_unavailable" || res.verification.score_status === "ai_failed") {
        setActionError(
          res.verification.ai_error ||
            "AI Vision verification is currently unavailable.",
        );
      } else if (res.verification.ai_verified) {
        setActionNotice(
          `AI Vision verified ${res.verification.findings.filter((f) => f.source === "ai_vision").length} finding(s). Review before applying.`,
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to run AI Vision verification.");
      setExpanded(true);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleApplySelected = async () => {
    const ids = Array.from(selectedFindingIds);
    if (ids.length === 0) return;
    setActionError(null);
    setActionNotice(null);
    setIsApplying(true);
    try {
      const res = await api.applyOmrFixes(projectId, ids);
      onScoreReplaced(res.score);
      setStatusData((prev) =>
        prev
          ? {
              ...prev,
              verification: res.verification,
              can_revert: true,
            }
          : {
              verification: res.verification,
              gemini_configured: true,
              source_available: res.verification.source_available,
              can_revert: true,
              can_restore_previous: false,
            },
      );
      setSelectedFindingIds(new Set());
      setActionNotice(
        `Applied ${res.applied_ids.length} correction(s) to the canonical score.${
          res.skipped_ids.length > 0 ? ` (${res.skipped_ids.length} skipped safely.)` : ""
        }`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed applying selected OMR fixes.");
    } finally {
      setIsApplying(false);
    }
  };

  const handleRevert = async () => {
    setActionError(null);
    setActionNotice(null);
    setIsReverting(true);
    try {
      const scoreResp = await api.revertOmrFixes(projectId);
      onScoreReplaced(scoreResp);
      const refreshed = await api.getOmrVerification(projectId);
      setStatusData(refreshed);
      setActionNotice("Reverted score to the original OMR result.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revert to original OMR.");
    } finally {
      setIsReverting(false);
    }
  };

  const handleRestorePrevious = async () => {
    setActionError(null);
    setActionNotice(null);
    setIsRestoring(true);
    try {
      const scoreResp = await api.restorePreviousScore(projectId);
      onScoreReplaced(scoreResp);
      const refreshed = await api.getOmrVerification(projectId);
      setStatusData(refreshed);
      setActionNotice("Restored previous score snapshot cleanly.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to restore previous score.");
    } finally {
      setIsRestoring(false);
    }
  };

  if (!report && !statusData) {
    return null;
  }

  const matchPct = report?.omr_match_score ?? 0;
  const aiVerified = Boolean(report?.ai_verified);
  const sourceAvailable = statusData?.source_available ?? report?.source_available ?? false;

  return (
    <div
      data-testid="omr-verification-bar"
      className="mt-2 rounded-lg border border-stone-200 bg-stone-50/90 px-3 py-2 text-xs text-stone-800 dark:border-[#27273A] dark:bg-[#0D0D16] dark:text-[#F5F3FF] space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="omr-match-badge"
            aria-expanded={expanded}
            title={report?.formula_note}
            onClick={() => setExpanded((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${getBadgeToneClasses(matchPct)}`}
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span>OMR Match: {matchPct}%</span>
            <span className="opacity-80 font-normal">
              ({aiVerified ? "AI Verified" : "Structural Check"})
            </span>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {!aiVerified && (
            <span
              data-testid="omr-not-verified-label"
              className="rounded-md border border-stone-300 bg-white px-2 py-0.5 text-[10px] font-medium text-stone-700 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#A1A1AA]"
            >
              Not Verified by AI Vision
            </span>
          )}

          {report && report.flagged_measures.length > 0 && (
            <span className="text-[11px] text-amber-800 dark:text-amber-300">
              Flagged measures: {report.flagged_measures.slice(0, 8).join(", ")}
              {report.flagged_measures.length > 8 ? ` (+${report.flagged_measures.length - 8})` : ""}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {lastJobFailedOrCancelled && statusData?.can_restore_previous && (
            <button
              type="button"
              data-testid="omr-restore-previous-btn"
              disabled={isRestoring}
              onClick={() => void handleRestorePrevious()}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-400 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200"
            >
              {isRestoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
              Restore Previous Score
            </button>
          )}

          <button
            type="button"
            data-testid="omr-retranscribe-btn"
            disabled={!canReTranscribe || isJobRunning}
            onClick={() => setConfirmRetranscribe((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 text-[11px] font-medium text-stone-800 hover:bg-stone-100 disabled:opacity-50 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-white/10"
          >
            <RefreshCw className={`h-3 w-3 ${isJobRunning ? "animate-spin" : ""}`} />
            Re-Transcribe
          </button>

          <button
            type="button"
            data-testid="omr-ai-verify-btn"
            disabled={isVerifying || isJobRunning}
            onClick={() => void handleRunVisionVerify()}
            title={
              !sourceAvailable
                ? report?.source_message || "Original sheet music file is unavailable in storage."
                : "Run Gemini Vision proofreader against original sheet music pages"
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-500 bg-violet-600 px-2.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {isVerifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {aiVerified ? "AI Vision Repair" : "AI Vision Verify"}
          </button>
        </div>
      </div>

      {confirmRetranscribe && (
        <div
          data-testid="omr-retranscribe-warning"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <span>
            Re-running Audiveris OMR will queue a new recognition pass over the original source file. Your previous score stays recoverable if the job fails.
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmRetranscribe(false)}
              className="rounded border border-stone-300 bg-white px-2 py-1 font-medium text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#181825] dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="omr-confirm-retranscribe-btn"
              disabled={isJobRunning}
              onClick={() => {
                setConfirmRetranscribe(false);
                onReTranscribe();
              }}
              className="rounded bg-amber-600 px-2 py-1 font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Confirm Re-Transcribe
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          data-testid="omr-verification-error"
          className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {actionNotice && (
        <div
          data-testid="omr-verification-notice"
          className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {expanded && report && (
        <div
          data-testid="omr-verification-details"
          className="space-y-2.5 border-t border-stone-200 pt-2.5 dark:border-[#27273A]"
        >
          <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
            <div className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 dark:border-[#27273A] dark:bg-[#11111B]">
              <div className="text-stone-500 dark:text-[#A1A1AA]">Rhythm Validity</div>
              <div className="font-mono font-semibold">
                {report.rhythm_validity_score}% ({report.valid_rhythm_measures}/{report.total_measures} bars)
              </div>
            </div>
            <div className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 dark:border-[#27273A] dark:bg-[#11111B]">
              <div className="text-stone-500 dark:text-[#A1A1AA]">Structural Consistency</div>
              <div className="font-mono font-semibold">{report.structural_consistency_score}%</div>
            </div>
            <div className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 dark:border-[#27273A] dark:bg-[#11111B]">
              <div className="text-stone-500 dark:text-[#A1A1AA]">AI Vision Confidence</div>
              <div className="font-mono font-semibold">
                {report.ai_verified && report.ai_confidence !== null
                  ? `${report.ai_confidence}%`
                  : "Not run"}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-stone-600 dark:text-[#A1A1AA]">
            {report.formula_note}
            {!sourceAvailable && report.source_message ? ` — ${report.source_message}` : ""}
          </p>

          {visibleFindings.length === 0 ? (
            <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
              No unresolved OMR structural or visual discrepancies flagged.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {visibleFindings.map((f) => {
                const hasFix = Boolean(f.proposed_fix);
                const checked = selectedFindingIds.has(f.id);
                return (
                  <div
                    key={f.id}
                    data-testid={`omr-finding-${f.id}`}
                    className="flex items-start justify-between gap-2 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[11px] dark:border-[#27273A] dark:bg-[#11111B]"
                  >
                    <label className="flex items-start gap-2 min-w-0 flex-1 cursor-pointer">
                      {hasFix && (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(selectedFindingIds);
                            if (e.target.checked) next.add(f.id);
                            else next.delete(f.id);
                            setSelectedFindingIds(next);
                          }}
                          className="mt-0.5 accent-violet-600"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] uppercase font-semibold ${
                              f.severity === "high"
                                ? "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200"
                                : f.severity === "medium"
                                  ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                                  : "bg-stone-100 text-stone-700 dark:bg-white/10 dark:text-slate-300"
                            }`}
                          >
                            {f.severity}
                          </span>
                          <span>m.{f.measure}</span>
                          {f.part_id && <span className="opacity-70">({f.part_id})</span>}
                          <span className="opacity-70">[{f.category}]</span>
                          {hasFix && (
                            <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] text-violet-800 dark:bg-violet-500/20 dark:text-violet-200">
                              Fix: {f.proposed_fix?.action}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-stone-700 dark:text-[#C4C4D4]">{f.description}</p>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setDismissedIds((prev) => new Set([...prev, f.id]));
                        setSelectedFindingIds((prev) => {
                          const next = new Set(prev);
                          next.delete(f.id);
                          return next;
                        });
                      }}
                      className="shrink-0 text-[10px] text-stone-500 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:text-white"
                    >
                      Dismiss
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="text-[11px] text-amber-700 dark:text-amber-300">
              {hasUnsavedChanges && fixableFindings.length > 0
                ? "Note: Save or review your manual edits before applying AI fixes."
                : ""}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {statusData?.can_revert && (
                <button
                  type="button"
                  data-testid="omr-revert-btn"
                  disabled={isReverting}
                  onClick={() => void handleRevert()}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 text-[11px] font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#C4C4D4]"
                >
                  {isReverting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  Revert to Original OMR
                </button>
              )}
              {fixableFindings.length > 0 && (
                <button
                  type="button"
                  data-testid="omr-apply-fixes-btn"
                  disabled={selectedFindingIds.size === 0 || isApplying}
                  onClick={() => void handleApplySelected()}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-3 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {isApplying && <Loader2 className="h-3 w-3 animate-spin" />}
                  Apply Selected Fixes ({selectedFindingIds.size})
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
