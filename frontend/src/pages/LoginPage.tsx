import { useState, type FormEvent } from "react";
import { Activity, ArrowRight, HeartPulse, LockKeyhole } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";
import { OfflineSessionExpiredError } from "../security/localVault";

export function LoginPage() {
  const { login, lockNotice, clearLockNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { browserOnline, apiUsable } = useConnectivityState();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notice = (location.state as { notice?: string } | null)?.notice;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    clearLockNotice();
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (reason) {
      if (reason instanceof OfflineSessionExpiredError) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "Sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  const networkLabel = !browserOnline
    ? "Offline · use your provisioned local account"
    : apiUsable
      ? "Network available"
      : "API unreachable · offline unlock available";

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <div className="login-brand">
          <span className="brand-mark">
            <HeartPulse size={23} aria-hidden="true" />
          </span>
          <span>
            <strong>SynCareX</strong>
            <small>Accurate records. Intelligent care.</small>
          </span>
        </div>
        <div className="login-story">
          <div className="eyebrow">
            <Activity size={15} aria-hidden="true" /> CLINICAL DOCUMENTATION
          </div>
          <h1>
            Care continues,
            <br />
            even offline.
          </h1>
          <p>
            Securely record and review clinical information across connected and
            low-connectivity environments.
          </p>
        </div>
        <div className="login-privacy">
          <LockKeyhole size={17} aria-hidden="true" />
          <span>
            Records are encrypted on this device and stay here until the server
            confirms each change.
          </span>
        </div>
      </section>
      <section className="login-form-panel">
        <div className="login-form-wrap">
          <span
            className={`login-network ${browserOnline && apiUsable ? "network-online" : "network-offline"}`}
          >
            <span />
            {networkLabel}
          </span>
          <h2>Welcome back</h2>
          <p className="login-subtitle">Sign in to your clinic workspace.</p>
          {lockNotice && (
            <div className="notice notice-warn" role="status">
              {lockNotice}
            </div>
          )}
          {notice && (
            <div className="notice notice-warn" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="email">
              Work email
            </label>
            <input
              autoComplete="username"
              id="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
            <label className="field-label" htmlFor="password">
              Password / local vault passphrase
            </label>
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
            <button
              className="button button-primary login-submit"
              disabled={busy}
              type="submit"
            >
              {busy
                ? "Unlocking workspace..."
                : browserOnline && apiUsable
                  ? "Sign in securely"
                  : "Unlock local workspace"}
              {!busy && <ArrowRight size={17} aria-hidden="true" />}
            </button>
          </form>
          <div className="login-disclaimer">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>
              Offline access requires a device that was authorized during an online
              sign-in, and it expires according to the clinic's offline session
              policy.
            </span>
          </div>
          <p className="login-safety">
            Development workspace · Never enter real patient information.
          </p>
        </div>
      </section>
    </main>
  );
}
