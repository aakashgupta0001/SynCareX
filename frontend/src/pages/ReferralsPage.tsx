import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  Plus,
  Send,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { patientRepository } from "../repositories/patientRepository";
import type { LocalPatient } from "../database/types";
import { referralRepository } from "../repositories/referralRepository";
import type { ReferralPriority, ReferralRecord, ReferralStatus } from "../database/types";
import { useAuth } from "../services/auth";
import { useDismissableModal } from "../hooks/useDismissableModal";

export function ReferralsPage() {
  const [referrals, setReferrals] = useState<ReferralRecord[]>([]);
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showModal, setShowModal] = useState(false);
  useDismissableModal(showModal, () => setShowModal(false));

  // Form states
  const [patientId, setPatientId] = useState("");
  const [receivingClinicId, setReceivingClinicId] = useState("clinic-dist-hospital-01");
  const [receivingClinicName, setReceivingClinicName] = useState("District General Hospital");
  const [reason, setReason] = useState("");
  const [clinicalSummary, setClinicalSummary] = useState("");
  const [priority, setPriority] = useState<ReferralPriority>("routine");
  const [submitAsDraft, setSubmitAsDraft] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { session } = useAuth();

  const userPermissions = new Set(session?.permissions ?? []);
  const isDoctor = (session?.user.roles ?? []).some((role) => role.name === "Doctor");
  const canApprove = userPermissions.has("referrals.approve") || isDoctor;
  const canSend = userPermissions.has("referrals.send") || canApprove;

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [refList, patList] = await Promise.all([
        referralRepository.listReferrals(),
        patientRepository.listAllLocal(),
      ]);
      setReferrals(refList);
      setPatients(patList);
      if (patList.length > 0 && !patientId) {
        setPatientId(patList[0].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Referrals could not be loaded: ${err.message}`
          : "Referrals could not be loaded from this device.",
      );
    }
  }

  async function handleCreateReferral(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!patientId) {
      setError("Please select a patient.");
      return;
    }
    if (!reason.trim()) {
      setError("Referral reason is required.");
      return;
    }

    try {
      await referralRepository.createReferral({
        patientId,
        receivingClinicId,
        receivingClinicName,
        reason,
        clinicalSummary,
        priority,
        status: submitAsDraft ? "draft" : "awaiting_review",
      });

      setMessage(
        submitAsDraft
          ? "Referral saved locally as Draft."
          : "Referral submitted for clinician review.",
      );
      setShowModal(false);
      setReason("");
      setClinicalSummary("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create referral.");
    }
  }

  async function handleStatusTransition(id: string, newStatus: ReferralStatus) {
    try {
      await referralRepository.updateStatus(id, newStatus);
      setMessage(`Referral status transitioned to ${newStatus}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update referral status.");
    }
  }

  const filtered = referrals.filter((r) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "drafts") return r.status === "draft";
    if (statusFilter === "review") return r.status === "awaiting_review";
    if (statusFilter === "approved") return r.status === "approved" || r.status === "ready_to_send";
    if (statusFilter === "transmitted") return r.status === "sent" || r.status === "received";
    if (statusFilter === "accepted") return r.status === "accepted" || r.status === "completed";
    return true;
  });

  function getStatusBadge(status: ReferralStatus) {
    switch (status) {
      case "draft":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">Draft</span>;
      case "awaiting_review":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">Awaiting Review</span>;
      case "approved":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200">Approved</span>;
      case "ready_to_send":
      case "pending_synchronization":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">Ready to Send</span>;
      case "sent":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">Sent (In Transit)</span>;
      case "received":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">Received by Clinic</span>;
      case "accepted":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">Accepted</span>;
      case "completed":
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-300">Completed</span>;
      default:
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-50 text-slate-600">{status}</span>;
    }
  }

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <PageHeader
          title="Smart Referral Management"
          description="Create offline referral drafts, approve clinical requests, and track distinct transmission and reception states."
        />
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="button button-primary flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus size={16} /> New Referral
        </button>
      </div>

      {message && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm flex items-center gap-2">
          <CheckCircle2 size={16} /> {message}
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex flex-wrap gap-2 mb-6 border-b border-slate-200 pb-2">
        {[
          { key: "all", label: "All Referrals" },
          { key: "drafts", label: "Drafts" },
          { key: "review", label: "Awaiting Review" },
          { key: "approved", label: "Approved" },
          { key: "transmitted", label: "Transmitted" },
          { key: "accepted", label: "Accepted / Done" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === tab.key
                ? "bg-teal-700 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            onClick={() => setStatusFilter(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Referrals List */}
      <div className="space-y-3">
        {filtered.map((r) => (
          <div
            key={r.id}
            className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:border-slate-300 transition-colors"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900 text-sm">
                  {r.patientName || "Patient Record"}
                </span>
                <span
                  className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${
                    r.priority === "emergency"
                      ? "bg-rose-100 text-rose-800"
                      : r.priority === "urgent"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {r.priority}
                </span>
                {getStatusBadge(r.status)}
              </div>
              <div className="text-xs text-slate-400">
                Created: {new Date(r.createdAt).toLocaleDateString()}
              </div>
            </div>

            <div className="text-sm text-slate-800 mb-2 font-medium">
              Reason: {r.reason}
            </div>
            {r.clinicalSummary && (
              <p className="text-xs text-slate-600 mb-3 bg-slate-50 p-2.5 rounded-lg">
                {r.clinicalSummary}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-slate-500 border-t border-slate-50">
              <div className="flex items-center gap-2">
                <ArrowRight size={14} className="text-teal-600" />
                <span>To: <strong>{r.receivingClinicName || "Specialist Clinic"}</strong></span>
              </div>

              {/* Status Action Buttons */}
              <div className="flex items-center gap-2">
                {r.status === "draft" && (
                  <button
                    type="button"
                    className="button button-secondary py-1 px-3 text-xs"
                    onClick={() => handleStatusTransition(r.id, "awaiting_review")}
                  >
                    Submit for Review
                  </button>
                )}
                {r.status === "awaiting_review" && canApprove && (
                  <button
                    type="button"
                    className="button button-primary py-1 px-3 text-xs flex items-center gap-1"
                    onClick={() => handleStatusTransition(r.id, "approved")}
                  >
                    <Check size={14} /> Approve Referral
                  </button>
                )}
                {r.status === "approved" && canSend && (
                  <button
                    type="button"
                    className="button button-primary py-1 px-3 text-xs flex items-center gap-1"
                    onClick={() => handleStatusTransition(r.id, "sent")}
                  >
                    <Send size={14} /> Send to Clinic
                  </button>
                )}
                {r.status === "sent" && (
                  <button
                    type="button"
                    className="button button-secondary py-1 px-3 text-xs"
                    onClick={() => handleStatusTransition(r.id, "received")}
                  >
                    Acknowledge Delivery
                  </button>
                )}
                {r.status === "received" && (
                  <button
                    type="button"
                    className="button button-primary py-1 px-3 text-xs"
                    onClick={() => handleStatusTransition(r.id, "accepted")}
                  >
                    Accept Referral
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="bg-white p-12 text-center rounded-xl border border-slate-200 text-slate-400">
            <FileText size={40} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">No referrals found</p>
            <p className="text-xs">Create a new referral draft for inter-clinic patient transfer.</p>
          </div>
        )}
      </div>

      {/* CREATE REFERRAL MODAL */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Create Patient Referral</h2>
            <form onSubmit={handleCreateReferral} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Select Patient
                </label>
                <select
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
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
                  Receiving Clinic
                </label>
                <select
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                  value={receivingClinicName}
                  onChange={(e) => {
                    setReceivingClinicName(e.target.value);
                    setReceivingClinicId(
                      e.target.value.toLowerCase().replace(/\s+/g, "-"),
                    );
                  }}
                >
                  <option value="District General Hospital">District General Hospital</option>
                  <option value="Regional Maternal Health Centre">Regional Maternal Health Centre</option>
                  <option value="Community Tuberculosis Care Unit">Community Tuberculosis Care Unit</option>
                  <option value="Specialist Cardiology Care">Specialist Cardiology Care</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                    Priority Level
                  </label>
                  <select
                    className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as ReferralPriority)}
                  >
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                    <option value="emergency">Emergency</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                    Submission Mode
                  </label>
                  <div className="flex items-center gap-2 pt-2">
                    <label className="text-xs text-slate-700 cursor-pointer flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={submitAsDraft}
                        onChange={(e) => setSubmitAsDraft(e.target.checked)}
                        className="rounded text-teal-600"
                      />
                      <span>Save as Draft</span>
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Reason for Referral *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Uncontrolled hypertension despite triple therapy"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Clinical Summary & Notes
                </label>
                <textarea
                  rows={3}
                  placeholder="Summarize relevant history, investigation findings, and diagnostic queries."
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={clinicalSummary}
                  onChange={(e) => setClinicalSummary(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  {submitAsDraft ? "Save Draft" : "Submit Referral"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

