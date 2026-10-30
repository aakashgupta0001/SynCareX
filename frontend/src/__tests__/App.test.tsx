import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { db } from "../database/db";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository } from "../repositories/syncRepository";
import { AuthProvider } from "../services/auth";
import { lockLocalVault, unlockLocalVault } from "../security/localVault";
import {
  resetWorkspace,
  setOnline,
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
});
