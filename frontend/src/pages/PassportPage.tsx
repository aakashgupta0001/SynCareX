import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  QrCode,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { QRCodeDisplay } from "../components/QRCodeDisplay";
import { patientRepository } from "../repositories/patientRepository";
import type { LocalPatient } from "../database/types";
import {
  passportRepository,
  type EmergencySummaryPayload,
  type PassportVerificationResult,
} from "../repositories/passportRepository";
import type { EmergencyPassportRecord } from "../database/types";
import { useConnectivityState } from "../hooks/useConnectivity";

export function PassportPage() {
  const [activeTab, setActiveTab] = useState<"issue" | "verify" | "list">("issue");
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [validityHours, setValidityHours] = useState(72);
  const [consentGiven, setConsentGiven] = useState(true);
  const [consentDetails, setConsentDetails] = useState("Patient emergency verbal disclosure consent");

  // Data minimization checkboxes
  const [includeContact, setIncludeContact] = useState(true);
  const [includeAllergies, setIncludeAllergies] = useState(true);
  const [includeMeds, setIncludeMeds] = useState(true);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [includeObs, setIncludeObs] = useState(true);

  const [issuedPassport, setIssuedPassport] = useState<{
    token: string;
    record: EmergencyPassportRecord;
    payload: EmergencySummaryPayload;
  } | null>(null);

  const [verifyToken, setVerifyToken] = useState("");
  const [verificationResult, setVerificationResult] = useState<PassportVerificationResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [passportsList, setPassportsList] = useState<EmergencyPassportRecord[]>([]);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const connectivity = useConnectivityState();

  useEffect(() => {
    loadPatients();
    loadPassports();
  }, []);

  async function loadPatients() {
    try {
      const list = await patientRepository.listAllLocal();
      setPatients(list);
      if (list.length > 0 && !selectedPatientId) {
        setSelectedPatientId(list[0].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Local patients could not be loaded: ${err.message}`
          : "Local patients could not be loaded from this device.",
      );
    }
  }

  async function loadPassports() {
    try {
      const list = await passportRepository.listPassports();
      setPassportsList(list);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Passports could not be loaded: ${err.message}`
          : "Passports could not be loaded from this device.",
      );
    }
  }

  async function handleIssuePassport() {
    setError("");
    setMessage("");
    if (!selectedPatientId) {
      setError("Please select a patient.");
      return;
    }
    if (!consentGiven) {
      setError("Patient emergency disclosure authorization is required.");
      return;
    }

    const fields: string[] = [];
    if (includeContact) fields.push("emergency_contact");
    if (includeAllergies) fields.push("allergies");
    if (includeMeds) fields.push("medications");
    if (includeHistory) fields.push("recent_history");
    if (includeObs) fields.push("observations");

    if (fields.length === 0) {
      setError("Select at least one clinical section according to data minimization principles.");
      return;
    }

    try {
      const res = await passportRepository.createPassport({
        patientId: selectedPatientId,
        includedFields: fields,
        consentGiven,
        consentDetails,
        validityHours,
      });
      setIssuedPassport(res);
      setMessage("Emergency Patient Passport issued securely.");
      await loadPassports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to issue passport.");
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!verifyToken.trim()) return;
    setIsVerifying(true);
    setError("");

    try {
      // Offline-first verification
      const result = await passportRepository.verifyPassportOffline(verifyToken);
      setVerificationResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleRevoke(id: string) {
    const reason = window.prompt("Reason for passport revocation:", "Patient request / expired credentials");
    if (!reason) return;
    try {
      await passportRepository.revokePassport(id, reason);
      setMessage("Passport revoked successfully.");
      await loadPassports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke passport.");
    }
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Emergency Patient Passport"
        description="Portable, cryptographically verified emergency package designed for offline frontline care with strict data minimization."
      />

      {message && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm flex items-center gap-2">
          <CheckCircle2 size={16} /> {message}
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm flex items-center gap-2">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 mb-6 gap-2">
        <button
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "issue"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("issue")}
          type="button"
        >
          <QrCode size={16} /> Issue Passport
        </button>
        <button
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "verify"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("verify")}
          type="button"
        >
          <KeyRound size={16} /> Verify & Scan
        </button>
        <button
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "list"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("list")}
          type="button"
        >
          <ShieldAlert size={16} /> Active Passports ({passportsList.length})
        </button>
      </div>

      {/* TAB 1: ISSUE PASSPORT */}
      {activeTab === "issue" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <UserCheck size={18} className="text-teal-600" /> Patient & Consent Configuration
            </h2>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Select Local Patient
              </label>
              <select
                className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                value={selectedPatientId}
                onChange={(e) => setSelectedPatientId(e.target.value)}
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName} ({p.patientNumber})
                  </option>
                ))}
              </select>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-2">
                Data Minimization: Essential Fields Only
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeContact}
                    onChange={(e) => setIncludeContact(e.target.checked)}
                    className="rounded text-teal-600"
                  />
                  <span>Patient-selected Emergency Contact</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeAllergies}
                    onChange={(e) => setIncludeAllergies(e.target.checked)}
                    className="rounded text-teal-600"
                  />
                  <span>Verified Critical Allergies</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeMeds}
                    onChange={(e) => setIncludeMeds(e.target.checked)}
                    className="rounded text-teal-600"
                  />
                  <span>Current Active Medications Documentation</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeHistory}
                    onChange={(e) => setIncludeHistory(e.target.checked)}
                    className="rounded text-teal-600"
                  />
                  <span>Pertinent Medical History Summary</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeObs}
                    onChange={(e) => setIncludeObs(e.target.checked)}
                    className="rounded text-teal-600"
                  />
                  <span>Important Clinician Observations (Vitals / BP)</span>
                </label>
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Validity Duration
              </label>
              <select
                className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                value={validityHours}
                onChange={(e) => setValidityHours(Number(e.target.value))}
              >
                <option value={24}>24 Hours (Immediate Transit)</option>
                <option value={48}>48 Hours (Standard Emergency)</option>
                <option value={72}>72 Hours (3 Days Emergency)</option>
                <option value={168}>7 Days (Extended Field Protocol)</option>
              </select>
            </div>

            <div className="border-t border-slate-100 pt-4 bg-slate-50 p-3 rounded-lg">
              <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentGiven}
                  onChange={(e) => setConsentGiven(e.target.checked)}
                  className="mt-0.5 rounded text-teal-600"
                />
                <span>
                  <strong>Patient Emergency Consent:</strong> Patient or designated proxy authorizes portable disclosure of minimal health data for emergency care.
                </span>
              </label>
              <input
                type="text"
                className="mt-2 w-full p-1.5 border border-slate-300 rounded text-xs bg-white"
                placeholder="Consent notes (e.g. Verbal consent witnessed by nurse)"
                value={consentDetails}
                onChange={(e) => setConsentDetails(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="button button-primary w-full py-2.5 flex items-center justify-center gap-2"
              onClick={handleIssuePassport}
            >
              <ShieldCheck size={18} /> Issue Emergency Passport Package
            </button>
          </div>

          {/* Generated Passport Preview */}
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
            {issuedPassport ? (
              <div className="w-full space-y-4">
                <div className="flex justify-between items-center w-full border-b border-slate-100 pb-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase">
                    Issued Emergency Passport
                  </span>
                  <FreshnessBadge status="verified" />
                </div>

                <QRCodeDisplay
                  value={issuedPassport.token}
                  size={200}
                  label={issuedPassport.payload.patientFullName}
                />

                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 text-left text-xs font-mono break-all space-y-1">
                  <div className="text-slate-500 uppercase font-sans font-semibold">Verification Token</div>
                  <div className="text-teal-700 font-bold select-all">{issuedPassport.token}</div>
                  <div className="text-slate-400 font-sans text-[11px] pt-1">
                    Expires: {new Date(issuedPassport.payload.expiresAt).toLocaleString()}
                  </div>
                  <div className="text-slate-400 font-sans text-[11px]">
                    Checksum: {issuedPassport.payload.checksum.slice(0, 16)}...
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    className="button button-secondary flex-1 py-1.5 text-xs flex items-center justify-center gap-1"
                    onClick={() => {
                      void navigator.clipboard.writeText(issuedPassport.token);
                      setMessage("Verification token copied to the clipboard.");
                    }}
                  >
                    <Copy size={14} /> Copy Token
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-12 text-slate-400 space-y-2">
                <QrCode size={48} className="mx-auto opacity-40" />
                <p className="text-sm font-medium">No passport issued yet</p>
                <p className="text-xs max-w-xs">
                  Configure patient information and select minimal necessary fields to generate an authorized emergency passport.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: VERIFY PASSPORT */}
      {activeTab === "verify" && (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <KeyRound size={18} className="text-teal-600" /> Verify Emergency Passport Token
            </h2>
            <form onSubmit={handleVerify} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Enter or Scan QR Token
                </label>
                <input
                  type="text"
                  required
                  placeholder="scx-pass-..."
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-sm font-mono"
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                />
              </div>

              <div className="flex justify-between items-center pt-2">
                <span className="text-xs text-slate-500">
                  {connectivity.apiUsable ? "Server connection available" : "Offline mode: Local CRL verification"}
                </span>
                <button
                  type="submit"
                  disabled={isVerifying}
                  className="button button-primary px-5 py-2 text-sm flex items-center gap-2"
                >
                  <ShieldCheck size={16} /> Verify Passport
                </button>
              </div>
            </form>
          </div>

          {verificationResult && (
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex justify-between items-start border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    {verificationResult.payload?.patientFullName || "Verification Result"}
                  </h3>
                  <div className="text-xs text-slate-500">
                    Patient Number: {verificationResult.payload?.patientNumber || "N/A"}
                  </div>
                </div>
                <FreshnessBadge status={verificationResult.verificationBadge} />
              </div>

              {/* OFFLINE WARNING CALLOUT */}
              {verificationResult.offlineWarning && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600" />
                  <div>
                    <strong>Offline Verification Notice:</strong> {verificationResult.offlineWarning}
                  </div>
                </div>
              )}

              {verificationResult.isValid && verificationResult.payload && (
                <div className="space-y-3 text-sm">
                  {verificationResult.payload.emergencyContact && (
                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <span className="text-xs font-semibold uppercase text-slate-500 block mb-1">
                        Emergency Contact
                      </span>
                      <p className="font-medium text-slate-800">
                        {verificationResult.payload.emergencyContact.name || "None designated"}
                        {verificationResult.payload.emergencyContact.phone && (
                          <span className="text-slate-500 ml-2">({verificationResult.payload.emergencyContact.phone})</span>
                        )}
                      </p>
                    </div>
                  )}

                  {verificationResult.payload.allergies && (
                    <div className="p-3 bg-rose-50/50 rounded-lg border border-rose-100">
                      <span className="text-xs font-semibold uppercase text-rose-700 block mb-1">
                        Verified Allergies
                      </span>
                      {verificationResult.payload.allergies.length > 0 ? (
                        <ul className="list-disc list-inside text-xs text-slate-800 space-y-1">
                          {verificationResult.payload.allergies.map((a, i) => (
                            <li key={i}>
                              <strong>{a.substance}</strong>: {a.reaction || "No reaction specified"} ({a.severity})
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-slate-500">No known allergies documented</span>
                      )}
                    </div>
                  )}

                  {verificationResult.payload.medications && (
                    <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                      <span className="text-xs font-semibold uppercase text-blue-700 block mb-1">
                        Active Medications
                      </span>
                      {verificationResult.payload.medications.length > 0 ? (
                        <ul className="list-disc list-inside text-xs text-slate-800 space-y-1">
                          {verificationResult.payload.medications.map((m, i) => (
                            <li key={i}>
                              <strong>{m.name}</strong> {m.dose} {m.frequency}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-slate-500">No active medications recorded</span>
                      )}
                    </div>
                  )}

                  {verificationResult.payload.relevantHistory && (
                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <span className="text-xs font-semibold uppercase text-slate-500 block mb-1">
                        Pertinent History
                      </span>
                      <p className="text-xs text-slate-700 whitespace-pre-line">
                        {verificationResult.payload.relevantHistory}
                      </p>
                    </div>
                  )}

                  <div className="text-[11px] text-slate-400 pt-2 flex justify-between">
                    <span>Issued: {new Date(verificationResult.payload.issuedAt).toLocaleString()}</span>
                    <span>Expires: {new Date(verificationResult.payload.expiresAt).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {!verificationResult.isValid && (
                <div className="p-4 text-center text-rose-700 font-medium text-sm">
                  {verificationResult.message}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: ACTIVE PASSPORTS & REVOCATION */}
      {activeTab === "list" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-slate-800">Local Emergency Passports Registry</h3>
            <button
              type="button"
              className="text-xs text-teal-700 font-medium flex items-center gap-1 hover:underline"
              onClick={loadPassports}
            >
              <RotateCcw size={12} /> Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-4">Patient</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Expires</th>
                  <th className="py-2.5 px-4">Issued</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {passportsList.map((p) => {
                  const isExpired = new Date(p.expiresAt).getTime() < Date.now();
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {p.patientName || "Patient"}
                      </td>
                      <td className="py-3 px-4">
                        {p.isRevoked ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-medium">
                            Revoked
                          </span>
                        ) : isExpired ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                            Expired
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                            Active
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {new Date(p.expiresAt).toLocaleDateString()} {new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-500">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!p.isRevoked && (
                          <button
                            type="button"
                            className="text-xs text-rose-600 hover:text-rose-800 font-medium"
                            onClick={() => handleRevoke(p.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {passportsList.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400 text-xs">
                      No emergency passports have been issued yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

