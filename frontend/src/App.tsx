import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./layouts/AppLayout";
import { AuditPage } from "./pages/AuditPage";
import { AIWorkspacePage } from "./pages/AIWorkspacePage";
import { ConflictsPage } from "./pages/ConflictsPage";
import { ConsultationDetailPage } from "./pages/ConsultationDetailPage";
import { ConsultationsPage } from "./pages/ConsultationsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { FollowUpsPage } from "./pages/FollowUpsPage";
import { LoginPage } from "./pages/LoginPage";
import { IntegrityPage } from "./pages/IntegrityPage";
import { PassportPage } from "./pages/PassportPage";
import { PatientFormPage } from "./pages/PatientFormPage";
import { PatientProfilePage } from "./pages/PatientProfilePage";
import { PatientsPage } from "./pages/PatientsPage";
import { ReferralsPage } from "./pages/ReferralsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SyncPage } from "./pages/SyncPage";
import { TransfersPage } from "./pages/TransfersPage";
import { useAuth } from "./services/auth";

function ProtectedWorkspace() {
  const { session } = useAuth();
  return session ? <AppLayout /> : <Navigate to="/login" replace />;
}

export default function App() {
  const { session } = useAuth();
  return (
    <Routes>
      <Route
        path="/login"
        element={session ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route element={<ProtectedWorkspace />}>
        <Route index element={<DashboardPage />} />
        <Route path="ai" element={<AIWorkspacePage />} />
        <Route path="patients" element={<PatientsPage />} />
        <Route path="patients/new" element={<PatientFormPage />} />
        <Route path="patients/:patientId/edit" element={<PatientFormPage />} />
        <Route path="patients/:patientId" element={<PatientProfilePage />} />
        <Route path="consultations" element={<ConsultationsPage />} />
        <Route path="consultations/:consultationId" element={<ConsultationDetailPage />} />
        <Route path="passports" element={<PassportPage />} />
        <Route path="referrals" element={<ReferralsPage />} />
        <Route path="follow-ups" element={<FollowUpsPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="sync" element={<SyncPage />} />
        <Route path="conflicts" element={<ConflictsPage />} />
        <Route path="integrity" element={<IntegrityPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
