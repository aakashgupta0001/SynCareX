import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, setAccessToken } from "../services/api";
import { portalClient } from "../services/portal";
import { PatientPortalPage } from "../pages/PatientPortalPage";
import { PatientProfilePage } from "../pages/PatientProfilePage";
import { AuthProvider } from "../services/auth";
import { patientRepository } from "../repositories/patientRepository";
import { resetWorkspace, setOnline } from "./helpers";

const PORTAL_TOKEN_KEY = "syncarex_portal_access_token";

const portalSummary = {
  patient: {
    full_name: "Portal Patient",
    patient_number: "PN-0001",
    date_of_birth: "1989-04-12",
    estimated_age: null,
    gender: "Female",
  },
  allergies: [
    { substance: "Penicillin", reaction: "Rash", severity: "moderate" },
  ],
  medications: [
    { name: "Amoxicillin", dose: "500 mg", frequency: "3x daily" },
  ],
  observations: [
    {
      label: "Blood pressure",
      value: "120/80",
      unit: "mmHg",
      recorded_at: "2026-10-01T09:00:00Z",
    },
    {
      label: "Temperature",
      value: "37.2",
      unit: "°C",
      recorded_at: "2026-10-02T09:00:00Z",
    },
  ],
  consultations: [
    { occurred_at: "2026-09-20T10:00:00Z", reason: "Fever review", status: "completed" },
  ],
};

const loginPayload = {
  access_token: "portal-access-token",
  patient: {
    id: "11111111-1111-1111-1111-111111111111",
    full_name: "Portal Patient",
    patient_number: "PN-0001",
    clinic_name: "Riverbend Clinic",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchRoute {
  match: (url: string, init: RequestInit) => boolean;
  respond: () => Response;
}

function routeFetch(routes: FetchRoute[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    for (const route of routes) {
      if (route.match(target, init)) return route.respond();
    }
    throw new Error(`Unexpected fetch: ${init.method ?? "GET"} ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const isPost = (url: string, init: RequestInit, suffix: string) =>
  (init.method ?? "GET") === "POST" && url.includes(suffix);

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={["/portal"]}>
      <PatientPortalPage />
    </MemoryRouter>,
  );
}

async function openEnrollForm() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: /first time\? activate with your enrollment code/i,
    }),
  );
  await screen.findByRole("heading", { name: /activate your portal access/i });
}

beforeEach(() => {
  localStorage.clear();
  setAccessToken(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAccessToken(null);
  localStorage.clear();
});

describe("portal client", () => {
  it("stores the portal token under its own key and keeps staff token state untouched", async () => {
    setAccessToken("staff-token-1");
    const fetchMock = routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/login"),
        respond: () => jsonResponse(loginPayload),
      },
      {
        match: (url, init) =>
          (init.method ?? "GET") === "GET" && url.includes("/portal/me"),
        respond: () => jsonResponse(portalSummary),
      },
      {
        match: (url, init) =>
          (init.method ?? "GET") === "GET" && url.includes("/patients?"),
        respond: () =>
          jsonResponse({ items: [], page: 1, page_size: 100, total: 0, pages: 0 }),
      },
    ]);

    const result = await portalClient.login("patient@example.test", "portal-pass");
    expect(result.patient.full_name).toBe("Portal Patient");
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe("portal-access-token");

    await portalClient.getSummary();
    const meCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/portal/me") && (init as RequestInit).method === undefined,
    );
    expect(meCall).toBeTruthy();
    const meHeaders = new Headers((meCall![1] as RequestInit).headers);
    expect(meHeaders.get("Authorization")).toBe("Bearer portal-access-token");

    // The staff client still carries its own token; the portal login must
    // never have replaced it.
    await api.listPatients();
    const staffCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/patients?"),
    );
    const staffHeaders = new Headers((staffCall![1] as RequestInit).headers);
    expect(staffHeaders.get("Authorization")).toBe("Bearer staff-token-1");
  });

  it("sends the portal Bearer token from storage on /portal/me", async () => {
    localStorage.setItem(PORTAL_TOKEN_KEY, "stored-portal-token");
    const fetchMock = routeFetch([
      {
        match: (url) => url.includes("/portal/me"),
        respond: () => jsonResponse(portalSummary),
      },
    ]);

    await portalClient.getSummary();

    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBe("Bearer stored-portal-token");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/portal/me");
  });

  it("surfaces the server's detail message and status on failure", async () => {
    routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/login"),
        respond: () =>
          jsonResponse(
            { detail: "Too many failed attempts. Try again in 30 seconds." },
            423,
          ),
      },
    ]);

    await expect(
      portalClient.login("patient@example.test", "wrong"),
    ).rejects.toMatchObject({
      status: 423,
      message: "Too many failed attempts. Try again in 30 seconds.",
    });
    // A failed login must not leave a token behind.
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  it("returns 204 password changes without parsing a body", async () => {
    localStorage.setItem(PORTAL_TOKEN_KEY, "stored-portal-token");
    const fetchMock = routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/password"),
        respond: () => new Response(null, { status: 204 }),
      },
    ]);

    await expect(
      portalClient.changePassword("current-pass", "next-pass"),
    ).resolves.toBeUndefined();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      current_password: "current-pass",
      new_password: "next-pass",
    });
  });

  it("reports the staff endpoint as missing when no portal account exists", async () => {
    routeFetch([
      {
        match: (url) => url.includes("/patients/patient-1/portal-account"),
        respond: () => jsonResponse({ detail: "No portal account." }, 404),
      },
    ]);

    await expect(api.getPatientPortalAccount("patient-1")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("patient portal page", () => {
  it("enrolls with a staff code, then signs in and shows the dashboard", async () => {
    const fetchMock = routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/enroll"),
        respond: () =>
          jsonResponse({
            patient_id: "11111111-1111-1111-1111-111111111111",
            full_name: "Portal Patient",
            patient_number: "PN-0001",
          }),
      },
      {
        match: (url, init) => isPost(url, init, "/portal/login"),
        respond: () => jsonResponse(loginPayload),
      },
      {
        match: (url) => url.includes("/portal/me"),
        respond: () => jsonResponse(portalSummary),
      },
    ]);

    renderPortal();
    await openEnrollForm();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "patient@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Enrollment code"), {
      target: { value: "ENROLL-1234" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "portal-pass-1" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "portal-pass-1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /activate portal access/i }),
    );

    // Back on the login form with the email pre-filled and a success notice.
    expect((await screen.findByRole("status")).textContent).toMatch(
      /portal account is active/i,
    );
    expect(
      (screen.getByLabelText("Email") as HTMLInputElement).value,
    ).toBe("patient@example.test");
    const enrollBody = JSON.parse(
      fetchMock.mock.calls
        .find(([url, init]) => isPost(String(url), init, "/portal/enroll"))![1]
        .body as string,
    );
    expect(enrollBody).toEqual({
      email: "patient@example.test",
      enrollment_code: "ENROLL-1234",
      new_password: "portal-pass-1",
    });

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "portal-pass-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    const name = await screen.findByRole("heading", { name: "Portal Patient" });
    expect(name).toBeTruthy();
    expect(screen.getByText(/PN-0001/)).toBeTruthy();
    expect(
      screen.getAllByText(/read-only summary of your record/i).length,
    ).toBeGreaterThan(0);

    // Sections render with their contents.
    expect(screen.getByRole("heading", { name: "Allergies" })).toBeTruthy();
    expect(screen.getByText("Penicillin")).toBeTruthy();
    expect(screen.getByText(/Rash · moderate/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Current medications" }),
    ).toBeTruthy();
    expect(screen.getByText(/Amoxicillin/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Recent measurements" }),
    ).toBeTruthy();
    expect(screen.getByText(/Temperature: 37\.2 °C/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Recent consultations" }),
    ).toBeTruthy();
    expect(screen.getByText(/Fever review/)).toBeTruthy();

    // Measurements are newest first (Oct 2 before Oct 1).
    const body = document.body.textContent ?? "";
    expect(body.indexOf("Temperature")).toBeLessThan(
      body.indexOf("Blood pressure"),
    );

    // The portal token lives under its dedicated key.
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe("portal-access-token");
  });

  it("surfaces a wrong enrollment code without losing the form", async () => {
    routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/enroll"),
        respond: () =>
          jsonResponse({ detail: "Invalid enrollment code." }, 400),
      },
    ]);

    renderPortal();
    await openEnrollForm();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "patient@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Enrollment code"), {
      target: { value: "WRONG-CODE" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "portal-pass-1" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "portal-pass-1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /activate portal access/i }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Invalid enrollment code.",
    );
    // Still on the enroll form, inputs preserved for a retry.
    expect(
      screen.getByRole("button", { name: /activate portal access/i }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Email") as HTMLInputElement).value,
    ).toBe("patient@example.test");
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  it("shows the server's 423 lockout message on the login form", async () => {
    routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/login"),
        respond: () =>
          jsonResponse(
            { detail: "Too many failed attempts. Try again in 45 seconds." },
            423,
          ),
      },
    ]);

    renderPortal();
    await screen.findByRole("heading", {
      name: /sign in to your record summary/i,
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "patient@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Try again in 45 seconds.",
    );
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  it("shows a generic message on 401 and offers the enrollment path when the account is missing", async () => {
    routeFetch([
      {
        match: (url, init) => isPost(url, init, "/portal/login"),
        respond: () =>
          jsonResponse({ detail: "No portal account for this email." }, 401),
      },
    ]);

    renderPortal();
    await screen.findByRole("heading", {
      name: /sign in to your record summary/i,
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "stranger@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Email or password is incorrect.",
    );
    expect(screen.getByText(/may not be enrolled yet/i)).toBeTruthy();
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  it("renders every dashboard section from an empty record without crashing", async () => {
    localStorage.setItem(PORTAL_TOKEN_KEY, "stored-portal-token");
    routeFetch([
      {
        match: (url) => url.includes("/portal/me"),
        respond: () =>
          jsonResponse({
            patient: {
              full_name: "Minimal Patient",
              patient_number: "PN-0002",
              date_of_birth: null,
              estimated_age: null,
              gender: null,
            },
            allergies: [],
            medications: [],
            observations: [],
            consultations: [],
          }),
      },
    ]);

    renderPortal();

    expect(
      await screen.findByRole("heading", { name: "Minimal Patient" }),
    ).toBeTruthy();
    expect(screen.getByText(/Age not recorded/i)).toBeTruthy();
    expect(screen.getByText("No allergies recorded.")).toBeTruthy();
    expect(screen.getByText("No medications recorded.")).toBeTruthy();
    expect(screen.getByText("No measurements recorded.")).toBeTruthy();
    expect(screen.getByText("No consultations recorded.")).toBeTruthy();

    // Logging out clears the dedicated token and returns to sign-in.
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await screen.findByRole("heading", {
      name: /sign in to your record summary/i,
    });
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });

  it("drops an expired stored token onto the login form", async () => {
    localStorage.setItem(PORTAL_TOKEN_KEY, "stale-portal-token");
    routeFetch([
      {
        match: (url) => url.includes("/portal/me"),
        respond: () => jsonResponse({ detail: "Token expired." }, 401),
      },
    ]);

    renderPortal();

    await screen.findByRole("heading", {
      name: /sign in to your record summary/i,
    });
    expect(screen.getByRole("alert").textContent).toMatch(/session has expired/i);
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });
});

describe("staff patient portal card", () => {
  it("posts the email to the patient portal-account endpoint and shows the code once", async () => {
    setOnline(false);
    await resetWorkspace();
    const patient = await patientRepository.createLocal({
      fullName: "Enrollment Card Patient",
      dateOfBirth: null,
      estimatedAge: 41,
      gender: "",
      contactPhone: "",
      address: "",
      village: "Demo Village",
      emergencyContactName: "",
      emergencyContactPhone: "",
      relevantHistory: "",
      allergies: [],
    });

    const fetchMock = routeFetch([
      {
        match: (url, init) =>
          isPost(url, init, `/patients/${patient.id}/portal-account`),
        respond: () =>
          jsonResponse(
            {
              patient_id: patient.id,
              email: "patient@example.test",
              enrollment_code: "PORTAL-CODE-9",
              enrollment_code_expires_at: "2026-11-07T00:00:00Z",
            },
            201,
          ),
      },
    ]);

    render(
      <MemoryRouter initialEntries={[`/patients/${patient.id}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/patients/:patientId" element={<PatientProfilePage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Enrollment Card Patient" });

    // No portal account yet (the offline lookup is skipped, default state).
    expect(screen.getByText(/no portal account for this patient yet/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Patient email"), {
      target: { value: "patient@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /enable patient portal/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("PORTAL-CODE-9"),
      ).toBeTruthy(),
    );
    const postCall = fetchMock.mock.calls.find(([url, init]) =>
      isPost(String(url), init, `/patients/${patient.id}/portal-account`),
    );
    expect(postCall).toBeTruthy();
    expect(String(postCall![0])).toContain(
      `/patients/${patient.id}/portal-account`,
    );
    expect(JSON.parse(postCall![1].body as string)).toEqual({
      email: "patient@example.test",
    });
    expect(screen.getByText(/shown once\. give it to the patient/i)).toBeTruthy();
    expect(
      screen.getByText(/awaiting enrollment \(code not yet used\)/i),
    ).toBeTruthy();
  });

  it("tolerates a 404 when checking for an existing portal account", async () => {
    routeFetch([
      {
        match: (url) => url.includes("/patients/no-such-patient/portal-account"),
        respond: () => jsonResponse({ detail: "No portal account." }, 404),
      },
    ]);

    await expect(
      api.getPatientPortalAccount("no-such-patient"),
    ).rejects.toMatchObject({ status: 404, message: "No portal account." });
  });
});
