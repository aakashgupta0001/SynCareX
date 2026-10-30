import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { AuthProvider } from "../services/auth";
import { aiRepository } from "../repositories/aiRepository";
import { lockLocalVault } from "../security/localVault";
import { resetWorkspace, setOnline, testPassword, testUser } from "./helpers";

/**
 * The saved audio/document sources are encrypted blobs; this pins the UI
 * that decrypts them on demand: a Play button that produces a live audio
 * element and a Download button that saves the original file.
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

describe("saved AI source playback and download", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
    lockLocalVault();
    // jsdom does not implement blob URL management.
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:mock-url"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    lockLocalVault();
    vi.unstubAllGlobals();
  });

  it("plays a saved audio source on demand", async () => {
    await signInOffline();
    const recording = new File([new Uint8Array([1, 2, 3, 4])], "visit-recording.webm", {
      type: "audio/webm",
    });
    await aiRepository.saveSource("audio_source", recording);

    fireEvent.click(screen.getByRole("link", { name: "AI workspace" }));
    await screen.findByRole("heading", { name: "AI workspace" });

    const playButton = await screen.findByRole("button", {
      name: /play saved audio/i,
    });
    expect(screen.queryByRole("region", { name: /saved source playback/i })).toBeNull();
    fireEvent.click(playButton);

    const player = await screen.findByRole("region", { name: /saved source playback/i });
    const audio = player.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio!.getAttribute("src")).toBe("blob:mock-url");
  });

  it("downloads a saved document source with its original file name", async () => {
    await signInOffline();
    const scan = new File([new Uint8Array([9, 8, 7])], "prescription-scan.png", {
      type: "image/png",
    });
    await aiRepository.saveSource("document_source", scan);

    const clicks: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = originalCreate(tag);
      if (tag === "a") clicks.push(element as HTMLAnchorElement);
      return element;
    }) as typeof document.createElement);
    // jsdom never navigates on anchor click; the download attribute is what
    // the test can pin.
    HTMLAnchorElement.prototype.click = vi.fn();

    fireEvent.click(screen.getByRole("link", { name: "AI workspace" }));
    await screen.findByRole("heading", { name: "AI workspace" });

    const downloadButton = await screen.findByRole("button", {
      name: /download the saved document file/i,
    });
    fireEvent.click(downloadButton);

    // The download attribute carries the original file name; jsdom never
    // actually navigates, so the anchor is the observable contract. The
    // anchor appears after the async decrypt, hence the wait.
    await vi.waitFor(() => expect(clicks.length).toBeGreaterThan(0));
    expect(clicks[clicks.length - 1].download).toBe("prescription-scan.png");
  });
});
