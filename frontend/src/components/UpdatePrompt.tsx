import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

/**
 * Shows a new application version only as an offer. The update is applied
 * when the clinician accepts, so an in-progress form is never reloaded away.
 * Updating replaces cached code only; IndexedDB records are untouched.
 */
export function UpdatePrompt() {
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [apply, setApply] = useState<(() => Promise<void>) | null>(null);
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void import("virtual:pwa-register")
      .then(({ registerSW }) => {
        const update = registerSW({
          immediate: true,
          onNeedRefresh() {
            if (!cancelled) setNeedsRefresh(true);
          },
          onOfflineReady() {
            if (!cancelled) setOfflineReady(true);
          },
        });
        if (!cancelled) setApply(() => () => update(true));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!offlineReady) return;
    const timer = setTimeout(() => setOfflineReady(false), 6000);
    return () => clearTimeout(timer);
  }, [offlineReady]);

  if (!needsRefresh && !offlineReady) return null;

  return (
    <div className="app-toast" role="status" aria-live="polite">
      {needsRefresh ? (
        <>
          <RefreshCw size={17} aria-hidden="true" />
          <div>
            <strong>A new version of SynCareX is ready</strong>
            <span>
              Your saved records and queued changes are not affected by the update.
            </span>
          </div>
          <button
            className="button button-primary"
            onClick={() => void apply?.()}
            type="button"
          >
            Reload now
          </button>
          <button
            aria-label="Dismiss update notice"
            className="toast-close"
            onClick={() => setNeedsRefresh(false)}
            type="button"
          >
            <X size={16} />
          </button>
        </>
      ) : (
        <>
          <RefreshCw size={17} aria-hidden="true" />
          <div>
            <strong>Ready to work offline</strong>
            <span>The workspace has been stored on this device.</span>
          </div>
        </>
      )}
    </div>
  );
}
