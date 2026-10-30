import {
  Activity,
  BrainCircuit,
  CalendarCheck,
  QrCode,
  RefreshCw,
  Send,
  ClipboardList,
  FileText,
  Gauge,
  History,
  HeartPulse,
  ScanSearch,
  Settings,
  ShieldAlert,
  UsersRound,
  Wifi,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ConnectivityIndicator } from "../components/ConnectivityIndicator";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { useAuth } from "../services/auth";
import { useAutoSync, useSyncStatus } from "../hooks/useSyncStatus";

const navigation = [
  { to: "/", label: "Overview", icon: Gauge, end: true },
  { to: "/patients", label: "Patients", icon: UsersRound },
  { to: "/consultations", label: "Consultations", icon: ClipboardList },
  { to: "/passports", label: "Emergency passport", icon: QrCode },
  { to: "/referrals", label: "Referrals", icon: Send },
  { to: "/follow-ups", label: "Follow-ups", icon: CalendarCheck },
  { to: "/transfers", label: "Clinic exchange", icon: RefreshCw },
  { to: "/ai", label: "AI workspace", icon: BrainCircuit },
  { to: "/documents", label: "Documents", icon: FileText },
  { to: "/sync", label: "Sync center", icon: Wifi },
  { to: "/conflicts", label: "Conflicts", icon: ShieldAlert },
  { to: "/integrity", label: "Integrity guardian", icon: ScanSearch },
  { to: "/audit", label: "Audit history", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pending, conflicts } = useSyncStatus(10_000);

  // Automatic foreground synchronization whenever the API becomes reachable.
  useAutoSync();

  async function handleLogout() {
    const warning = await logout();
    navigate("/login", { replace: true, state: { notice: warning } });
  }

  const initials = (session?.user.full_name ?? "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div className="workspace">
      <aside className="sidebar">
        <NavLink className="brand" to="/" aria-label="SynCareX overview">
          <span className="brand-mark">
            <HeartPulse size={22} aria-hidden="true" />
          </span>
          <span className="brand-copy">
            <strong>SynCareX</strong>
            <small>Clinical workspace</small>
          </span>
        </NavLink>

        <div className="clinic-switcher">
          <span className="clinic-avatar">SC</span>
          <span>
            <strong>
              {session?.mode === "offline" ? "Offline workspace" : "Care workspace"}
            </strong>
            <small>
              {session?.mode === "offline" ? "Local vault only" : "Clinic session"}
            </small>
          </span>
        </div>

        <nav className="side-nav" aria-label="Main navigation">
          <span className="nav-section-label">WORKSPACE</span>
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              end={end}
              key={to}
              className={({ isActive }) => `nav-link${isActive ? " nav-link-active" : ""}`}
              to={to}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {label === "Sync center" && pending > 0 && (
                <span className="nav-count" title={`${pending} operation(s) waiting`}>
                  {pending}
                </span>
              )}
              {label === "Conflicts" && conflicts > 0 && (
                <span
                  className="nav-count nav-count-warn"
                  title={`${conflicts} record(s) need review`}
                >
                  {conflicts}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="offline-card">
            <span className="offline-card-icon">
              <Activity size={17} aria-hidden="true" />
            </span>
            <div>
              <strong>Local-first protection</strong>
              <p>
                Changes are encrypted and saved on this device before any network
                request is attempted.
              </p>
            </div>
          </div>
          <button className="sidebar-profile" onClick={handleLogout} type="button">
            <span className="profile-avatar">{initials}</span>
            <span className="profile-copy">
              <strong>{session?.user.full_name}</strong>
              <small>
                {session?.mode === "offline"
                  ? "Local vault unlocked"
                  : (session?.user.roles[0]?.name ?? "Staff")}
              </small>
            </span>
            <span className="profile-logout">Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>
              {navigation.find(
                (item) =>
                  location.pathname === item.to ||
                  (item.to !== "/" && location.pathname.startsWith(item.to)),
              )?.label ?? "Patient profile"}
            </strong>
          </div>
          <div className="topbar-actions">
            {session?.mode === "offline" && (
              <span className="session-mode">Local-only session</span>
            )}
            {pending > 0 && (
              <span className="pending-chip" title="Operations waiting to synchronize">
                {pending} waiting to sync
              </span>
            )}
            <ConnectivityIndicator />
            <span className="topbar-avatar" aria-hidden="true">
              {initials}
            </span>
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
        <footer className="workspace-footer">
          <span>SynCareX · Development build</span>
          <span>
            Clinical decisions remain with authorized healthcare professionals.
          </span>
        </footer>
      </main>
      <UpdatePrompt />
    </div>
  );
}
