import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Plus, Save, ShieldCheck } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import type { LocalPatient } from "../database/types";
import { patientRepository } from "../repositories/patientRepository";
import { syncNow } from "../services/syncEngine";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";

interface PatientDraft {
  fullName: string;
  dateOfBirth: string;
  estimatedAge: string;
  gender: string;
  contactPhone: string;
  address: string;
  village: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  relevantHistory: string;
  allergies: string;
}

const emptyDraft: PatientDraft = {
  fullName: "",
  dateOfBirth: "",
  estimatedAge: "",
  gender: "",
  contactPhone: "",
  address: "",
  village: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  relevantHistory: "",
  allergies: "",
};

function draftFromPatient(patient: LocalPatient): PatientDraft {
  return {
    fullName: patient.fullName,
    dateOfBirth: patient.dateOfBirth ?? "",
    estimatedAge: patient.estimatedAge === null ? "" : String(patient.estimatedAge),
    gender: patient.gender,
    contactPhone: patient.contactPhone,
    address: patient.address,
    village: patient.village,
    emergencyContactName: patient.emergencyContactName,
    emergencyContactPhone: patient.emergencyContactPhone,
    relevantHistory: patient.relevantHistory,
    allergies: patient.allergies.join(", "),
  };
}

export function PatientFormPage() {
  const { patientId } = useParams();
  const editing = Boolean(patientId);
  const { session } = useAuth();
  const { apiUsable } = useConnectivityState();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState<PatientDraft>(emptyDraft);
  const [patient, setPatient] = useState<LocalPatient | null>(null);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void patientRepository.getLocal(patientId).then((local) => {
      if (active) {
        if (local) {
          setPatient(local);
          setDraft(draftFromPatient(local));
        } else {
          setError("This patient record is not available in the local encrypted vault.");
        }
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load patient record.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [patientId]);

  function setField<K extends keyof PatientDraft>(field: K, value: PatientDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError("");
    setError("");
    if (!draft.dateOfBirth && !draft.estimatedAge) {
      setFieldError("Enter a date of birth or an estimated age.");
      return;
    }
    if (draft.dateOfBirth && draft.estimatedAge) {
      setFieldError("Enter either a date of birth or an estimated age, not both.");
      return;
    }
    const age = draft.estimatedAge ? Number(draft.estimatedAge) : null;
    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) {
      setFieldError("Estimated age must be a whole number between 0 and 130.");
      return;
    }
    const allergies = draft.allergies.split(",").map((item) => item.trim()).filter(Boolean);
    const values = {
      fullName: draft.fullName.trim(),
      dateOfBirth: draft.dateOfBirth || null,
      estimatedAge: age,
      gender: draft.gender,
      contactPhone: draft.contactPhone.trim(),
      address: draft.address.trim(),
      village: draft.village.trim(),
      emergencyContactName: draft.emergencyContactName.trim(),
      emergencyContactPhone: draft.emergencyContactPhone.trim(),
      relevantHistory: draft.relevantHistory.trim(),
      allergies,
    };
    setSaving(true);
    try {
      let saved: LocalPatient;
      if (patient) {
        saved = await patientRepository.updateLocal(patient.id, values);
      } else {
        saved = await patientRepository.createLocal(values);
      }
      // The record is already durable at this point. Synchronization is an
      // attempt on top of a completed save, never a condition of it.
      let notice =
        "Saved securely on this device. Waiting for internet connection to synchronize.";
      if (apiUsable && session?.mode === "online") {
        const result = await syncNow(session.user.id);
        if (result.skipped) {
          notice = `Saved securely on this device. ${result.message}`;
        } else if (result.conflicts) {
          notice = `Saved on this device. ${result.conflicts} change(s) need clinician review in Conflict review.`;
        } else if (result.failed) {
          notice = `Saved on this device. ${result.acknowledged} operation(s) confirmed by the server; ${result.failed} stay queued for retry.`;
        } else {
          notice = `Saved on this device, then confirmed by the server (${result.acknowledged} operation(s)).`;
        }
      }
      navigate(`/patients/${saved.id}`, { replace: true, state: { notice } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Patient record could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Opening encrypted patient record..." />;
  if (editing && error && !patient) return <ErrorState>{error}</ErrorState>;

  const successNotice = (location.state as { notice?: string } | null)?.notice;
  return (
    <>
      <Link className="back-link" to={patient ? `/patients/${patient.id}` : "/patients"}><ArrowLeft size={16} /> {patient ? "Back to patient profile" : "Back to directory"}</Link>
      <PageHeader
        eyebrow="PATIENT RECORD"
        title={patient ? "Update patient details" : "Register a patient"}
        description="The record is encrypted and persisted on this device before any network request."
      />
      {successNotice && <div className="notice notice-success" role="status"><Check size={17} />{successNotice}</div>}
      {error && <ErrorState>{error}</ErrorState>}
      {fieldError && <div className="form-error" role="alert">{fieldError}</div>}
      <form className="form-card" onSubmit={(event) => void submit(event)}>
        <div className="form-section-heading"><span className="form-section-number">01</span><div><h2>Basic information</h2><p>Record the minimum details needed to identify this patient.</p></div></div>
        <div className="form-grid">
          <label className="form-field form-span-2"><span>Full name <b>*</b></span><input autoComplete="name" maxLength={160} onChange={(event) => setField("fullName", event.target.value)} required value={draft.fullName} /></label>
          <label className="form-field"><span>Date of birth</span><input max={new Date().toISOString().slice(0, 10)} onChange={(event) => { setField("dateOfBirth", event.target.value); if (event.target.value) setField("estimatedAge", ""); }} type="date" value={draft.dateOfBirth} /></label>
          <label className="form-field"><span>Estimated age (if DOB unknown)</span><input inputMode="numeric" max="130" min="0" onChange={(event) => { setField("estimatedAge", event.target.value); if (event.target.value) setField("dateOfBirth", ""); }} placeholder="Years" type="number" value={draft.estimatedAge} /></label>
          <label className="form-field"><span>Gender <small>(optional)</small></span><select onChange={(event) => setField("gender", event.target.value)} value={draft.gender}><option value="">Not recorded</option><option>Female</option><option>Male</option><option>Other</option><option>Prefer not to disclose</option></select></label>
          <label className="form-field"><span>Contact phone</span><input autoComplete="tel" maxLength={32} onChange={(event) => setField("contactPhone", event.target.value)} type="tel" value={draft.contactPhone} /></label>
        </div>
        <div className="form-section-heading"><span className="form-section-number">02</span><div><h2>Location & emergency contact</h2><p>Optional contact details for care coordination.</p></div></div>
        <div className="form-grid">
          <label className="form-field"><span>Village</span><input maxLength={120} onChange={(event) => setField("village", event.target.value)} value={draft.village} /></label>
          <label className="form-field"><span>Emergency contact name</span><input maxLength={160} onChange={(event) => setField("emergencyContactName", event.target.value)} value={draft.emergencyContactName} /></label>
          <label className="form-field"><span>Emergency contact phone</span><input maxLength={32} onChange={(event) => setField("emergencyContactPhone", event.target.value)} type="tel" value={draft.emergencyContactPhone} /></label>
          <label className="form-field form-span-2"><span>Address</span><textarea maxLength={2000} onChange={(event) => setField("address", event.target.value)} rows={2} value={draft.address} /></label>
        </div>
        <div className="form-section-heading"><span className="form-section-number">03</span><div><h2>Clinical context</h2><p>Record known history only; this form does not provide diagnostic advice.</p></div></div>
        <div className="form-grid">
          <label className="form-field form-span-2"><span>Known allergies <small>(separate with commas)</small></span><input maxLength={1000} onChange={(event) => setField("allergies", event.target.value)} placeholder="Use “unknown” when it has not been verified" value={draft.allergies} /></label>
          <label className="form-field form-span-2"><span>Relevant medical history</span><textarea maxLength={10000} onChange={(event) => setField("relevantHistory", event.target.value)} rows={4} value={draft.relevantHistory} /></label>
        </div>
        <div className="form-note"><ShieldCheck size={17} /><span>Encrypted locally with AES-GCM. This device's key is derived from your local sign-in secret and is never saved in browser storage.</span></div>
        <div className="form-actions"><Link className="button button-quiet" to={patient ? `/patients/${patient.id}` : "/patients"}>Cancel</Link><button className="button button-primary" disabled={saving} type="submit">{saving ? "Saving locally..." : patient ? <><Save size={16} /> Save changes</> : <><Plus size={17} /> Save patient</>}</button></div>
      </form>
    </>
  );
}
