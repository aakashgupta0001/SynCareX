import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Plus, Search, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import { SyncStateBadge } from "../components/SyncStateBadge";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import { serverIndexTerms } from "../security/clinicKey";
import { trigrams } from "../offline/searchIndex";
import { api, ApiError, mapPatientFromApi } from "../services/api";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";
import type { LocalPatient } from "../database/types";

const PAGE_SIZE = 10;

export function PatientsPage() {
  const { session } = useAuth();
  const { apiUsable } = useConnectivityState();
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [states, setStates] = useState<Map<string, RecordSyncState>>(new Map());
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setWarning("");
    try {
      // The local vault answers first, always. The server is only a refresh.
      if (apiUsable && session?.mode === "online") {
        try {
          // Send keyed hashes rather than the query itself, so the
          // server can match without ever receiving a patient name.
          const hashedTerms = await serverIndexTerms(trigrams(query));
          const remote = await api.listPatients(
            hashedTerms.length ? "" : query,
            hashedTerms,
          );
          await Promise.all(
            remote.items.map((item) =>
              patientRepository.cacheServerPatient(mapPatientFromApi(item)),
            ),
          );
        } catch (reason) {
          setWarning(
            reason instanceof ApiError && reason.status === 0
              ? `${reason.message} Showing locally stored records.`
              : reason instanceof Error
                ? `Server records unavailable: ${reason.message}`
                : "Server records unavailable.",
          );
        }
      }
      const result = await patientRepository.searchLocal(query, {
        page,
        pageSize: PAGE_SIZE,
      });
      setPatients(result.items);
      setPages(result.pages);
      setTotal(result.total);
      setStates(
        await syncRepository.entityStates(result.items.map((item) => item.id)),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Patient records could not be read from this device.",
      );
    } finally {
      setLoading(false);
    }
  }, [apiUsable, page, query, session?.mode]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="PATIENT RECORDS"
        title="Patient directory"
        description="Search the encrypted records on this device. Server records are cached only after an authorized sign-in."
        action={
          <Link className="button button-primary" to="/patients/new">
            <Plus size={17} /> Register patient
          </Link>
        }
      />
      <div className="directory-toolbar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="Search patients"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search name, patient ID, village or phone"
            value={query}
          />
        </label>
        <span className="result-count">{total} on this device</span>
      </div>
      {warning && (
        <div className="notice notice-warn" role="status">
          {warning}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}
      {loading ? (
        <LoadingState label="Searching encrypted local records..." />
      ) : patients.length ? (
        <>
          <div className="patient-table-wrap">
            <table className="patient-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Patient ID</th>
                  <th>Age / DOB</th>
                  <th>Village</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>
                    <span className="sr-only">Open record</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {patients.map((patient) => (
                  <tr key={patient.id}>
                    <td>
                      <Link className="table-patient" to={`/patients/${patient.id}`}>
                        <span className="patient-initials">
                          {patient.fullName
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join("")
                            .toUpperCase()}
                        </span>
                        <span>
                          <strong>{patient.fullName}</strong>
                          <small>{patient.contactPhone || "No contact recorded"}</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <span className="id-chip">{patient.patientNumber}</span>
                    </td>
                    <td>
                      {patient.estimatedAge !== null
                        ? `${patient.estimatedAge} years (estimated)`
                        : patient.dateOfBirth || "Unknown"}
                    </td>
                    <td>{patient.village || "—"}</td>
                    <td>
                      <SyncStateBadge state={states.get(patient.id) ?? "saved_locally"} />
                    </td>
                    <td>{new Date(patient.updatedAt).toLocaleDateString()}</td>
                    <td>
                      <Link
                        aria-label={`Open ${patient.fullName}`}
                        className="icon-link"
                        to={`/patients/${patient.id}`}
                      >
                        <ArrowUpRight size={17} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Patient pages" className="pagination">
              <button
                className="button button-quiet"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                <ChevronLeft size={16} /> Previous
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button
                className="button button-quiet"
                disabled={page >= pages}
                onClick={() => setPage((current) => Math.min(pages, current + 1))}
                type="button"
              >
                Next <ChevronRight size={16} />
              </button>
            </nav>
          )}
        </>
      ) : (
        <EmptyState
          title={query ? "No matching patient records" : "No patient records yet"}
          description={
            query
              ? "Try a different search or clear the search field."
              : "Create a local record. It is encrypted and saved before any network request is attempted."
          }
          action={
            !query && (
              <Link className="button button-secondary" to="/patients/new">
                <UsersRound size={16} /> Register a patient
              </Link>
            )
          }
        />
      )}
    </>
  );
}
