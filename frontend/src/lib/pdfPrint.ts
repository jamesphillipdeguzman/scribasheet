export interface PrintPdfOptions {
  /** Delay after iframe load before invoking print() so the PDF plugin initializes. */
  settleDelayMs?: number;
  /** Fallback cleanup delay if afterprint does not fire. */
  cleanupTimeoutMs?: number;
}

/**
 * Print a generated PDF Blob via a hidden iframe using the browser's native print dialog.
 * Falls back to opening the PDF Blob in a new tab if iframe printing is blocked.
 * Never falls back to printing the host application webpage.
 */
export async function printScorePdf(pdfBlob: Blob, options: PrintPdfOptions = {}): Promise<void> {
  if (!(pdfBlob instanceof Blob) || pdfBlob.size === 0) {
    throw new Error("Generated PDF is empty or invalid.");
  }
  if (pdfBlob.type && pdfBlob.type !== "application/pdf") {
    throw new Error(`Expected a PDF document, but received "${pdfBlob.type}".`);
  }

  const settleDelayMs = options.settleDelayMs ?? 150;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 60_000;
  const url = URL.createObjectURL(pdfBlob);

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("data-testid", "pdf-print-iframe");

  let cleanedUp = false;
  let fallbackTimer: number | null = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    iframe.remove();
    URL.revokeObjectURL(url);
  };

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const triggerPrint = () => {
      if (settled) return;
      settled = true;
      window.setTimeout(() => {
        try {
          const win = iframe.contentWindow;
          if (!win || typeof win.print !== "function") {
            throw new Error("Embedded PDF printing is unavailable in this browser.");
          }
          win.addEventListener("afterprint", cleanup, { once: true });
          window.addEventListener("afterprint", cleanup, { once: true });
          fallbackTimer = window.setTimeout(cleanup, cleanupTimeoutMs);
          win.focus();
          win.print();
          resolve();
        } catch {
          // Fallback: open the generated PDF Blob in a separate tab so the user can print it there
          const tab = window.open(url, "_blank", "noopener,noreferrer");
          if (tab) {
            fallbackTimer = window.setTimeout(cleanup, cleanupTimeoutMs);
            resolve();
          } else {
            cleanup();
            reject(
              new Error(
                "Unable to open the browser print dialog. Please allow pop-ups or use Download PDF.",
              ),
            );
          }
        }
      }, settleDelayMs);
    };

    iframe.onload = triggerPrint;
    iframe.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Failed to load the generated PDF for printing."));
    };

    // Safety fallback if a browser's PDF viewer does not fire iframe.onload
    const loadTimeout = window.setTimeout(() => {
      if (!settled) {
        triggerPrint();
      }
    }, 3000);

    iframe.addEventListener(
      "load",
      () => {
        window.clearTimeout(loadTimeout);
      },
      { once: true },
    );

    iframe.src = url;
    document.body.appendChild(iframe);
  });
}
