import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  ClipboardCheck,
  CloudUpload,
  FileText,
  Plus,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { SyncStateBadge } from "../components/SyncStateBadge";
import { patientRepository } from "../repositories/patientRepository";
import { consultationRepository } from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import { integrityRepository } from "../repositories/integrityRepository";
import { useAuth } from "../services/auth";
import { useSyncStatus } from "../hooks/useSyncStatus";
import type { LocalPatient } from "../database/types";

export function DashboardPage() {
  const { session } = useAuth();
  const { pending, conflicts } = useSyncStatus(10_000);
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [states, setStates] = useState<Map<string, RecordSyncState>>(new Map());
  const [patientCount, setPatientCount] = useState(0);
  const [consultationCount, setConsultationCount] = useState(0);
  const [documentCount, setDocumentCount] = useState(0);
  const [integrityCount, setIntegrityCount] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [patientPage, consultationPage, documents, findings] = await Promise.all([
        patientRepository.listLocal({ page: 1, pageSize: 5 }),
        consultationRepository.listLocal(1, 1),
        documentRepository.countLocal(),
        integrityRepository.countOpen(),
      ]);
      setPatientCount(patientPage.total);
      setPatients(patientPage.items);
      setConsultationCount(consultationPage.total);
      setDocumentCount(documents);
      setIntegrityCount(findings);
      setStates(
        await syncRepository.entityStates(patientPage.items.map((item) => item.id)),
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The local workspace could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="CARE OPERATIONS"
        title="Good day"
        description="A clear view of the clinical records stored on this device and what is still waiting to synchronize."
        action={
          <Link className="button button-primary" to="/patients/new">
            <Plus size={17} /> Register patient
          </Link>
        }
      />
      {session?.mode === "offline" && (
        <div className="notice notice-warn" role="status">
          You are working offline from this device's encrypted vault. Every change is
          saved locally and queued until the server can confirm it.
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}
      {loading ? (
        <LoadingState label="Reading encrypted local records..." />
      ) : (
        <>
          <section aria-label="Workspace summary" className="stats-grid">
            <article className="stat-card">
              <span className="stat-icon stat-icon-teal">
                <UsersRound size={19} />
              </span>
              <span className="stat-label">Patients on this device</span>
              <strong>{patientCount}</strong>
              <span className="stat-foot">Encrypted local records</span>
            </article>
            <article className="stat-card">
              <span className="stat-icon stat-icon-blue">
                <ClipboardCheck size={19} />
              </span>
              <span className="stat-label">Consultations</span>
              <strong>{consultationCount}</strong>
              <span className="stat-foot">Documentation only</span>
            </article>
            <article className="stat-card">
              <span className="stat-icon stat-icon-green">
                <FileText size={19} />
              </span>
              <span className="stat-label">Documents stored</span>
              <strong>{documentCount}</strong>
              <span className="stat-foot">Kept until upload is confirmed</span>
            </article>
            <article className="stat-card">
              <span className="stat-icon stat-icon-amber">
                <CloudUpload size={19} />
              </span>
              <span className="stat-label">Waiting to sync</span>
              <strong>{pending}</strong>
              <span className="stat-foot">
                {conflicts ? `${conflicts} need review` : "Retained until acknowledged"}
              </span>
            </article>
          </section>
          <Link className="notice notice-info integrity-dashboard-link" to="/integrity">
            <ShieldCheck size={17} />
            <span>
              <strong>{integrityCount} unresolved integrity finding(s)</strong>
              {" "}· Local checks include duplicate candidates, record links, AI provenance,
              document checksums, and sync health.
            </span>
            <ArrowUpRight size={15} />
          </Link>

          <section className="dashboard-section">
            <div className="section-heading">
              <div>
                <h2>Recently updated patients</h2>
                <p>Records saved in this device's encrypted vault.</p>
              </div>
              <Link className="text-link" to="/patients">
                Open directory <ArrowUpRight size={15} />
              </Link>
            </div>
            {patients.length ? (
              <div className="patient-list-card">
                {patients.map((patient) => (
                  <Link
                    className="patient-row"
                    key={patient.id}
                    to={`/patients/${patient.id}`}
                  >
                    <span className="patient-initials">
                      {patient.fullName
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join("")
                        .toUpperCase()}
                    </span>
                    <span className="patient-row-main">
                      <strong>{patient.fullName}</strong>
                      <small>
                        {patient.patientNumber} ·{" "}
                        {patient.village || "Location not recorded"}
                      </small>
                    </span>
                    <SyncStateBadge state={states.get(patient.id) ?? "saved_locally"} />
                    <span className="patient-row-date">
                      {new Date(patient.updatedAt).toLocaleDateString()}
                    </span>
                    <ArrowUpRight size={16} className="row-arrow" />
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Your patient directory is ready"
                description="Register a synthetic test patient to exercise local encrypted storage. Do not enter real patient information in this development build."
                action={
                  <Link className="button button-secondary" to="/patients/new">
                    <Plus size={16} /> Add a test patient
                  </Link>
                }
              />
            )}
          </section>

          <section className="safety-banner">
            <ShieldCheck size={19} aria-hidden="true" />
            <p>
              <strong>Clinical safety:</strong> SynCareX stores and organizes
              documentation. It does not diagnose, prescribe, or recommend treatment.
            </p>
          </section>
        </>
      )}
    </>
  );
}
