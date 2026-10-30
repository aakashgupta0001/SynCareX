import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ClipboardPlus,
  HeartPulse,
  LogOut,
  Pill,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  portalClient,
  getPortalAccessToken,
  type PortalSummary,
} from "../services/portal";
import { ApiError } from "../services/api";

type PortalView = "enroll" | "login" | "dashboard";

const READ_ONLY_NOTE =
  "This is a read-only summary of your record. Keep your emergency passport token for emergencies.";

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ageDescription(
  dateOfBirth: string | null,
  estimatedAge: number | null,
): string {
  if (dateOfBirth) {
    const date = new Date(dateOfBirth);
    return Number.isNaN(date.getTime())
      ? dateOfBirth
      : date.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  }
  if (estimatedAge !== null && estimatedAge !== undefined) {
    return `About ${estimatedAge} years old (estimated)`;
  }
  return "Age not recorded";
}

/** True when a login failure looks like "this email has no portal account". */
function looksNotEnrolled(message: string): boolean {
  return /not enrolled|no portal account|no account|not been enrolled/i.test(
    message,
  );
}

export function PatientPortalPage() {
  const [view, setView] = useState<PortalView>("login");
  const [booting, setBooting] = useState(true);

  // Enroll form state.
  const [enrollEmail, setEnrollEmail] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState("");

  // Login form state.
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [notEnrolledHint, setNotEnrolledHint] = useState(false);

  // Shared notice, e.g. the enrollment success message.
  const [notice, setNotice] = useState("");

  // Dashboard state.
  const [summary, setSummary] = useState<PortalSummary | null>(null);
  const [clinicName, setClinicName] = useState("");
  const [dashboardError, setDashboardError] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(false);

  // Change-password fold.
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [changeConfirmPassword, setChangeConfirmPassword] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState("");
  const [changeNotice, setChangeNotice] = useState("");

  async function loadSummary(): Promise<boolean> {
    setLoadingSummary(true);
    setDashboardError("");
    try {
      setSummary(await portalClient.getSummary());
      return true;
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
        portalClient.logout();
        setView("login");
        setLoginError("Your session has expired. Please sign in again.");
      } else {
        setDashboardError(
          reason instanceof Error
            ? reason.message
            : "Your record summary could not be loaded.",
        );
      }
      return false;
    } finally {
      setLoadingSummary(false);
    }
  }

  // A returning patient with a stored portal token goes straight to the
  // dashboard; an invalid token drops them on the sign-in form.
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!getPortalAccessToken()) {
        setBooting(false);
        return;
      }
      const ok = await loadSummary();
      if (cancelled) return;
      if (ok) setView("dashboard");
      setBooting(false);
    }
    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitEnroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnrollError("");
    setNotice("");
    if (newPassword !== confirmPassword) {
      setEnrollError("The two passwords do not match.");
      return;
    }
    setEnrollBusy(true);
    try {
      const result = await portalClient.enroll(
        enrollEmail.trim(),
        enrollmentCode.trim(),
        newPassword,
      );
      setNotice(
        `Welcome, ${result.full_name}. Your portal account is active. Please sign in below.`,
      );
      setLoginEmail(enrollEmail.trim());
      setEnrollmentCode("");
      setNewPassword("");
      setConfirmPassword("");
      setView("login");
    } catch (reason) {
      setEnrollError(
        reason instanceof Error ? reason.message : "Enrollment failed.",
      );
    } finally {
      setEnrollBusy(false);
    }
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    setNotEnrolledHint(false);
    setNotice("");
    try {
      const result = await portalClient.login(
        loginEmail.trim(),
        loginPassword,
      );
      setClinicName(result.patient?.clinic_name ?? "");
      setLoginPassword("");
      setView("dashboard");
      await loadSummary();
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Sign-in failed.";
      if (reason instanceof ApiError && reason.status === 401) {
        setLoginError("Email or password is incorrect.");
        if (looksNotEnrolled(message)) setNotEnrolledHint(true);
      } else if (reason instanceof ApiError && reason.status === 423) {
        // The server's detail already says "Try again in N seconds."
        setLoginError(message);
      } else {
        setLoginError(message);
      }
    } finally {
      setLoginBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChangeError("");
    setChangeNotice("");
    if (changeNewPassword !== changeConfirmPassword) {
      setChangeError("The two passwords do not match.");
      return;
    }
    setChangeBusy(true);
    try {
      await portalClient.changePassword(currentPassword, changeNewPassword);
      setChangeNotice("Your password has been changed.");
      setCurrentPassword("");
      setChangeNewPassword("");
      setChangeConfirmPassword("");
      setShowPasswordForm(false);
    } catch (reason) {
      setChangeError(
        reason instanceof Error
          ? reason.message
          : "The password could not be changed.",
      );
    } finally {
      setChangeBusy(false);
    }
  }

  function logOut() {
    portalClient.logout();
    setSummary(null);
    setClinicName("");
    setView("login");
    setLoginPassword("");
    setChangeNotice("");
    setChangeError("");
    setShowPasswordForm(false);
  }

  if (booting) {
    return (
      <main className="portal-page">
        <section className="portal-panel content-card">
          <p className="detail-muted">Opening your patient portal...</p>
        </section>
      </main>
    );
  }

  if (view === "enroll") {
    return (
      <main className="portal-page">
        <section className="portal-panel content-card">
          <div className="portal-brand">
            <span className="portal-brand-mark">
              <HeartPulse size={20} aria-hidden="true" />
            </span>
            <strong>SynCareX patient portal</strong>
          </div>
          <h1>Activate your portal access</h1>
          <p className="portal-subtitle">
            Enter the email address and one-time enrollment code your clinic
            gave you, then choose a password.
          </p>
          {notice && (
            <div className="notice notice-success" role="status">
              {notice}
            </div>
          )}
          {enrollError && (
            <div className="form-error" role="alert">
              {enrollError}
            </div>
          )}
          <form onSubmit={(event) => void submitEnroll(event)}>
            <label className="field-label" htmlFor="portal-enroll-email">
              Email
            </label>
            <input
              autoComplete="email"
              id="portal-enroll-email"
              onChange={(event) => setEnrollEmail(event.target.value)}
              required
              type="email"
              value={enrollEmail}
            />
            <label className="field-label" htmlFor="portal-enroll-code">
              Enrollment code
            </label>
            <input
              autoComplete="one-time-code"
              id="portal-enroll-code"
              onChange={(event) => setEnrollmentCode(event.target.value)}
              required
              value={enrollmentCode}
            />
            <label className="field-label" htmlFor="portal-enroll-password">
              New password
            </label>
            <input
              autoComplete="new-password"
              id="portal-enroll-password"
              minLength={8}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              type="password"
              value={newPassword}
            />
            <label className="field-label" htmlFor="portal-enroll-confirm">
              Confirm new password
            </label>
            <input
              autoComplete="new-password"
              id="portal-enroll-confirm"
              minLength={8}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              type="password"
              value={confirmPassword}
            />
            <button
              className="button button-primary portal-submit"
              disabled={enrollBusy}
              type="submit"
            >
              {enrollBusy ? "Activating..." : "Activate portal access"}
            </button>
          </form>
          <button
            className="text-link portal-switch"
            onClick={() => {
              setView("login");
              setEnrollError("");
            }}
            type="button"
          >
            Already enrolled? Sign in
          </button>
        </section>
      </main>
    );
  }

  if (view === "login") {
    return (
      <main className="portal-page">
        <section className="portal-panel content-card">
          <div className="portal-brand">
            <span className="portal-brand-mark">
              <HeartPulse size={20} aria-hidden="true" />
            </span>
            <strong>SynCareX patient portal</strong>
          </div>
          <h1>Sign in to your record summary</h1>
          <p className="portal-subtitle">
            View a read-only summary of your health record.
          </p>
          {notice && (
            <div className="notice notice-success" role="status">
              {notice}
            </div>
          )}
          {loginError && (
            <div className="form-error" role="alert">
              {loginError}
            </div>
          )}
          {notEnrolledHint && (
            <div className="notice notice-warn" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                This email may not be enrolled yet.{" "}
                <button
                  className="text-link"
                  onClick={() => {
                    setNotEnrolledHint(false);
                    setLoginError("");
                    setEnrollEmail(loginEmail);
                    setView("enroll");
                  }}
                  type="button"
                >
                  Activate it with your enrollment code
                </button>
                .
              </span>
            </div>
          )}
          <form onSubmit={(event) => void submitLogin(event)}>
            <label className="field-label" htmlFor="portal-login-email">
              Email
            </label>
            <input
              autoComplete="username"
              id="portal-login-email"
              onChange={(event) => setLoginEmail(event.target.value)}
              required
              type="email"
              value={loginEmail}
            />
            <label className="field-label" htmlFor="portal-login-password">
              Password
            </label>
            <input
              autoComplete="current-password"
              id="portal-login-password"
              onChange={(event) => setLoginPassword(event.target.value)}
              required
              type="password"
              value={loginPassword}
            />
            <button
              className="button button-primary portal-submit"
              disabled={loginBusy}
              type="submit"
            >
              {loginBusy ? "Signing in..." : "Sign in"}
            </button>
          </form>
          <button
            className="text-link portal-switch"
            onClick={() => {
              setView("enroll");
              setLoginError("");
              setNotEnrolledHint(false);
            }}
            type="button"
          >
            First time? Activate with your enrollment code
          </button>
        </section>
      </main>
    );
  }

  const patient = summary?.patient;
  const allergies = summary?.allergies ?? [];
  const medications = summary?.medications ?? [];
  const observations = [...(summary?.observations ?? [])].sort(
    (a, b) =>
      new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  );
  const consultations = summary?.consultations ?? [];

  return (
    <main className="portal-page portal-wide">
      <section className="portal-header">
        <div className="portal-brand">
          <span className="portal-brand-mark">
            <HeartPulse size={20} aria-hidden="true" />
          </span>
          <strong>SynCareX patient portal</strong>
        </div>
        <button
          className="button button-secondary"
          onClick={logOut}
          type="button"
        >
          <LogOut size={15} /> Log out
        </button>
      </section>

      <section className="content-card portal-patient-card">
        <div className="portal-patient-identity">
          <span className="summary-icon stat-icon-teal">
            <UserRound size={18} aria-hidden="true" />
          </span>
          <div>
            <h1>{patient?.full_name ?? "Your record"}</h1>
            <small>
              Patient number {patient?.patient_number ?? "Not recorded"}
              {clinicName ? ` · ${clinicName}` : ""}
            </small>
          </div>
        </div>
        <div className="portal-patient-meta">
          <span>
            <CalendarDays size={14} aria-hidden="true" />
            {ageDescription(
              patient?.date_of_birth ?? null,
              patient?.estimated_age ?? null,
            )}
          </span>
          {patient?.gender ? <span>{patient.gender}</span> : null}
        </div>
        <div className="notice notice-info" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          {READ_ONLY_NOTE}
        </div>
        {dashboardError && (
          <div className="form-error" role="alert">
            {dashboardError}{" "}
            <button
              className="text-link"
              onClick={() => void loadSummary()}
              type="button"
            >
              Try again
            </button>
          </div>
        )}
        {loadingSummary && (
          <p className="detail-muted">
            <Activity size={13} aria-hidden="true" /> Refreshing your record...
          </p>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Account</h2>
            <p>Change your portal password.</p>
          </div>
          <button
            aria-expanded={showPasswordForm}
            className="button button-quiet"
            onClick={() => {
              setShowPasswordForm((open) => !open);
              setChangeError("");
              setChangeNotice("");
            }}
            type="button"
          >
            {showPasswordForm ? (
              <>
                <ChevronUp size={15} /> Hide
              </>
            ) : (
              <>
                <ChevronDown size={15} /> Change password
              </>
            )}
          </button>
        </div>
        {changeNotice && (
          <div className="notice notice-success" role="status">
            {changeNotice}
          </div>
        )}
        {changeError && (
          <div className="form-error" role="alert">
            {changeError}
          </div>
        )}
        {showPasswordForm && (
          <form onSubmit={(event) => void submitPasswordChange(event)}>
            <label className="field-label" htmlFor="portal-current-password">
              Current password
            </label>
            <input
              autoComplete="current-password"
              id="portal-current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              type="password"
              value={currentPassword}
            />
            <label className="field-label" htmlFor="portal-new-password">
              New password
            </label>
            <input
              autoComplete="new-password"
              id="portal-new-password"
              minLength={8}
              onChange={(event) => setChangeNewPassword(event.target.value)}
              required
              type="password"
              value={changeNewPassword}
            />
            <label className="field-label" htmlFor="portal-confirm-password">
              Confirm new password
            </label>
            <input
              autoComplete="new-password"
              id="portal-confirm-password"
              minLength={8}
              onChange={(event) =>
                setChangeConfirmPassword(event.target.value)
              }
              required
              type="password"
              value={changeConfirmPassword}
            />
            <button
              className="button button-primary portal-submit"
              disabled={changeBusy}
              type="submit"
            >
              {changeBusy ? "Saving..." : "Save new password"}
            </button>
          </form>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Allergies</h2>
            <p>Recorded allergy information from your clinic.</p>
          </div>
        </div>
        {allergies.length ? (
          <div className="note-list">
            {allergies.map((allergy, index) => (
              <article className="note-entry" key={`${allergy.substance}-${index}`}>
                <strong>{allergy.substance}</strong>
                <p>
                  {allergy.reaction || "Reaction not recorded"} ·{" "}
                  {allergy.severity || "Severity not recorded"}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="detail-muted">No allergies recorded.</p>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Current medications</h2>
            <p>Medicines recorded for you by your clinic.</p>
          </div>
        </div>
        {medications.length ? (
          <div className="note-list">
            {medications.map((medication, index) => (
              <article className="note-entry" key={`${medication.name}-${index}`}>
                <strong>{medication.name}</strong>
                <p>
                  {[medication.dose, medication.frequency]
                    .filter(Boolean)
                    .join(" · ") || "Dose/frequency not recorded"}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="detail-muted">No medications recorded.</p>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Recent measurements</h2>
            <p>Newest first.</p>
          </div>
        </div>
        {observations.length ? (
          <div className="note-list">
            {observations.map((observation, index) => (
              <article
                className="note-entry"
                key={`${observation.label}-${observation.recorded_at}-${index}`}
              >
                <strong>
                  {observation.label}: {observation.value}
                  {observation.unit ? ` ${observation.unit}` : ""}
                </strong>
                <small>{formatDate(observation.recorded_at)}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="detail-muted">No measurements recorded.</p>
        )}
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Recent consultations</h2>
            <p>Your visit history.</p>
          </div>
        </div>
        {consultations.length ? (
          <div className="note-list">
            {consultations.map((consultation, index) => (
              <article
                className="note-entry"
                key={`${consultation.occurred_at}-${index}`}
              >
                <strong>{consultation.reason || "Consultation"}</strong>
                <p>
                  <ClipboardPlus size={13} aria-hidden="true" />{" "}
                  {consultation.status || "Status not recorded"}
                </p>
                <small>{formatDate(consultation.occurred_at)}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="detail-muted">No consultations recorded.</p>
        )}
      </section>

      <p className="portal-footer">
        <Pill size={12} aria-hidden="true" /> {READ_ONLY_NOTE}
      </p>
    </main>
  );
}
