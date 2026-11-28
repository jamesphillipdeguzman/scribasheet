import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Link2Off,
  Loader2,
  Lock,
  RefreshCw,
  Share2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { SyncStatus } from "@/features/playlists/PlaylistContext";
import type { Playlist } from "@/features/playlists/playlistTypes";

interface PlaylistShareModalProps {
  playlist: Playlist | null;
  syncStatus: SyncStatus;
  onClose: () => void;
  onUpdateDescription: (playlistId: string, description: string) => void;
  onEnableSharing: (playlistId: string) => Promise<void>;
  onRegenerateSharing: (playlistId: string) => Promise<void>;
  onDisableSharing: (playlistId: string) => Promise<void>;
}

export function PlaylistShareModal({
  playlist,
  syncStatus,
  onClose,
  onUpdateDescription,
  onEnableSharing,
  onRegenerateSharing,
  onDisableSharing,
}: PlaylistShareModalProps) {
  const [busyAction, setBusyAction] = useState<"enable" | "regenerate" | "disable" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState(playlist?.description ?? "");

  useEffect(() => {
    setDescDraft(playlist?.description ?? "");
    setError(null);
    setCopied(false);
  }, [playlist?.id, playlist?.description]);

  if (!playlist) return null;

  const isShared = Boolean(playlist.isShared && playlist.shareToken);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareUrl = isShared && playlist.shareToken ? `${origin}/shared/playlist/${playlist.shareToken}` : "";
  const isLocalOnly = !playlist.serverId || syncStatus === "local" || syncStatus === "pending";

  const handleSaveDescription = () => {
    if (descDraft !== (playlist.description ?? "")) {
      onUpdateDescription(playlist.id, descDraft);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard?.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy automatically. Select and copy the link manually.");
    }
  };

  const runAction = async (
    kind: "enable" | "regenerate" | "disable",
    fn: (id: string) => Promise<void>,
  ) => {
    setError(null);
    handleSaveDescription();
    setBusyAction(kind);
    try {
      await fn(playlist.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update playlist sharing status.",
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${playlist.title}`}
      data-testid="playlist-share-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busyAction) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-stone-300 bg-white p-5 text-stone-900 shadow-2xl space-y-4 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="h-4 w-4 shrink-0 text-[#A78BFA]" />
            <h2 className="truncate text-base font-semibold">Share &ldquo;{playlist.title}&rdquo;</h2>
          </div>
          <span
            data-testid="share-status-pill"
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
              isShared
                ? "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300"
                : "border-stone-300 bg-stone-100 text-stone-700 dark:border-[#27273A] dark:bg-[#181825] dark:text-[#A1A1AA]"
            }`}
          >
            {isShared ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {isShared ? "Public Link" : "Private"}
          </span>
          <button
            type="button"
            aria-label="Close share dialog"
            onClick={onClose}
            className="rounded-lg p-1 text-stone-500 hover:bg-stone-100 dark:text-[#A1A1AA] dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-stone-600 dark:text-[#A1A1AA]">
          Give teachers or students read-only access to this playlist&apos;s track list, practice notes, loop timestamps, and YouTube references without requiring a ScribaSheet account. Private ScribaSheet project audio files remain private and are never exposed publicly.
        </p>

        {/* Optional Description for Teacher / Student View */}
        <div className="space-y-1">
          <label
            htmlFor="share-playlist-description"
            className="block text-xs font-medium text-stone-700 dark:text-[#A1A1AA]"
          >
            Notes / Description for Recipients
          </label>
          <textarea
            id="share-playlist-description"
            rows={2}
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={handleSaveDescription}
            placeholder="e.g., Week 4 lesson pieces — focus on shifting and vibrato at the marked sections."
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
          />
        </div>

        {!isShared && isLocalOnly && (
          <div
            data-testid="share-local-only-notice"
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            This playlist is currently local-only (not yet synced to persistent backend storage). Enabling sharing will first attempt to synchronize it to your ScribaSheet account so an authentic read-only link can be served.
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="share-modal-error"
            className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isShared ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                aria-label="Public playlist sharing URL"
                data-testid="public-share-url-input"
                onClick={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-lg border border-stone-300 bg-stone-50 px-3 font-mono text-xs text-stone-900 focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleCopy()}
                data-testid="copy-share-link-btn"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy Link"}
              </Button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-stone-300 px-2.5 text-xs font-medium text-stone-800 hover:bg-stone-100 dark:border-[#27273A] dark:text-[#F5F3FF] dark:hover:bg-white/10"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Preview Link
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busyAction !== null}
                  data-testid="regenerate-share-link-btn"
                  onClick={() => void runAction("regenerate", onRegenerateSharing)}
                  title="Creates a fresh random URL and immediately invalidates the old link"
                >
                  {busyAction === "regenerate" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Regenerate Link
                </Button>
              </div>

              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={busyAction !== null}
                data-testid="disable-sharing-btn"
                onClick={() => void runAction("disable", onDisableSharing)}
              >
                {busyAction === "disable" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link2Off className="h-3.5 w-3.5" />
                )}
                Disable Sharing
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busyAction !== null}
              data-testid="enable-sharing-btn"
              onClick={() => void runAction("enable", onEnableSharing)}
            >
              {busyAction === "enable" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Globe className="h-3.5 w-3.5" />
              )}
              {isLocalOnly ? "Sync & Generate Public Link" : "Generate Public Link"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
