import { useEffect, useState } from "react";
import {
  getConnectivityState,
  isApiUsable,
  probeApi,
  startConnectivityMonitor,
  subscribeConnectivity,
  type ConnectivityState,
} from "../services/connectivity";

/**
 * Full connectivity picture: the browser's own flag, whether the API
 * actually answered, and when synchronization last succeeded.
 */
export function useConnectivityState(): ConnectivityState & {
  apiUsable: boolean;
  refresh: () => Promise<boolean>;
} {
  const [state, setState] = useState<ConnectivityState>(getConnectivityState);

  useEffect(() => {
    const stop = startConnectivityMonitor();
    const unsubscribe = subscribeConnectivity(setState);
    return () => {
      unsubscribe();
      stop();
    };
  }, []);

  return { ...state, apiUsable: isApiUsable(state), refresh: probeApi };
}

/** Browser-level online flag only. Never treat it as API availability. */
export function useConnectivity(): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return isOnline;
}
