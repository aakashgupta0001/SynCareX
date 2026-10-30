import { useEffect, useState } from "react";
import {
  AlertCircle,
  Bell,
  Calendar,
  CheckCircle,
  Clock,
  History,
  Phone,
  Plus,
  RotateCcw,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { patientRepository } from "../repositories/patientRepository";
import type { LocalPatient } from "../database/types";
import { followUpRepository } from "../repositories/followUpRepository";
import type { FollowUpPriority, FollowUpRecord } from "../database/types";
import { useDismissableModal } from "../hooks/useDismissableModal";

export function FollowUpsPage() {
  const [followups, setFollowups] = useState<FollowUpRecord[]>([]);
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [activeTab, setActiveTab] = useState<"today" | "overdue" | "all" | "completed">("today");

  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  useDismissableModal(showScheduleModal, () => setShowScheduleModal(false));
  useDismissableModal(showRescheduleModal, () => setShowRescheduleModal(false));
  useDismissableModal(showCompleteModal, () => setShowCompleteModal(false));
  const [selectedFollowUp, setSelectedFollowUp] = useState<FollowUpRecord | null>(null);

  // New follow-up form
  const [patientId, setPatientId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [reason, setReason] = useState("");
  const [priority, setPriority] = useState<FollowUpPriority>("routine");
  const [contactPreference, setContactPreference] = useState("phone");
  const [notes, setNotes] = useState("");

  // Reschedule form
  const [newScheduledAt, setNewScheduledAt] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");

  // Complete form
  const [outcome, setOutcome] = useState("");

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [fList, pList] = await Promise.all([
        followUpRepository.listAll(),
        patientRepository.listAllLocal(),
      ]);
      setFollowups(fList);
      setPatients(pList);
      if (pList.length > 0 && !patientId) {
        setPatientId(pList[0].id);
      }
    } catch (err) {
      // Never log the error object: it is not guaranteed to be free of
      // patient information. Surface a recoverable message instead.
      setError(
        err instanceof Error
          ? `Follow-ups could not be loaded: ${err.message}`
          : "Follow-ups could not be loaded from this device.",
      );
    }
  }

  async function handleCreateFollowUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    if (!patientId || !scheduledAt || !reason.trim()) {
      setError("Please fill in all required fields.");
      return;
    }

    try {
      await followUpRepository.createFollowUp({
        patientId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        reason,
        priority,
        contactPreference,
        notes,
      });

      setMessage("Follow-up appointment scheduled successfully.");
      setShowScheduleModal(false);
      setReason("");
      setNotes("");
      setScheduledAt("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create follow-up.");
    }
  }

  async function handleReschedule(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFollowUp || !newScheduledAt || !rescheduleReason.trim()) return;

    try {
      await followUpRepository.reschedule(
        selectedFollowUp.id,
        new Date(newScheduledAt).toISOString(),
        rescheduleReason,
      );
      setMessage("Follow-up appointment rescheduled.");
      setShowRescheduleModal(false);
      setSelectedFollowUp(null);
      setNewScheduledAt("");
      setRescheduleReason("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reschedule.");
    }
  }

  async function handleComplete(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFollowUp || !outcome.trim()) return;

    try {
      await followUpRepository.markCompleted(selectedFollowUp.id, outcome);
      setMessage("Follow-up appointment marked as completed.");
      setShowCompleteModal(false);
      setSelectedFollowUp(null);
      setOutcome("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete follow-up.");
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  const todayFollowUps = followups.filter(
    (f) => f.scheduledAt.startsWith(todayStr) && f.status !== "completed" && f.status !== "cancelled",
  );
  const overdueFollowUps = followups.filter(
    (f) => f.scheduledAt < nowIso && ["scheduled", "due", "rescheduled"].includes(f.status) && !f.scheduledAt.startsWith(todayStr),
  );
  const completedFollowUps = followups.filter((f) => f.status === "completed");

  const displayedList =
    activeTab === "today"
      ? todayFollowUps
      : activeTab === "overdue"
      ? overdueFollowUps
      : activeTab === "completed"
      ? completedFollowUps
      : followups;

  return (
    <div className="page-container">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <PageHeader
          title="Patient Follow-Up Manager"
          description="Schedule, monitor, and reschedule local clinic follow-ups with full audit history."
        />
        <button
          type="button"
          onClick={() => setShowScheduleModal(true)}
          className="button button-primary flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus size={16} /> Schedule Follow-Up
        </button>
      </div>

      {/* PRIVACY-PRESERVING IN-APP REMINDER BANNER */}
      {(todayFollowUps.length > 0 || overdueFollowUps.length > 0) && (
        <div className="mb-6 p-4 bg-teal-50/70 border border-teal-200 rounded-xl text-teal-900 flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            <span className="p-2 rounded-lg bg-teal-100 text-teal-700">
              <Bell size={20} />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Today's Clinic Care Reminders</h3>
              <p className="text-xs text-teal-800">
                You have {todayFollowUps.length} follow-up(s) scheduled for today
                {overdueFollowUps.length > 0 && ` and ${overdueFollowUps.length} overdue patient task(s)`}.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="text-xs font-semibold px-3 py-1.5 bg-teal-700 text-white rounded-lg hover:bg-teal-800 transition-colors"
            onClick={() => setActiveTab(overdueFollowUps.length > 0 ? "overdue" : "today")}
          >
            Review Appointments
          </button>
        </div>
      )}

      {message && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm flex items-center gap-2">
          <CheckCircle size={16} /> {message}
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* TABS */}
      <div className="flex border-b border-slate-200 mb-6 gap-2">
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "today"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("today")}
        >
          <Calendar size={16} /> Today ({todayFollowUps.length})
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "overdue"
              ? "border-rose-600 text-rose-700 font-bold"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("overdue")}
        >
          <Clock size={16} /> Overdue ({overdueFollowUps.length})
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "all"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("all")}
        >
          All Scheduled ({followups.length})
        </button>
        <button
          type="button"
          className={`px-4 py-2 font-medium text-sm border-b-2 -mb-px flex items-center gap-2 ${
            activeTab === "completed"
              ? "border-teal-600 text-teal-700"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
          onClick={() => setActiveTab("completed")}
        >
          <CheckCircle size={16} /> Completed ({completedFollowUps.length})
        </button>
      </div>

      {/* FOLLOW-UP LIST */}
      <div className="space-y-3">
        {displayedList.map((f) => {
          const isOverdue = f.scheduledAt < nowIso && ["scheduled", "due", "rescheduled"].includes(f.status);
          return (
            <div
              key={f.id}
              className={`bg-white p-5 rounded-xl border shadow-sm transition-colors ${
                isOverdue ? "border-rose-200 bg-rose-50/20" : "border-slate-200"
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900 text-sm">
                    {f.patientName || "Patient"}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                      f.priority === "urgent"
                        ? "bg-rose-100 text-rose-800"
                        : f.priority === "high"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {f.priority}
                  </span>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                      f.status === "completed"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : isOverdue
                        ? "bg-rose-50 text-rose-700 border border-rose-200"
                        : "bg-blue-50 text-blue-700 border border-blue-200"
                    }`}
                  >
                    {isOverdue && f.status !== "completed" ? "Overdue" : f.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <Clock size={13} />
                  <span>Scheduled: {new Date(f.scheduledAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
              </div>

              <div className="text-sm text-slate-800 mb-2 font-medium">
                Reason: {f.reason}
              </div>
              {f.notes && <p className="text-xs text-slate-600 mb-2">{f.notes}</p>}

              {f.outcome && (
                <div className="bg-emerald-50/60 p-2.5 rounded-lg border border-emerald-100 text-xs text-emerald-900 mb-2">
                  <strong>Outcome:</strong> {f.outcome}
                </div>
              )}

              {/* Reschedule history disclosure */}
              {f.rescheduleHistory.length > 0 && (
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-xs text-slate-600 mb-3 space-y-1">
                  <div className="font-semibold text-slate-500 uppercase flex items-center gap-1 text-[10px]">
                    <History size={12} /> Reschedule History ({f.rescheduleHistory.length})
                  </div>
                  {f.rescheduleHistory.map((h, i) => (
                    <div key={i} className="text-[11px] text-slate-500">
                      • Previously scheduled for {new Date(h.previousScheduledAt).toLocaleDateString()} — Reason: "{h.reason}"
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-slate-500 border-t border-slate-50">
                <div className="flex items-center gap-1">
                  <Phone size={13} /> Contact: {f.contactPreference || "Phone"}
                </div>

                {f.status !== "completed" && f.status !== "cancelled" && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="button button-secondary py-1 px-3 text-xs flex items-center gap-1"
                      onClick={() => {
                        setSelectedFollowUp(f);
                        setShowRescheduleModal(true);
                      }}
                    >
                      <RotateCcw size={12} /> Reschedule
                    </button>
                    <button
                      type="button"
                      className="button button-primary py-1 px-3 text-xs flex items-center gap-1"
                      onClick={() => {
                        setSelectedFollowUp(f);
                        setShowCompleteModal(true);
                      }}
                    >
                      <CheckCircle size={12} /> Complete
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {displayedList.length === 0 && (
          <div className="bg-white p-12 text-center rounded-xl border border-slate-200 text-slate-400">
            <Calendar size={40} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">No follow-ups in this view</p>
            <p className="text-xs">Schedule new patient follow-ups to track continuity of clinical care.</p>
          </div>
        )}
      </div>

      {/* SCHEDULE MODAL */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Schedule Patient Follow-Up</h2>
            <form onSubmit={handleCreateFollowUp} className="space-y-3">
              <div>
                <label htmlFor="followup-patient" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Patient *
                </label>
                <select
                  id="followup-patient"
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
                <label htmlFor="followup-scheduled-at" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Scheduled Date & Time *
                </label>
                <input
                  id="followup-scheduled-at"
                  type="datetime-local"
                  required
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="followup-reason" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Reason for Follow-Up *
                </label>
                <input
                  id="followup-reason"
                  type="text"
                  required
                  placeholder="e.g. 2-week blood pressure check & medication review"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="followup-priority" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                    Priority
                  </label>
                  <select
                    id="followup-priority"
                    className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as FollowUpPriority)}
                  >
                    <option value="routine">Routine</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="followup-contact-preference" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                    Contact Preference
                  </label>
                  <select
                    id="followup-contact-preference"
                    className="w-full p-2 border border-slate-300 rounded-lg text-sm bg-white"
                    value={contactPreference}
                    onChange={(e) => setContactPreference(e.target.value)}
                  >
                    <option value="phone">Phone Call</option>
                    <option value="in_person">In-Person Visit</option>
                    <option value="asha_visit">ASHA Home Visit</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="followup-notes" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Clinical Notes
                </label>
                <textarea
                  id="followup-notes"
                  rows={2}
                  placeholder="Specific parameters to monitor..."
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowScheduleModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  Schedule Appointment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RESCHEDULE MODAL */}
      {showRescheduleModal && selectedFollowUp && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Reschedule Follow-Up</h2>
            <p className="text-xs text-slate-600">
              Rescheduling for <strong>{selectedFollowUp.patientName}</strong>. Previous appointment: {new Date(selectedFollowUp.scheduledAt).toLocaleString()}.
            </p>
            <form onSubmit={handleReschedule} className="space-y-3">
              <div>
                <label htmlFor="reschedule-scheduled-at" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  New Date & Time *
                </label>
                <input
                  id="reschedule-scheduled-at"
                  type="datetime-local"
                  required
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={newScheduledAt}
                  onChange={(e) => setNewScheduledAt(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="reschedule-reason" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Reason for Rescheduling *
                </label>
                <input
                  id="reschedule-reason"
                  type="text"
                  required
                  placeholder="e.g. Patient traveling out of district"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={rescheduleReason}
                  onChange={(e) => setRescheduleReason(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowRescheduleModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  Confirm Reschedule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* COMPLETE MODAL */}
      {showCompleteModal && selectedFollowUp && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">Complete Follow-Up</h2>
            <p className="text-xs text-slate-600">
              Record completion outcome for <strong>{selectedFollowUp.patientName}</strong> ({selectedFollowUp.reason}).
            </p>
            <form onSubmit={handleComplete} className="space-y-3">
              <div>
                <label htmlFor="followup-outcome" className="block text-xs font-semibold text-slate-700 uppercase mb-1">
                  Clinical Outcome & Notes *
                </label>
                <textarea
                  id="followup-outcome"
                  rows={3}
                  required
                  placeholder="e.g. Blood pressure within normal range (118/76). Patient adherent to medication."
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  className="button button-secondary py-2 px-4 text-xs"
                  onClick={() => setShowCompleteModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary py-2 px-4 text-xs"
                >
                  Mark Completed
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
