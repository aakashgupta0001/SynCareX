import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  Download,
  HardDrive,
  KeyRound,
  Laptop,
  LockKeyhole,
  Share2,
  ShieldCheck,
  Smartphone,
  Upload,
  Users,
} from "lucide-react";
import { ErrorState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import { getDeviceRecord, getLocalDeviceId } from "../offline/device";
import {
  formatBytes,
  inspectStorage,
  requestPersistentStorage,
  type StorageReport,
} from "../offline/storage";
import { exportLocalBackup, importLocalBackup } from "../offline/backup";
import { useAuth } from "../services/auth";
import { api, type ClinicMemberResponse } from "../services/api";
import { currentKeyEpoch } from "../security/clinicKey";
import { wrapForRecipient } from "../security/identityKey";
import { useConnectivityState } from "../hooks/useConnectivity";
import type { LocalDevice } from "../database/types";

export function SettingsPage() {
  const { session, logout } = useAuth();
  const connectivity = useConnectivityState();
  const [deviceId, setDeviceId] = useState("");
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const canManageUsers = session?.permissions.includes("users.manage") ?? false;
  const [members, setMembers] = useState<ClinicMemberResponse[] | null>(null);

  const loadMembers = useCallback(async () => {
    if (!canManageUsers) return;
    try {
      setMembers(await api.getClinicMembers());
    } catch (reason) {
      setMembers([]);
      setError(
        reason instanceof Error
          ? reason.message
          : "The clinic members could not be listed.",
      );
    }
  }, [canManageUsers]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  async function shareClinicKey(member: ClinicMemberResponse) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const identity = await api.getIdentityKey(member.id);
      const wrap = await wrapForRecipient(identity.public_key);
      if (!wrap) {
        throw new Error(
          "The clinic key is not unlocked on this device, so it cannot be shared. " +
            "Unlock it (sign in with the passphrase that holds the clinic key) and try again.",
        );
      }
      await api.publishClinicKeyWraps([
        {
          user_id: member.id,
          key_epoch: currentKeyEpoch() ?? 1,
          wrapped_key: wrap.wrapped_key,
          wrap_iv: wrap.wrap_iv,
          wrap_type: "identity",
          ephemeral_public_key: wrap.ephemeral_public_key,
        },
      ]);
      setMessage(
        `Shared the clinic key with ${member.full_name || member.email}. They will receive it the next time this device synchronizes.`,
      );
      await loadMembers();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `The clinic key could not be shared with ${member.full_name || member.email}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const [id, record, report] = await Promise.all([
        getLocalDeviceId(),
        getDeviceRecord(),
        inspectStorage(),
      ]);
      setDeviceId(id);
      setDevice(record);
      setStorage(report);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The device settings could not be read.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestPersistence() {
    setBusy(true);
    const granted = await requestPersistentStorage();
    await load();
    setMessage(
      granted
        ? "This browser will keep SynCareX data out of automatic eviction."
        : "The browser did not grant persistent storage. Data may be evicted under storage pressure; synchronize regularly.",
    );
    setBusy(false);
  }

  async function restoreBackup() {
    const file = restoreFileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a SynCareX backup file to restore first.");
      return;
    }
    if (!restorePassphrase) {
      setError("Enter the vault passphrase the backup was encrypted with.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error("The selected file is not valid JSON and cannot be a SynCareX backup.");
      }
      const result = await importLocalBackup(payload, restorePassphrase);
      const details = Object.entries(result.tables)
        .filter(([, summary]) => summary.imported > 0)
        .map(([name, summary]) => `${name}: ${summary.imported}`)
        .join(", ");
      setMessage(
        `Restored ${result.imported} record(s); ${result.skipped} newer local record(s) kept as-is.${details ? ` Imported into ${details}.` : ""}`,
      );
      setRestorePassphrase("");
      if (restoreFileRef.current) restoreFileRef.current.value = "";
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The backup could not be restored.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportBackup() {
    setBusy(true);
    setError("");
    try {
      const result = await exportLocalBackup();
      setMessage(
        `Exported ${result.recordCount} encrypted record(s) to ${result.fileName}. The export stays encrypted with this vault's key.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The backup could not be exported.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="DEVICE & PRIVACY"
        title="Settings"
        description="What this browser stores, how long offline access lasts, and how to take a backup."
      />
      {error && <ErrorState>{error}</ErrorState>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      <section className="content-card settings-card">
        <div className="section-heading">
          <div>
            <h2>Account session</h2>
            <p>Session details for this workspace.</p>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <KeyRound size={18} />
          </span>
          <span>
            <strong>{session?.user.full_name}</strong>
            <small>
              {session?.user.email} ·{" "}
              {session?.user.roles.map((role) => role.name).join(", ") ||
                "No cached role assignment"}
            </small>
          </span>
          <span
            className={`settings-value ${session?.mode === "online" ? "text-positive" : "text-warning"}`}
          >
            {session?.mode === "online" ? "Server authenticated" : "Offline session"}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <LockKeyhole size={18} />
          </span>
          <span>
            <strong>Offline session expiry</strong>
            <small>
              Offline access continues an online sign-in; it is not a separate way in.
            </small>
          </span>
          <span className="settings-value">
            {session?.offlineSessionExpiresAt
              ? new Date(session.offlineSessionExpiresAt).toLocaleString()
              : "Not provisioned"}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <ShieldCheck size={18} />
          </span>
          <span>
            <strong>Connectivity</strong>
            <small>
              {connectivity.lastHealthCheckAt
                ? `Last API check ${new Date(connectivity.lastHealthCheckAt).toLocaleTimeString()}`
                : "The API has not been checked yet."}
            </small>
          </span>
          <span
            className={`settings-value ${connectivity.apiUsable ? "text-positive" : "text-warning"}`}
          >
            {connectivity.apiUsable ? "API reachable" : "API unreachable"}
          </span>
        </div>
      </section>

      {canManageUsers && (
        <section className="content-card settings-card">
          <div className="section-heading">
            <div>
              <h2>Share clinic key</h2>
              <p>
                Seal this clinic's encryption key to a colleague's identity key.
                Their passphrase is never needed and never seen.
              </p>
            </div>
            <span className="settings-icon">
              <Share2 size={18} />
            </span>
          </div>
          {(members ?? []).length === 0 && (
            <div className="settings-row">
              <span className="settings-icon">
                <Users size={18} />
              </span>
              <span>
                <strong>No clinic members to share with</strong>
                <small>
                  {members === null
                    ? "Loading clinic members…"
                    : "The server returned no other members for this clinic."}
                </small>
              </span>
            </div>
          )}
          {(members ?? []).map((member) => (
            <div className="settings-row" key={member.id}>
              <span className="settings-icon">
                <Users size={18} />
              </span>
              <span>
                <strong>{member.full_name || member.email}</strong>
                <small>
                  {member.holds_clinic_key
                    ? "Already holds the clinic key"
                    : "No clinic key yet"}
                  {" · "}
                  {member.has_identity_key
                    ? "Identity key published"
                    : "No identity key published"}
                </small>
              </span>
              {!member.holds_clinic_key &&
              member.has_identity_key &&
              member.id !== session?.user.id ? (
                <button
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => void shareClinicKey(member)}
                  type="button"
                >
                  Share key
                </button>
              ) : (
                <span className="settings-value">
                  {member.id === session?.user.id ? "You" : "—"}
                </span>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="content-card settings-card">
        <div className="section-heading">
          <div>
            <h2>This device</h2>
            <p>Device authorization and local encryption.</p>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <Laptop size={18} />
          </span>
          <span>
            <strong>Device identifier</strong>
            <small>Stored in IndexedDB. It is an identifier, not a credential.</small>
          </span>
          <code className="device-code">{deviceId || "Loading…"}</code>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <Smartphone size={18} />
          </span>
          <span>
            <strong>Server authorization</strong>
            <small>
              {device?.lastServerContactAt
                ? `Last server contact ${new Date(device.lastServerContactAt).toLocaleString()}`
                : "This device has not reached the server yet."}
            </small>
          </span>
          <span
            className={`settings-value ${device?.status === "authorized" ? "text-positive" : "text-warning"}`}
          >
            {device?.status ?? "unprovisioned"}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <LockKeyhole size={18} />
          </span>
          <span>
            <strong>Local record encryption</strong>
            <small>
              AES-GCM 256-bit. The key is derived with PBKDF2-SHA-256 from your
              sign-in secret and only ever exists in memory while unlocked.
            </small>
          </span>
          <span className="settings-value text-positive">Enabled</span>
        </div>
      </section>

      <section className="content-card settings-card">
        <div className="section-heading">
          <div>
            <h2>Browser storage</h2>
            <p>
              What this browser can keep offline. IndexedDB is not encrypted by the
              browser; SynCareX encrypts each record before storing it.
            </p>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <Database size={18} />
          </span>
          <span>
            <strong>Quota</strong>
            <small>
              {storage
                ? `${formatBytes(storage.usageBytes)} used of ${formatBytes(storage.quotaBytes)}`
                : "Reading storage estimate…"}
            </small>
          </span>
          <span className="settings-value">
            {storage?.documentHeadroomBytes !== undefined
              ? `${formatBytes(storage?.documentHeadroomBytes ?? null)} for documents`
              : "Unknown"}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <HardDrive size={18} />
          </span>
          <span>
            <strong>Persistent storage</strong>
            <small>
              Without it, the browser may evict stored records when the device runs
              low on space.
            </small>
          </span>
          {storage?.persisted ? (
            <span className="settings-value text-positive">Granted</span>
          ) : (
            <button
              className="button button-quiet"
              disabled={busy || !storage?.persistentStorageSupported}
              onClick={() => void requestPersistence()}
              type="button"
            >
              Request persistence
            </button>
          )}
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <Download size={18} />
          </span>
          <span>
            <strong>Encrypted backup</strong>
            <small>
              Exports every local record as encrypted envelopes. It can only be read
              by this vault's passphrase.
            </small>
          </span>
          <button
            className="button button-quiet"
            disabled={busy}
            onClick={() => void exportBackup()}
            type="button"
          >
            Export backup
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-icon">
            <Upload size={18} />
          </span>
          <span>
            <strong>Restore backup</strong>
            <small>
              Merges an exported backup back into this device. Records that are newer here are
              kept, and the file's passphrase must match this vault.
            </small>
          </span>
          <span className="restore-controls">
            <input
              accept="application/json,.json"
              aria-label="Backup file"
              disabled={busy}
              onChange={() => setError("")}
              ref={restoreFileRef}
              type="file"
            />
            <input
              aria-label="Vault passphrase"
              autoComplete="current-password"
              disabled={busy}
              onChange={(event) => setRestorePassphrase(event.target.value)}
              placeholder="Vault passphrase"
              type="password"
              value={restorePassphrase}
            />
            <button
              className="button button-quiet"
              disabled={busy}
              onClick={() => void restoreBackup()}
              type="button"
            >
              Restore
            </button>
          </span>
        </div>
      </section>

      <div className="danger-row">
        <div>
          <strong>Remove offline authorization</strong>
          <p>
            Signs out and ends this device's offline session. Encrypted records stay
            on the device and become readable again after the next online sign-in.
          </p>
        </div>
        <button
          className="button button-quiet"
          onClick={() => void logout({ forgetDevice: true })}
          type="button"
        >
          Sign out and forget device
        </button>
      </div>

      <div className="notice notice-warn">
        Unlocking the local vault proves possession of this device and the vault
        passphrase. It is not server authentication, and it cannot grant permissions
        the server has not already issued to this account.
      </div>
    </>
  );
}
