import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { db } from "../database/db";
import { allergyRepository, clinicalNoteRepository } from "../repositories/consultationRepository";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository } from "../repositories/syncRepository";
import { AuthProvider } from "../services/auth";
import { lockLocalVault, unlockLocalVault } from "../security/localVault";
import {
  resetWorkspace,
  setOnline,
  syntheticPatient,
  testPassword,
  testUser,
} from "./helpers";

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function signInOffline() {
  renderApp();
  fireEvent.change(screen.getByLabelText("Work email"), {
    target: { value: testUser.email },
  });
  fireEvent.change(screen.getByLabelText("Password / local vault passphrase"), {
    target: { value: testPassword },
  });
  fireEvent.click(screen.getByRole("button", { name: /unlock local workspace/i }));
  await screen.findByRole("heading", { name: "Good day" });
}

describe("offline-first workspace", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
    // The workspace starts locked, exactly as it does after a page load.
    lockLocalVault();
  });

  afterEach(() => {
    cleanup();
    lockLocalVault();
    vi.unstubAllGlobals();
  });

  it("unlocks offline, registers a patient, and keeps it queued and readable after a restart", async () => {
    await signInOffline();

    fireEvent.click(screen.getByRole("link", { name: "Patients" }));
    await screen.findByRole("heading", { name: "Patient directory" });
    fireEvent.click(screen.getByRole("link", { name: "Register patient" }));
    await screen.findByRole("heading", { name: "Register a patient" });

    fireEvent.change(screen.getByLabelText("Full name *"), {
      target: { value: "Synthetic Test Patient" },
    });
    fireEvent.change(screen.getByLabelText("Estimated age (if DOB unknown)"), {
      target: { value: "34" },
    });
    fireEvent.change(screen.getByLabelText("Village"), {
      target: { value: "Demo Village" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save patient/i }));

    // The profile opens with an honest local-save message.
    await screen.findByRole("heading", { name: "Synthetic Test Patient" });
    expect(
      (await screen.findAllByText(/Saved securely on this device/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/then confirmed by the server/i)).toBeNull();

    const records = await patientRepository.listLocal();
    expect(records.total).toBe(1);
    const operations = await syncRepository.getPending(testUser.id);
    expect(operations).toHaveLength(1);
    expect(operations[0].entityType).toBe("patient");
    expect(operations[0].status).toBe("pending");
    expect(JSON.stringify(await db.patients.toArray())).not.toContain(
      "Synthetic Test Patient",
    );

    // Reopening the browser requires the passphrase again, and the record
    // and its queued operation are both still there.
    lockLocalVault();
    await unlockLocalVault(testUser.email, testPassword);
    expect((await patientRepository.getLocal(records.items[0].id))?.fullName).toBe(
      "Synthetic Test Patient",
    );
    expect(await syncRepository.getPending(testUser.id)).toHaveLength(1);
  });

  it("shows waiting-to-sync state in the directory and the sync centre, never 'synced'", async () => {
    await signInOffline();
    await patientRepository.createLocal({
      fullName: "Queued Synthetic Patient",
      dateOfBirth: null,
      estimatedAge: 51,
      gender: "",
      contactPhone: "",
      address: "",
      village: "Queue Village",
      emergencyContactName: "",
      emergencyContactPhone: "",
      relevantHistory: "",
      allergies: [],
    });

    fireEvent.click(screen.getByRole("link", { name: "Patients" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Waiting to sync")).toBeTruthy();
    expect(within(table).queryByText("Synced")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Sync center" }));
    await screen.findByRole("heading", { name: "Sync center" });
    expect(await screen.findByText(/create patient/i)).toBeTruthy();
    // Offline, the sync control is unavailable rather than pretending to work.
    expect(
      screen.getByRole("button", { name: /sync now/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("edits and marks an allergy entered in error from the patient profile", async () => {
    await signInOffline();
    const patient = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Clinical Correction Patient",
    });
    const allergy = await allergyRepository.createLocal({
      patientId: patient.id,
      substance: "Synthetic allergen",
      reaction: "Rash",
      severity: "mild",
    });

    fireEvent.click(screen.getByRole("link", { name: "Patients" }));
    fireEvent.click(
      await screen.findByRole("link", { name: `Open ${patient.fullName}` }),
    );
    await screen.findByRole("heading", { name: patient.fullName });
    expect(await screen.findByText("Synthetic allergen")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit allergy Synthetic allergen" }),
    );
    fireEvent.change(screen.getByLabelText("Substance"), {
      target: { value: "Corrected allergen" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(
      await screen.findByText(/updated on this device and queued/i),
    ).toBeTruthy();

    const archiveButton = screen.getByRole("button", {
      name: /mark allergy .* entered in error/i,
    });
    await waitFor(() => expect(archiveButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(archiveButton);
    fireEvent.change(
      screen.getByLabelText(/Reason for marking entered in error/),
      { target: { value: "Wrong patient record." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /confirm entered in error/i }),
    );
    expect(
      await screen.findByText(/marked entered in error, retained/i),
    ).toBeTruthy();

    const retained = await allergyRepository.listByPatientLocal(patient.id);
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe(allergy.id);
    expect(retained[0].substance).toBe("Corrected allergen");
    expect(retained[0].enteredInErrorReason).toBe("Wrong patient record.");
  });

  it("rejects a registration without an age or date of birth", async () => {
    await signInOffline();
    fireEvent.click(screen.getByRole("link", { name: "Register patient" }));
    await screen.findByRole("heading", { name: "Register a patient" });
    fireEvent.change(screen.getByLabelText("Full name *"), {
      target: { value: "Synthetic Patient" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save patient/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter a date of birth or an estimated age.",
    );
    expect((await patientRepository.listLocal()).total).toBe(0);
  });

  it("opens the AI workspace while offline without blocking the clinical workspace", async () => {
    await signInOffline();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Local engine is offline.")));

    fireEvent.click(screen.getByRole("link", { name: "AI workspace" }));
    await screen.findByRole("heading", { name: "AI workspace" });
    expect(await screen.findByRole("heading", { name: "Local patient-history retrieval" })).toBeTruthy();
    expect(screen.getByText(/optional; patient care workflows are not blocked/)).toBeTruthy();
  });

  it("generates a source-linked summary and adds it to the record only after review", async () => {
    await signInOffline();
    const patient = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Summary Patient",
    });
    await allergyRepository.createLocal({
      patientId: patient.id,
      substance: "Penicillin",
      reaction: "Rash",
      severity: "moderate",
    });

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    let summaryRequest: { new_source: string; history: string[] } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/status")) {
          return json({
            ready: true,
            token_configured: true,
            operating_system: "Test OS",
            processor: "Test CPU",
            logical_cores: 4,
            accelerator_note: "CPU only",
            model_directory: "models",
            total_ram_mb: 8192,
            available_ram_mb: 4096,
            free_disk_mb: 10000,
            runtimes: {},
          });
        }
        if (url.endsWith("/api/v1/models")) return json([]);
        if (url.endsWith("/api/v1/summaries")) {
          summaryRequest = JSON.parse(String(init?.body));
          return json({
            items: [
              { section: "presenting_complaint", text: "Fever for 3 days", sources: ["S1"], support: "ok" },
              { section: "allergies", text: "Penicillin allergy (rash)", sources: ["H1"], support: "ok" },
            ],
            source_lines: [
              { id: "S1", text: "Fever since 3 days." },
              { id: "H1", text: "Recorded allergy: Penicillin; reaction: Rash; severity: moderate" },
            ],
            model_id: "qwen-0.5b-q4",
            dropped: 0,
            requires_review: true,
          });
        }
        throw new Error("Offline in this test.");
      }),
    );

    fireEvent.click(screen.getByRole("link", { name: "AI workspace" }));
    await screen.findByRole("heading", { name: "AI workspace" });
    fireEvent.change(await screen.findByLabelText("Local patient"), {
      target: { value: patient.id },
    });
    fireEvent.change(screen.getByLabelText("Source text"), {
      target: { value: "Fever since 3 days." },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate ai clinical summary/i }));

    expect(await screen.findByDisplayValue(/Presenting complaint:/)).toBeTruthy();
    // The allergy was never mentioned in the visit but still reached the model.
    expect(summaryRequest!.history.some((line) => line.includes("Penicillin"))).toBe(true);
    expect(summaryRequest!.new_source).toBe("Fever since 3 days.");

    const add = screen.getByRole("button", { name: /add summary to patient record/i });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have reviewed this summary/));
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
    fireEvent.click(add);

    expect(await screen.findByText(/Summary added to Summary Patient's record/)).toBeTruthy();
    const notes = await clinicalNoteRepository.listByPatientLocal(patient.id);
    expect(notes.some((note) => note.body.includes("Fever for 3 days [S1]"))).toBe(true);
    const queued = await db.syncOperations.toArray();
    expect(queued.some((operation) => operation.entityType === "clinicalNote")).toBe(true);
  });

  it("exposes accessible names for Phase 6 form controls", async () => {
    await signInOffline();
    await patientRepository.createLocal({
      fullName: "Accessible Name Patient",
      dateOfBirth: null,
      estimatedAge: 38,
      gender: "",
      contactPhone: "",
      address: "",
      village: "Accessibility Village",
      emergencyContactName: "",
      emergencyContactPhone: "",
      relevantHistory: "",
      allergies: [],
    });

    fireEvent.click(screen.getByRole("link", { name: "AI workspace" }));
    await screen.findByRole("heading", { name: "AI workspace" });
    expect(await screen.findByLabelText("Local patient")).toBeTruthy();
    expect(await screen.findByLabelText("Optional text search")).toBeTruthy();
    expect(await screen.findByLabelText("Source text")).toBeTruthy();
    expect(await screen.findByLabelText("Local extraction model")).toBeTruthy();
    const documentInput = screen.getByLabelText("Choose an image or PDF");
    const cameraInput = screen.getByLabelText("Or capture a document with your camera");
    expect(documentInput.getAttribute("accept")).toContain("application/pdf");
    expect(cameraInput.getAttribute("accept")).toBe("image/*");
    expect(cameraInput.getAttribute("capture")).toBe("environment");

    fireEvent.click(screen.getByRole("link", { name: "Follow-ups" }));
    fireEvent.click(screen.getByRole("button", { name: /schedule follow-up/i }));
    expect(screen.getByLabelText("Patient *")).toBeTruthy();
    expect(screen.getByLabelText("Scheduled Date & Time *")).toBeTruthy();
    expect(screen.getByLabelText("Reason for Follow-Up *")).toBeTruthy();
    expect(screen.getByLabelText("Priority")).toBeTruthy();
    expect(screen.getByLabelText("Contact Preference")).toBeTruthy();
    expect(screen.getByLabelText("Clinical Notes")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Emergency passport" }));
    expect(screen.getByLabelText("Select Local Patient")).toBeTruthy();
    expect(screen.getByLabelText("Validity Duration")).toBeTruthy();
    expect(screen.getByLabelText("Consent Notes")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Data Minimization: Essential Fields Only" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /verify & scan/i }));
    expect(screen.getByLabelText("Enter or Scan QR Token")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Referrals" }));
    fireEvent.click(screen.getByRole("button", { name: /new referral/i }));
    expect(screen.getByLabelText("Select Patient")).toBeTruthy();
    expect(screen.getByLabelText("Receiving Clinic")).toBeTruthy();
    expect(screen.getByLabelText("Priority Level")).toBeTruthy();
    expect(screen.getByLabelText("Save as Draft")).toBeTruthy();
    expect(screen.getByLabelText("Reason for Referral *")).toBeTruthy();
    expect(screen.getByLabelText("Clinical Summary & Notes")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Clinic exchange" }));
    fireEvent.click(screen.getByRole("button", { name: /prepare export/i }));
    expect(screen.getByLabelText("Select Patient *")).toBeTruthy();
    expect(screen.getByLabelText("Target Clinic Name *")).toBeTruthy();
    expect(screen.getByLabelText("Target Clinic ID *")).toBeTruthy();
    expect(screen.getByLabelText("Transfer Consent & Purpose *")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /offline lan \/ file exchange/i }));
    expect(screen.getByLabelText("Select Package File")).toBeTruthy();
    expect(screen.getByLabelText("Or Paste Package JSON")).toBeTruthy();
    expect(screen.getByLabelText("Select Patient")).toBeTruthy();
    expect(screen.getByLabelText("Target Clinic Name")).toBeTruthy();
    expect(screen.queryByLabelText("Select patient for FHIR export")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /fhir r4 interop/i }));
    expect(screen.getByLabelText("Select patient for FHIR export")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /paired clinics/i }));
    fireEvent.click(screen.getByRole("button", { name: /pair new clinic/i }));
    expect(screen.getByLabelText("Clinic Name *")).toBeTruthy();
    expect(screen.getByLabelText("Mutual Pairing Code *")).toBeTruthy();
  });
});
