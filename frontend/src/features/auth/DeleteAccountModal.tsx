import React, { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ApiError } from "@/services/api";

interface DeleteAccountModalProps {
  isOpen: boolean;
  userEmail?: string | null;
  onClose: () => void;
  onConfirmDelete: () => Promise<void>;
  restoreFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

export function DeleteAccountModal({
  isOpen,
  userEmail,
  onClose,
  onConfirmDelete,
  restoreFocusRef,
}: DeleteAccountModalProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const descriptionId = useId();
  const confirmInputId = useId();
  const checkboxId = useId();

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const wasOpenRef = useRef(false);

  const trimmedEmail = typeof userEmail === "string" ? userEmail.trim() : "";
  const hasEmail = trimmedEmail.length > 0;
  const expectedConfirmation = hasEmail ? trimmedEmail : "DELETE";
  const isConfirmationMatch = typedConfirmation === expectedConfirmation;
  const canSubmit = acknowledged && isConfirmationMatch && !isDeleting;

  useEffect(() => {
    if (isOpen) {
      setAcknowledged(false);
      setTypedConfirmation("");
      setIsDeleting(false);
      setError(null);
      submittingRef.current = false;
      wasOpenRef.current = true;

      const timer = window.setTimeout(() => {
        checkboxRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      restoreFocusRef?.current?.focus();
    }
    return undefined;
  }, [isOpen, restoreFocusRef]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!isDeleting && !submittingRef.current) {
          event.preventDefault();
          onClose();
        }
        return;
      }

      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isDeleting, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleClose = () => {
    if (isDeleting || submittingRef.current) return;
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Revalidate both conditions and guard against duplicate in-flight submissions
    if (submittingRef.current || isDeleting || !acknowledged || typedConfirmation !== expectedConfirmation) {
      return;
    }

    submittingRef.current = true;
    setIsDeleting(true);
    setError(null);

    try {
      await onConfirmDelete();
    } catch (err) {
      const msg =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Unable to delete your account right now. Please try again.";
      setError(msg || "Unable to delete your account right now. Please try again.");
      setIsDeleting(false);
      submittingRef.current = false;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="delete-account-modal"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-stone-200 bg-white text-stone-900 shadow-2xl dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
      >
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-700 border border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id={titleId} className="text-lg font-semibold leading-tight">
                  Delete Account Permanently
                </h2>
                <p className="text-xs font-medium text-red-700 dark:text-red-300 mt-0.5">
                  Permanent &amp; irreversible action
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClose}
              disabled={isDeleting}
              aria-label="Close modal"
              className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 transition-colors disabled:opacity-40 disabled:pointer-events-none dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div id={descriptionId} className="space-y-3 text-sm text-stone-700 dark:text-[#D4D4D8]">
            <p>
              Deleting your ScribaSheet account is <strong>permanent and irreversible</strong>. Once completed, your
              account cannot be recovered and the following data will be permanently erased:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-stone-700 dark:text-[#D4D4D8]">
              <li>All projects</li>
              <li>Sheet music scores</li>
              <li>Uploaded audio recordings</li>
              <li>Exported files</li>
            </ul>
          </div>

          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3.5 dark:border-[#27273A] dark:bg-[#09090F]">
            <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer select-none">
              <input
                ref={checkboxRef}
                id={checkboxId}
                type="checkbox"
                checked={acknowledged}
                disabled={isDeleting}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-stone-300 text-red-600 focus:ring-red-500 dark:border-[#3F3F5C] dark:bg-[#181825]"
              />
              <span className="text-xs font-medium leading-relaxed text-stone-800 dark:text-[#F5F3FF]">
                I understand this action is permanent and cannot be undone.
              </span>
            </label>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={confirmInputId} className="block text-xs font-medium text-stone-700 dark:text-[#A1A1AA]">
              {hasEmail ? (
                <>
                  To confirm, type your exact account email:{" "}
                  <span className="font-mono font-semibold text-stone-900 dark:text-[#F5F3FF] break-all">
                    {expectedConfirmation}
                  </span>
                </>
              ) : (
                <>
                  To confirm, type{" "}
                  <span className="font-mono font-semibold text-stone-900 dark:text-[#F5F3FF]">DELETE</span>
                </>
              )}
            </label>
            <input
              id={confirmInputId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={isDeleting}
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              placeholder={hasEmail ? expectedConfirmation : "DELETE"}
              className="flex h-10 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-50 dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={handleClose}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="confirm-permanent-delete-btn"
              className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-red-600 px-4 h-10 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 dark:bg-red-600 dark:hover:bg-red-700 dark:disabled:bg-[#27273A] dark:disabled:text-[#71717A]"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Deleting Account...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Permanently Delete Account
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
