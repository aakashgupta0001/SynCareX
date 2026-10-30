import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, api, setAccessToken, type AuthUser } from "./api";
import {
  DEFAULT_OFFLINE_GRACE_DAYS,
  OfflineSessionExpiredError,
  initializeOrUnlockVault,
  invalidateLocalSession,
  lockLocalVault,
  unlockLocalVault,
  type VaultIdentity,
} from "../security/localVault";
import { getLocalDeviceId, markDeviceAuthorized } from "../offline/device";
import { auditRepository } from "../repositories/auditRepository";
import { lockClinicKey, unlockClinicKey } from "../security/clinicKey";
import { patientRepository } from "../repositories/patientRepository";
import { requestPersistentStorage } from "../offline/storage";

export type SessionMode = "online" | "offline";

/** Idle time before the workspace locks itself and drops the vault key. */
export const AUTO_LOCK_MS = 15 * 60 * 1000;

export interface Session {
  user: AuthUser;
  mode: SessionMode;
  permissions: string[];
  offlineSessionExpiresAt: string | null;
  deviceProvisioned: boolean;
}

interface LoginResult {
  mode: SessionMode;
  warning: string | null;
}

interface AuthContextValue {
  session: Session | null;
  /** Reason the previous session ended, shown on the sign-in screen. */
  lockNotice: string | null;
  /**
   * Email of a server session restored via the refresh cookie on page load.
   * The vault still needs its passphrase, so the sign-in screen pre-fills
   * this email and only asks for the passphrase.
   */
  restoredEmail: string | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: (options?: { forgetDevice?: boolean }) => Promise<string | null>;
  lockNow: (reason?: string) => void;
  clearLockNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function localUser(identity: VaultIdentity): AuthUser {
  return {
    id: identity.userId,
    clinic_id: "",
    email: identity.email,
    full_name: identity.fullName,
    roles: identity.roles.map((name) => ({ name, permissions: identity.permissions })),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const emailRef = useRef<string | null>(null);

  const lockNow = useCallback((reason?: string) => {
    setAccessToken(null);
    lockLocalVault();
    lockClinicKey();
    setSession(null);
    setLockNotice(
      reason ??
        "The workspace locked itself after a period of inactivity. Records stay encrypted on this device.",
    );
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    let apiError: ApiError | null = null;
    let warning: string | null = null;

    if (navigator.onLine) {
      try {
        const result = await api.login(email, password);
        const user = result.user;
        const permissions = [
          ...new Set(user.roles.flatMap((role) => role.permissions)),
        ];

        // Authorize this browser for offline work first, so the vault can
        // record the grace period the server actually granted.
        let deviceProvisioned = false;
        let graceDays = DEFAULT_OFFLINE_GRACE_DAYS;
        try {
          const deviceId = await getLocalDeviceId();
          const provisioned = await api.provisionDevice(deviceId, "Clinic browser");
          await markDeviceAuthorized({
            serverDeviceId: provisioned.server_device_id,
            actorId: user.id,
            offlineGraceDays: provisioned.offline_grace_days,
          });
          graceDays = provisioned.offline_grace_days;
          deviceProvisioned = true;
        } catch (error) {
          warning =
            error instanceof Error
              ? `Signed in, but this device could not be authorized for offline synchronization: ${error.message}`
              : "Signed in, but this device could not be authorized for offline synchronization.";
        }

        let offlineSessionExpiresAt: string | null = null;
        try {
          const identity = await initializeOrUnlockVault(
            {
              id: user.id,
              email: user.email,
              fullName: user.full_name,
              roles: user.roles.map((role) => role.name),
              permissions,
            },
            password,
            { offlineGraceDays: graceDays },
          );
          offlineSessionExpiresAt = identity.offlineSessionExpiresAt;
        } catch (error) {
          setAccessToken(null);
          try {
            await api.logout();
          } catch (logoutError) {
            const reason =
              logoutError instanceof Error
                ? logoutError.message
                : "the server session could not be revoked";
            throw new Error(
              `${error instanceof Error ? error.message : "Local vault unlock failed."} Server logout also failed: ${reason}`,
            );
          }
          throw error;
        }

        void requestPersistentStorage();

        const clinicKey = await unlockClinicKey(password, {
          online: true,
          clinicId: user.clinic_id,
          userId: user.id,
        });
        if (!clinicKey.available && clinicKey.reason) {
          warning = warning ? `${warning} ${clinicKey.reason}` : clinicKey.reason;
        }
        if (clinicKey.available) {
          // The key just became usable on this device: records that were
          // synchronized before it arrived have no keyed search terms on the
          // server, and keyed-only search would miss them. The backfill
          // queues one content-identical update per local patient; failures
          // are non-fatal (the durable queue retries, and the plaintext
          // union still covers search meanwhile).
          patientRepository
            .enqueueSearchTermBackfill()
            .catch(() => undefined);
        }

        emailRef.current = user.email;
        setLockNotice(null);
        setSession({
          user,
          mode: "online",
          permissions,
          offlineSessionExpiresAt,
          deviceProvisioned,
        });
        await auditRepository.record({
          action: "auth.login.online",
          entityType: "session",
          entityId: null,
        });
        return { mode: "online" as SessionMode, warning };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 0) throw error;
        apiError = error;
      }
    }

    try {
      const identity = await unlockLocalVault(email, password);
      setAccessToken(null);
      await unlockClinicKey(password, {
        online: false,
        clinicId: "",
        userId: identity.userId,
      });
      emailRef.current = identity.email;
      setLockNotice(null);
      setSession({
        user: localUser(identity),
        mode: "offline",
        permissions: identity.permissions,
        offlineSessionExpiresAt: identity.offlineSessionExpiresAt,
        deviceProvisioned: true,
      });
      await auditRepository.record({
        action: "auth.unlock.offline",
        entityType: "session",
        entityId: null,
      });
      return {
        mode: "offline" as SessionMode,
        warning:
          apiError &&
          "Working offline: the server is unreachable, so changes are queued on this device.",
      } as LoginResult;
    } catch (error) {
      if (error instanceof OfflineSessionExpiredError) throw error;
      if (apiError) {
        throw new Error(
          `${apiError.message} ${error instanceof Error ? error.message : ""}`.trim(),
        );
      }
      throw error;
    }
  }, []);

  const logout = useCallback(
    async (options: { forgetDevice?: boolean } = {}) => {
      let warning: string | null = null;
      try {
        if (navigator.onLine) await api.logout();
        else warning = "Offline: the server refresh session could not be revoked yet.";
      } catch (error) {
        warning =
          error instanceof Error
            ? `Signed out locally, but server logout failed: ${error.message}`
            : "Signed out locally, but server logout failed.";
      } finally {
        await auditRepository.record({
          action: options.forgetDevice ? "auth.logout.forget_device" : "auth.logout",
          entityType: "session",
          entityId: null,
        });
        if (options.forgetDevice && emailRef.current) {
          await invalidateLocalSession(emailRef.current);
          warning =
            "Signed out and removed this device's offline authorization. Encrypted records stay on the device but cannot be opened until the next online sign-in.";
        }
        setAccessToken(null);
        lockLocalVault();
        lockClinicKey();
        setSession(null);
        setLockNotice(null);
        emailRef.current = null;
      }
      return warning;
    },
    [],
  );

  // Automatic session locking. The vault key only ever lives in memory, so
  // locking is enough to make stored records unreadable again.
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lockNow(), AUTO_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "focus"];
    for (const event of events) window.addEventListener(event, reset);
    document.addEventListener("visibilitychange", reset);
    reset();
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [session, lockNow]);

  // An offline session that expires while the workspace is open is ended at
  // the moment it expires, not on the next sign-in.
  useEffect(() => {
    if (!session?.offlineSessionExpiresAt) return;
    const remaining = Date.parse(session.offlineSessionExpiresAt) - Date.now();
    if (remaining <= 0) {
      lockNow(
        "This device's offline session has expired. Reconnect and sign in to the server to continue. Records already saved on this device are preserved.",
      );
      return;
    }
    const timer = setTimeout(
      () =>
        lockNow(
          "This device's offline session has expired. Reconnect and sign in to the server to continue. Records already saved on this device are preserved.",
        ),
      Math.min(remaining, 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [session?.offlineSessionExpiresAt, lockNow]);

  // A page reload drops the in-memory access token and locks the vault, but
  // the refresh cookie survives. Restoring the server session here keeps the
  // user's identity instead of presenting a cold login form after every
  // refresh. The vault passphrase is still required: it is the only thing
  // that can decrypt the local vault, and it deliberately never persists.
  const [restoredEmail, setRestoredEmail] = useState<string | null>(null);
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    api
      .restoreSession()
      .then((restored) => {
        if (!cancelled && restored) setRestoredEmail(restored.user.email);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session]);

  const value = useMemo(
    () => ({
      session,
      lockNotice,
      restoredEmail,
      login,
      logout,
      lockNow,
      clearLockNotice: () => setLockNotice(null),
    }),
    [session, lockNotice, restoredEmail, login, logout, lockNow],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
