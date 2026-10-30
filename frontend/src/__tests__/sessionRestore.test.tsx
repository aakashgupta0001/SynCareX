import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { AuthProvider } from "../services/auth";
import { lockLocalVault } from "../security/localVault";
import { resetWorkspace, setOnline, testPassword, testUser } from "./helpers";

/**
 * A page reload drops the in-memory access token and locks the vault, but
 * the refresh cookie survives. The sign-in screen must recognize the
 * restored server session: pre-filled email, unlock-first copy — never a
 * cold "who are you?" form.
 */

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("session restore on page load", () => {
  afterEach(() => {
    cleanup();
    lockLocalVault();
    vi.unstubAllGlobals();
  });

  it("pre-fills the email and shows the unlock copy when the refresh cookie restores a session", async () => {
    setOnline(true);
    await resetWorkspace();
    lockLocalVault();

    const authResponse = {
      access_token: "restored-access-token",
      token_type: "bearer",
      user: {
        id: testUser.id,
        clinic_id: "clinic-1",
        email: testUser.email,
        full_name: testUser.fullName,
        roles: [{ name: "Doctor", permissions: testUser.permissions }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/refresh")) {
          return Promise.resolve(
            new Response(JSON.stringify(authResponse), { status: 200 }),
          );
        }
        // Anything else (health probes, sync) is out of scope here: answer
        // unreachable so the test stays focused on the restore path.
        return Promise.reject(new TypeError("not part of this test"));
      }),
    );

    renderApp();

    // The email is pre-filled from the restored session, with unlock-first
    // copy instead of a cold sign-in prompt.
    await screen.findByDisplayValue(testUser.email);
    expect(
      screen.getByText(/server session restored/i),
    ).toBeTruthy();

    // And unlocking with the passphrase goes straight into the workspace
    // without needing the server again.
    fireEvent.change(screen.getByLabelText("Password / local vault passphrase"), {
      target: { value: testPassword },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock local workspace/i }));
    await screen.findByRole("heading", { name: "Good day" });
  });

  it("shows a cold sign-in when there is no restored session", async () => {
    setOnline(false);
    await resetWorkspace();
    lockLocalVault();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );

    renderApp();

    // Give the restore attempt a moment to fail, then the form must be
    // empty with the normal copy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Sign in to your clinic workspace.")).toBeTruthy();
  });
});
