# SynCareX hackathon demonstration

Date: 2026-10-30. Running time: 8–10 minutes.

**Every record in this demonstration is synthetic.** No real patient
information is used, shown, or stored. Say this out loud at the start.

## A. The problem (60 seconds, no screen)

A health worker in a rural clinic documents a consultation on a tablet. The
connection drops mid-visit — which, where this matters most, is the normal
case rather than the exception.

Most clinical software treats the network as a precondition. When it goes,
the worker falls back to paper, and that paper is later retyped, or lost, or
never reconciled. The record that reaches the district system is incomplete,
late, or both.

SynCareX inverts the assumption. Every clinical record is written to the
device and is durable **before** any network request is attempted.
Connectivity decides *when* a record reaches the server, never whether the
clinician can record it.

Two claims we will show rather than assert:

1. The application works with the network genuinely off — not a status
   label, real data.
2. When two devices disagree, nothing is silently overwritten.

## B. Offline demonstration (3 minutes)

> **Setup before the audience arrives:** sign in once while online so the
> device is provisioned and the service worker is installed. Then leave the
> app open. Have a synthetic PNG or PDF ready to attach.

1. **Show the app already installed.** Point at the Sync Center: "Connected",
   last successful sync a moment ago.

2. **Disconnect for real.** Turn off Wi-Fi at the operating system level, or
   use DevTools → Network → Offline. Do it in front of the audience. The
   connectivity indicator changes to **Offline**.

   > Say: "`navigator.onLine` is not enough — a device can have Wi-Fi and
   > still not reach the server. SynCareX probes the API itself, so the
   > indicator distinguishes 'offline' from 'online but the API is
   > unreachable'."

3. **Reload the page with the network off.** The application still opens.
   That is the service worker serving the shell from cache.

4. **Sign in offline.** The vault unlocks from the device's own encrypted
   store.

   > Say: "This is not a bypass. The first sign-in had to reach the server,
   > which provisioned this device and granted an offline session with an
   > expiry. When that expires, offline sign-in is refused and the records
   > stay encrypted until the next online sign-in."

5. **Register a patient** — use a clearly synthetic name. Save.

   Point at the message: **"Saved securely on this device. Waiting for
   internet connection to synchronize."**

   > Say: "Note what it does *not* say. It does not say synced. A record is
   > only ever labelled Synced after the server confirms it."

6. **Add a consultation and a clinical note.** Attach the synthetic document.
   The file is encrypted and stored locally; its SHA-256 is recorded.

7. **Search for the patient.** Local search works with no network.

8. **Open the Sync Center.** Show the queued operations, each with its own
   idempotency key, and the Sync button **disabled** because the API is
   unreachable.

9. **Close the browser completely and reopen it.** Sign in offline again.
   Everything is still there: patient, consultation, note, document, and the
   queue.

   > This is the step worth lingering on. It is a real process restart, not
   > a page refresh.

### What to say about AI

**Do not demonstrate live transcription, OCR or extraction unless you have
verified that the models are installed and working on the demo machine.**

On the audit machine they were not: whisper.cpp, Tesseract and the local LLM
were all absent, so those steps were recorded as **blocked, not passing**.

Open the AI workspace anyway and show the honest "Local AI engine
unavailable" state.

> Say: "The AI engine is optional by design. It runs locally — there is no
> cloud AI dependency in any offline workflow — and when it is not available,
> every clinical workflow you just saw still works. Anything it does produce
> is marked for clinician review and is never written into a record without
> a human accepting it."

If you *have* installed the models and verified them, you may demonstrate
them live. In that case say explicitly that it is running locally on this
machine. **Never play a recording and describe it as live inference.** If you
show a recording, label it on screen as a recording.

## C. Integrity demonstration (3 minutes)

This needs two browser profiles side by side. Treat them as two tablets.

1. **Device A** creates a patient and synchronizes. The record's badge turns
   **Synced**.

2. **Device B** synchronizes and the patient appears — a record it never
   created, pulled from the server's change feed.

3. **Take both devices offline.** On A, change the village to "Village A".
   On B, change the same field to "Village B". Both save locally.

4. **Reconnect A** and sync. Accepted; the record moves to version 2.

5. **Reconnect B** and sync. B is **not** overwritten and does not overwrite.
   Open **Conflicts**.

6. **Show the side-by-side comparison** — B's own edit and the server's
   version, with the differing field highlighted.

   > Say: "Neither version has been thrown away. A clinician decides. If they
   > keep the local version, it is re-queued against the current server
   > version rather than blindly replayed; if they keep the server's, their
   > own attempt is retained in the conflict history. The engine never merges
   > clinical information on its own."

7. **Resolve it** as the clinician and sync.

This exact sequence is covered by an automated test that passes
(`frontend/e2e/two-device-sync.spec.ts`, 8/8).

## D. Recovery demonstration (90 seconds)

1. With records queued, **stop the API** (or block it in DevTools) while
   leaving Wi-Fi on.

2. Save another patient. It still saves. The indicator shows **"API
   unreachable"**, distinct from offline.

3. Open the Sync Center: the failed operation shows its attempt count and the
   time of its next retry — exponential backoff, capped.

   > Say: "It is kept, not dropped. The local record is complete either way."

4. **Restart the API.** Press "Check again", then "Sync now". The queue
   drains and the badges turn Synced.

5. Show that the operation count did not double.

   > Say: "Each operation carries a deterministic idempotency key, and the
   > server keeps a ledger of the keys it has applied. If a device retries
   > because it never saw our answer, the server recognises the replay and
   > returns the original outcome instead of creating a second record."

## E. Conclusion (60 seconds)

**What is demonstrably true today**

- The installed app opens and works with the network genuinely off.
- Records, documents, drafts and the operation queue survive a real browser
  restart — verified by an automated test using a persistent profile.
- Two devices converge, and concurrent edits are preserved for human review.
- Replayed operations cannot create duplicates.
- Every clinical record is AES-GCM encrypted on the device with a key
  derived from the clinician's passphrase and held only in memory.
- 176 automated tests pass: 45 frontend unit, 124 backend, 7 AI engine, plus
  the end-to-end suites.

**What is not true yet — say this, do not let someone discover it**

- Not clinically validated, not penetration tested, not certified.
- The local AI pipeline was **not** verified on the audit machine; no model
  was installed.
- IndexedDB is not encrypted by the browser. SynCareX encrypts each record
  itself, but record structure and timestamps remain visible to anyone with
  the browser profile.
- The audit trail is an operational log, not tamper-evident.
- The emergency passport's code image is a visual badge, **not a scannable
  QR code**; verification works by token.
- No rate limiting on sign-in, and no retention policy.

> Closing line: "The engineering claim we are making is narrow and testable:
> a health worker can finish documenting a visit without a network, and
> nothing they recorded is lost or silently changed when the network comes
> back."

## Fallbacks

| If this fails | Do this |
|---|---|
| Service worker has not installed | Load the app online once and wait for "Ready to work offline", then begin |
| Offline sign-in refused | The offline session expired; sign in online once to renew it |
| Sync button stays disabled | Press "Check again"; confirm the API host is reachable and CORS lists the demo origin |
| Conflict does not appear | Confirm both devices edited the **same field** of the **same patient** while offline, and that A synced first |
| AI workspace errors | Expected when no model is installed; show the unavailable state and move on |
| Everything goes wrong | Fall back to section C only — the conflict story runs entirely on two local profiles |

## Pre-flight checklist

- [ ] Backend running; `/health` returns `{"status":"ok"}`
- [ ] Frontend production build served over HTTPS or localhost
- [ ] Both demo profiles signed in **online** once, devices provisioned
- [ ] Service worker active in both
- [ ] Synthetic document file ready
- [ ] A reliable way to toggle the network in front of the audience
- [ ] Browser zoom at ~110% for legibility
- [ ] Decided in advance whether AI is demonstrated live or skipped
