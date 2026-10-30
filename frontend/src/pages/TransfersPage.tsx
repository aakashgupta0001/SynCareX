import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Download,
  FileCheck,
  FileJson,
  HardDrive,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { patientRepository } from "../repositories/patientRepository";
import type { LocalPatient } from "../database/types";
import {
  transferRepository,
} from "../repositories/transferRepository";
import type { ClinicTransferRecord, PairedClinicRecord } from "../database/types";
import {
  buildFHIRPatientBundle,
  validateFHIRBundle,
  type FHIRBundle,
} from "../services/fhir";
import { useDismissableModal } from "../hooks/useDismissableModal";

export function TransfersPage() {
  const [activeTab, setActiveTab] = useState<"transfers" | "lan" | "pairing" | "fhir">("transfers");
  const [transfers, setTransfers] = useState<ClinicTransferRecord[]>([]);
  const [pairedClinics, setPairedClinics] = useState<PairedClinicRecord[]>([]);
  const [patients, setPatients] = useState<LocalPatient[]>([]);

  // Export Modal
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPatientId, setExportPatientId] = useState("");
  const [exportTargetClinicId, setExportTargetClinicId] = useState("");
  const [exportTargetClinicName, setExportTargetClinicName] = useState("Regional Hospital Clinic");
  const [exportConsentPurpose, setExportConsentPurpose] = useState("Inter-clinic maternal continuum of care");

  // LAN File Import
  const [importJsonText, setImportJsonText] = useState("");
  const [collisionWarning, setCollisionWarning] = useState<{
    candidate: { id: string; fullName: string; patientNumber: string };
    message: string;
    pendingJson: string;
  } | null>(null);

  // Clinic Pairing Modal
  const [showPairModal, setShowPairModal] = useState(false);
  useDismissableModal(showExportModal, () => setShowExportModal(false));
  useDismissableModal(showPairModal, () => setShowPairModal(false));
  const [pairClinicName, setPairClinicName] = useState("");
  const [pairCode, setPairCode] = useState("");

  // FHIR
  const [fhirPatientId, setFhirPatientId] = useState("");
  const [fhirBundle, setFhirBundle] = useState<FHIRBundle | null>(null);
  const [fhirValidationIssues, setFhirValidationIssues] = useState<string[]>([]);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [tList, pList, cList] = await Promise.all([
        transferRepository.listTransfers(),
        patientRepository.listAllLocal(),
        transferRepository.listPairedClinics(),
      ]);
      setTransfers(tList);
      setPatients(pList);
      setPairedClinics(cList);
      if (pList.length > 0) {
        if (!exportPatientId) setExportPatientId(pList[0].id);
        if (!fhirPatientId) setFhirPatientId(pList[0].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Transfer data could not be loaded: ${err.message}`
          : "Transfer data could not be loaded from this device.",
      );
    }
  }

  async function handleExportPackage(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!exportPatientId) {
      setError("Please select a patient.");
      return;
    }

    try {
      const { record } = await transferRepository.prepareExportPackage({
        patientId: exportPatientId,
        targetClinicId: exportTargetClinicId.trim(),
        targetClinicName: exportTargetClinicName,
        consentPurpose: exportConsentPurpose,
      });

      setMessage(`Transfer package ${record.transferId} prepared securely with checksum.`);
      setShowExportModal(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to prepare export package.");
    }
  }

  async function handleImportJson(jsonStr: string, forceNew = false, mergeId?: string) {
    setError("");
    setMessage("");
    try {
      const res = await transferRepository.importPackage(jsonStr, {
        forceNewPatient: forceNew,
        mergePatientId: mergeId,
      });

      if (res.status === "collision_detected" && res.collisionCandidate) {
        setCollisionWarning({
          candidate: res.collisionCandidate,
          message: res.message,
          pendingJson: jsonStr,
        });
        return;
      }

      setCollisionWarning(null);
      setImportJsonText("");
      setMessage(res.message);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import package.");
    }
  }

  async function handlePairClinic(e: React.FormEvent) {
    e.preventDefault();
    if (!pairClinicName || !pairCode) return;

    try {
      const id = `clinic-${pairClinicName.toLowerCase().replace(/\s+/g, "-")}`;
      await transferRepository.pairClinic(id, pairClinicName, pairCode);
      setMessage(`Successfully paired with ${pairClinicName}.`);
      setShowPairModal(false);
      setPairClinicName("");
      setPairCode("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pair clinic.");
    }
  }

  async function generateFhirBundle() {
    setError("");
    if (!fhirPatientId) return;
    const p = patients.find((pat) => pat.id === fhirPatientId);
    if (!p) return;

    const bundle = buildFHIRPatientBundle(
      {
        id: p.id,
        patientNumber: p.patientNumber,
        fullName: p.fullName,
        dateOfBirth: p.dateOfBirth,
        gender: p.gender,
        contactPhone: p.contactPhone,
        address: p.address,
        village: p.village,
        relevantHistory: p.relevantHistory,
      },
      {
        allergies: (p.allergies || []).map((a, i) => ({ id: `alg-${i + 1}`, substance: a })),
      },
    );

    const val = validateFHIRBundle(bundle);
    setFhirBundle(bundle);
    setFhirValidationIssues(val.issues);
  }

  function downloadJson(data: object, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <PageHeader
          title="Secure Clinic Exchange & Packages"
          description="Prepare authenticated patient export packages, prevent duplicate collisions, and interoperate with FHIR R4."
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowExportModal(true)}
            className="button button-primary flex items-center gap-1.5 text-xs"
          >
            <Plus size={14} /> Prepare Export
          </button>
        </div>
      </div>

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

      {/* COLLISION RESOLUTION BANNER */}
      {collisionWarning && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-300 rounded-xl text-amber-900 shadow-sm space-y-3">
          <div className="flex items-center gap-2 font-bold text-sm text-amber-950">
            <AlertTriangle size={18} className="text-amber-600" /> Potential Identity Collision Detected
          </div>
          <p className="text-xs text-amber-900">{collisionWarning.message}</p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="button button-primary text-xs py-1.5 px-3 bg-amber-800 hover:bg-amber-900"
              onClick={() => handleImportJson(collisionWarning.pendingJson, false, collisionWarning.candidate.id)}
            >
              Merge With Existing Patient ({collisionWarning.candidate.patientNumber})
            </button>
            <button
              type="button"
              className="button button-secondary text-xs py-1.5 px-3"
              onClick={() => handleImportJson(collisionWarning.pendingJson, true)}
            >
              Create As Separate New Record
            </button>
            <button
              type="button"
              className="text-xs text-amber-700 hover:underline px-2 py-1"
              onClick={() => setCollisionWarning(null)}
            >
              Cancel Import
            </button>
          </div>
        </div>
      )}

      {/* TABS */}
      <div className="flex border-b border-slate-200 mb-6 gap-2">
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "transfers"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("transfers")}
        >
          <RefreshCw size={16} /> Exchange Packages ({transfers.length})
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "lan"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("lan")}
        >
          <HardDrive size={16} /> Offline LAN / File Exchange
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "pairing"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("pairing")}
        >
          <Link2 size={16} /> Paired Clinics ({pairedClinics.length})
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "fhir"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("fhir")}
        >
          <FileJson size={16} /> FHIR R4 Interop
        </button>
      </div>

      {/* TAB 1: EXCHANGE PACKAGES */}
      {activeTab === "transfers" && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-slate-800">Transfer Package Ledger</h3>
            <span className="text-xs text-slate-500">SHA-256 Verified Packages</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-4">Transfer ID</th>
                  <th className="py-2.5 px-4">Patient</th>
                  <th className="py-2.5 px-4">Direction / Clinic</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Checksum</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transfers.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-mono text-xs text-slate-800 font-bold">
                      {t.transferId}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      {t.patientName || "Patient Record"}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      {t.status === "imported" ? (
                        <span className="flex items-center gap-1 text-blue-700">
                          <ArrowDownLeft size={14} /> From {t.sourceClinicName}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-teal-700">
                          <ArrowUpRight size={14} /> To {t.targetClinicName}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {t.status === "imported" ? (
                        <FreshnessBadge status="imported" sourceClinic={t.sourceClinicName} />
                      ) : (
                        <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 font-medium">
                          {t.status}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-400">
                      {t.checksum.slice(0, 12)}...
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        className="text-xs text-teal-700 font-medium hover:underline flex items-center gap-1 ml-auto"
                        onClick={() => downloadJson(JSON.parse(t.encryptedPayload), `${t.transferId}.json`)}
                      >
                        <Download size={13} /> Export JSON
                      </button>
                    </td>
                  </tr>
                ))}
                {transfers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400 text-xs">
                      No transfer packages generated yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: OFFLINE LAN / FILE EXCHANGE */}
      {activeTab === "lan" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Upload size={18} className="text-teal-600" /> Import Package (File / LAN)
            </h3>
            <p className="text-xs text-slate-500">
              Paste or load an exported SynCareX continuity package. Strict checksum verification and duplicate patient collision checks will be enforced automatically.
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Select Package File
              </label>
              <input
                type="file"
                accept=".json"
                className="w-full text-xs text-slate-500 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-slate-100 file:font-semibold hover:file:bg-slate-200"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      if (typeof ev.target?.result === "string") {
                        setImportJsonText(ev.target.result);
                      }
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Or Paste Package JSON
              </label>
              <textarea
                rows={6}
                className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono bg-slate-50"
                placeholder='{"schemaVersion": "syncarex-continuity-v1", ...}'
                value={importJsonText}
                onChange={(e) => setImportJsonText(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="button button-primary w-full py-2.5 text-xs flex items-center justify-center gap-2"
              disabled={!importJsonText.trim()}
              onClick={() => handleImportJson(importJsonText)}
            >
              <ShieldCheck size={16} /> Verify & Import Package
            </button>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Download size={18} className="text-teal-600" /> Export Local Patient Package
            </h3>
            <p className="text-xs text-slate-500">
              Create an encrypted, portable file package with verified source provenance for offline clinic transfer.
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Select Patient
              </label>
              <select
                className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                value={exportPatientId}
                onChange={(e) => setExportPatientId(e.target.value)}
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName} ({p.patientNumber})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                Target Clinic Name
              </label>
              <input
                type="text"
                className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                value={exportTargetClinicName}
                onChange={(e) => setExportTargetClinicName(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="button button-secondary w-full py-2.5 text-xs flex items-center justify-center gap-2"
              onClick={handleExportPackage}
            >
              <FileCheck size={16} /> Generate Export File
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: CLINIC PAIRING */}
      {activeTab === "pairing" && (
        <div className="space-y-6">
          <div className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Mutual Clinic Pairing Registry</h3>
              <p className="text-xs text-slate-500">Authorized peer clinics trusted for direct electronic health record transfers.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowPairModal(true)}
              className="button button-primary py-1.5 px-3 text-xs flex items-center gap-1.5"
            >
              <Plus size={14} /> Pair New Clinic
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pairedClinics.map((c) => (
              <div key={c.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-2">
                <div className="flex justify-between items-start">
                  <h4 className="font-semibold text-slate-900 text-sm">{c.clinicName}</h4>
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {c.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 font-mono">ID: {c.clinicId}</div>
                <div className="text-[11px] text-slate-400">
                  Paired on: {new Date(c.pairedAt).toLocaleDateString()}
                </div>
              </div>
            ))}

            {pairedClinics.length === 0 && (
              <div className="col-span-full py-12 text-center text-slate-400 text-xs bg-white rounded-xl border border-slate-200">
                No clinics paired yet. Establish mutual pairing with a referral or district clinic.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: FHIR R4 INTEROP */}
      {activeTab === "fhir" && (
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <FileJson size={18} className="text-teal-600" /> FHIR R4 Serialization & Schema Validator
              </h3>
              <p className="text-xs text-slate-500">
                Export local clinical records to standard HL7 FHIR R4 Bundle with client-side structural validation.
              </p>
            </div>
            <div className="flex gap-2">
              <select
                className="p-2 border border-slate-300 rounded-lg text-xs bg-white"
                value={fhirPatientId}
                onChange={(e) => setFhirPatientId(e.target.value)}
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName} ({p.patientNumber})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button button-primary py-1.5 px-3 text-xs"
                onClick={generateFhirBundle}
              >
                Generate Bundle
              </button>
            </div>
          </div>

          {fhirBundle && (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase text-slate-600">Validation Status:</span>
                  {fhirValidationIssues.length === 0 ? (
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                      <CheckCircle2 size={12} /> Valid FHIR R4 Bundle ({fhirBundle.entry.length} resources)
                    </span>
                  ) : (
                    <span className="text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2.5 py-0.5 rounded-full">
                      {fhirValidationIssues.length} issue(s) detected
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="button button-secondary py-1 px-3 text-xs flex items-center gap-1"
                  onClick={() => downloadJson(fhirBundle, `fhir-${fhirBundle.id}.json`)}
                >
                  <Download size={13} /> Download FHIR JSON
                </button>
              </div>

              <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono max-h-96 overflow-y-auto">
                {JSON.stringify(fhirBundle, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* EXPORT MODAL */}
      {showExportModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Prepare Patient Transfer Package</h2>
            <form onSubmit={handleExportPackage} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Select Patient *
                </label>
                <select
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                  value={exportPatientId}
                  onChange={(e) => setExportPatientId(e.target.value)}
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName} ({p.patientNumber})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Target Clinic Name *
                </label>
                <input
                  type="text"
                  required
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={exportTargetClinicName}
                  onChange={(e) => setExportTargetClinicName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Target Clinic ID *
                </label>
                <input
                  type="text"
                  required
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  placeholder="For example: clinic-regional-01"
                  value={exportTargetClinicId}
                  onChange={(e) => setExportTargetClinicId(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Transfer Consent & Purpose *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Authorized maternal emergency referral"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={exportConsentPurpose}
                  onChange={(e) => setExportConsentPurpose(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowExportModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  Generate Package
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PAIRING MODAL */}
      {showPairModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Pair With Peer Clinic</h2>
            <form onSubmit={handlePairClinic} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Clinic Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sub-District Hospital B"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={pairClinicName}
                  onChange={(e) => setPairClinicName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Mutual Pairing Code *
                </label>
                <input
                  type="text"
                  required
                  placeholder="CLINIC-PAIR-XXXX"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm font-mono"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowPairModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  Confirm Pairing
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

