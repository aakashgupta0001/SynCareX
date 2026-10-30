import { CloudOff, ServerCrash, Wifi, WifiOff } from "lucide-react";
import { useConnectivityState } from "../hooks/useConnectivity";

/**
 * Persistent connectivity indicator. It distinguishes "this device has a
 * network" from "the SynCareX API answered", because only the second one
 * makes synchronization possible.
 */
export function ConnectivityIndicator() {
  const { browserOnline, apiReachable, checking, apiUsable } = useConnectivityState();

  const { tone, Icon, label, title } = !browserOnline
    ? {
        tone: "offline",
        Icon: WifiOff,
        label: "Offline",
        title: "No network connection. Work is saved on this device and queued.",
      }
    : apiReachable === null || checking
      ? {
          tone: "checking",
          Icon: Wifi,
          label: "Checking",
          title: "Checking whether the SynCareX API is reachable.",
        }
      : apiUsable
        ? {
            tone: "online",
            Icon: Wifi,
            label: "Online",
            title: "The SynCareX API answered. Queued changes can be synchronized.",
          }
        : {
            tone: "degraded",
            Icon: ServerCrash,
            label: "API unreachable",
            title:
              "This device has a network, but the SynCareX API did not answer. Changes stay queued.",
          };

  return (
    <span
      aria-live="polite"
      className={`connection connection-${tone}`}
      role="status"
      title={title}
    >
      <Icon aria-hidden="true" size={15} />
      {label}
    </span>
  );
}

/** Compact variant used inside cards. */
export function OfflineChip() {
  const { apiUsable } = useConnectivityState();
  if (apiUsable) return null;
  return (
    <span className="offline-chip">
      <CloudOff aria-hidden="true" size={14} /> Working offline
    </span>
  );
}
