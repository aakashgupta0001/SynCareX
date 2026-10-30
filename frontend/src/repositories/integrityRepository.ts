import { db } from "../database/db";
import type {
  IntegrityFinding,
  IntegrityFindingStatus,
  IntegritySeverity,
  LocalClinicalNote,
  LocalConsultation,
  LocalObservation,
  LocalPatient,
  LocalPatientIdentifier,
} from "../database/types";
import { MAX_AUTOMATIC_RETRIES, PROCESSING_RECOVERY_MS } from "./syncRepository";
import { aiRepository } from "./aiRepository";
import { auditRepository } from "./auditRepository";
import { documentRepository } from "./documentRepository";
import { readRecords } from "./localStore";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { patientRepository } from "./patientRepository";
import { sha256Hex } from "../offline/storage";

interface FindingDraft {
  id: string;
  ruleId: string;
  category: IntegrityFinding["category"];
  severity: IntegritySeverity;
  entityType: string;
  entityId: string;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface DecryptedIntegrityFinding extends IntegrityFinding {
  evidenceValue: Record<string, unknown>;
  rationale: string | null;
}

function normalizedName(value: string): string {
  const devanagari: Record<string, string> = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
    "क": "ka", "ख": "kha", "ग": "ga", "घ": "gha", "ङ": "nga",
    "च": "cha", "छ": "chha", "ज": "ja", "झ": "jha", "ञ": "nya",
    "ट": "ta", "ठ": "tha", "ड": "da", "ढ": "dha", "ण": "na",
    "त": "ta", "थ": "tha", "द": "da", "ध": "dha", "न": "na",
    "प": "pa", "फ": "pha", "ब": "ba", "भ": "bha", "म": "ma",
    "य": "ya", "र": "ra", "ल": "la", "व": "va", "श": "sha",
    "ष": "sha", "स": "sa", "ह": "ha",
    "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ं": "m", "ँ": "m", "ः": "h",
  };
  let transliterated = "";
  const source = value
    .replaceAll("क्ष", "ksha")
    .replaceAll("त्र", "tra")
    .replaceAll("ज्ञ", "gya");
  for (const character of source) {
    if (character === "्") {
      if (transliterated.endsWith("a")) transliterated = transliterated.slice(0, -1);
      continue;
    }
    const mapped = devanagari[character];
    if (!mapped) {
      transliterated += character;
      continue;
    }
    if (["ा", "ि", "ी", "ु", "ू", "ृ", "े", "ै", "ो", "ौ"].includes(character)) {
      if (transliterated.endsWith("a")) transliterated = transliterated.slice(0, -1);
      transliterated += mapped;
    } else {
      transliterated += mapped;
    }
  }
  return transliterated
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/aa/g, "a")
    .replace(/([aeiou])\1+/g, "$1");
}

function normalizedPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function validDate(value: string | null): boolean {
  if (!value) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function pairFinding(
  left: LocalPatient,
  right: LocalPatient,
  reason: string,
  confidence: "possible" | "likely",
): FindingDraft {
  const ids = [left.id, right.id].sort();
  return {
    id: `duplicate-patient:${ids.join(":")}`,
    ruleId: "duplicate_patient_candidate",
    category: "duplicate",
    severity: confidence === "likely" ? "high" : "medium",
    entityType: "patient",
    entityId: ids[0],
    title: "Possible duplicate patient records",
    summary: `${reason} Review both records; this is a candidate only and no merge has occurred.`,
    evidence: {
      patientIds: ids,
      patients: [
        { id: left.id, patientNumber: left.patientNumber, fullName: left.fullName, dateOfBirth: left.dateOfBirth, phone: left.contactPhone, version: left.version },
        { id: right.id, patientNumber: right.patientNumber, fullName: right.fullName, dateOfBirth: right.dateOfBirth, phone: right.contactPhone, version: right.version },
      ],
      confidence,
      matchReason: reason,
    },
  };
}

export function findDuplicatePatientCandidates(
  patients: LocalPatient[],
  identifiers: LocalPatientIdentifier[] = [],
): FindingDraft[] {
  const active = patients.filter((patient) => !patient.archivedAt);
  const patientById = new Map(active.map((patient) => [patient.id, patient]));
  const candidatePairs = new Set<string>();
  const identifierMatches = new Map<string, { system: string; value: string }>();
  const groupPairs = (groups: Map<string, Set<string>>) => {
    for (const owners of groups.values()) {
      const ids = [...owners].sort();
      for (let left = 0; left < ids.length; left += 1) {
        for (let right = left + 1; right < ids.length; right += 1) {
          const pair = `${ids[left]}\u0000${ids[right]}`;
          candidatePairs.add(pair);
        }
      }
    }
  };
  const nameDobGroups = new Map<string, Set<string>>();
  const typoDobGroups = new Map<string, Set<string>>();
  const namePhoneGroups = new Map<string, Set<string>>();
  for (const patient of active) {
    const name = normalizedName(patient.fullName);
    if (!name) continue;
    const compact = name.replace(/\s/g, "");
    if (validDate(patient.dateOfBirth)) {
      const exactKey = `${patient.dateOfBirth}\u0000${name}`;
      const exactGroup = nameDobGroups.get(exactKey) ?? new Set<string>();
      exactGroup.add(patient.id);
      nameDobGroups.set(exactKey, exactGroup);

      const signatures = new Set([compact]);
      for (let index = 0; index < compact.length; index += 1) {
        signatures.add(`${compact.slice(0, index)}${compact.slice(index + 1)}`);
      }
      for (const signature of signatures) {
        const key = `${patient.dateOfBirth}\u0000${signature}`;
        const group = typoDobGroups.get(key) ?? new Set<string>();
        group.add(patient.id);
        typoDobGroups.set(key, group);
      }
    }
    const phone = normalizedPhone(patient.contactPhone);
    if (phone.length >= 7 && (!patient.dateOfBirth || !validDate(patient.dateOfBirth))) {
      const key = `${name}\u0000${phone}`;
      const group = namePhoneGroups.get(key) ?? new Set<string>();
      group.add(patient.id);
      namePhoneGroups.set(key, group);
    }
  }
  groupPairs(nameDobGroups);
  groupPairs(typoDobGroups);
  groupPairs(namePhoneGroups);

  const identifierOwners = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    const key = `${identifier.system.trim().toLocaleLowerCase()}\u0000${identifier.value.trim()}`;
    const owners = identifierOwners.get(key) ?? new Set<string>();
    owners.add(identifier.patientId);
    identifierOwners.set(key, owners);
  }
  for (const [identifierKey, owners] of identifierOwners) {
    const ids = [...owners].filter((id) => patientById.has(id)).sort();
    const [identifierSystem, identifierValue] = identifierKey.split("\u0000");
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const pair = `${ids[left]}\u0000${ids[right]}`;
        candidatePairs.add(pair);
        identifierMatches.set(pair, {
          system: identifierSystem,
          value: identifierValue,
        });
      }
    }
  }
  const findings = new Map<string, FindingDraft>();
  for (const pair of candidatePairs) {
    const [leftId, rightId] = pair.split("\u0000");
    const left = patientById.get(leftId);
    const right = patientById.get(rightId);
    if (!left || !right) continue;
    const ids = [left.id, right.id].sort();
    const id = `duplicate-patient:${ids.join(":")}`;
    const identifierMatch = identifierMatches.get(pair);
    if (identifierMatch) {
      const finding = pairFinding(
        left, right, "The same identifier value is recorded in the same namespace.", "likely",
      );
      finding.evidence = {
        ...finding.evidence,
        identifierSystem: identifierMatch.system,
        identifierValue: identifierMatch.value,
      };
      findings.set(id, finding);
      continue;
    }
    const leftName = normalizedName(left.fullName);
    const rightName = normalizedName(right.fullName);
    const sameDob = validDate(left.dateOfBirth) && left.dateOfBirth === right.dateOfBirth;
    const bothDobValid = validDate(left.dateOfBirth) && validDate(right.dateOfBirth);
    if (bothDobValid && left.dateOfBirth !== right.dateOfBirth) continue;
    if (leftName && leftName === rightName && sameDob) {
      findings.set(
        id,
        pairFinding(left, right, "The normalized full name and date of birth match.", "likely"),
      );
      continue;
    }
    const leftCompact = Array.from(leftName.replace(/\s/g, ""));
    const rightCompact = Array.from(rightName.replace(/\s/g, ""));
    let edits = 0;
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftCompact.length && rightIndex < rightCompact.length) {
      if (leftCompact[leftIndex] === rightCompact[rightIndex]) {
        leftIndex += 1;
        rightIndex += 1;
      } else {
        edits += 1;
        if (leftCompact.length >= rightCompact.length) leftIndex += 1;
        if (rightCompact.length >= leftCompact.length) rightIndex += 1;
        if (edits > 1) break;
      }
    }
    if (leftIndex < leftCompact.length || rightIndex < rightCompact.length) edits += 1;
    if (edits === 1 && sameDob) {
      findings.set(
        id,
        pairFinding(
          left,
          right,
          "The full names differ by one character after normalization and the date of birth matches.",
          "possible",
        ),
      );
      continue;
    }
    const leftPhone = normalizedPhone(left.contactPhone);
    const rightPhone = normalizedPhone(right.contactPhone);
    if (
      leftName &&
      leftName === rightName &&
      leftPhone.length >= 7 &&
      leftPhone === rightPhone &&
      (!left.dateOfBirth || !right.dateOfBirth)
    ) {
      findings.set(
        id,
        pairFinding(
          left,
          right,
          "The normalized full name and contact phone match; at least one date of birth is not recorded.",
          "possible",
        ),
      );
    }
  }
  return [...findings.values()];
}

function draft(
  ruleId: string,
  category: IntegrityFinding["category"],
  severity: IntegritySeverity,
  entityType: string,
  entityId: string,
  title: string,
  summary: string,
  evidence: Record<string, unknown> = {},
  findingId?: string,
): FindingDraft {
  return {
    id: findingId ?? `${ruleId}:${entityId}`,
    ruleId,
    category,
    severity,
    entityType,
    entityId,
    title,
    summary,
    evidence,
  };
}

export const integrityRepository = {
  async scanLocal(): Promise<DecryptedIntegrityFinding[]> {
    const identity = requireUnlockedIdentity("run local data integrity checks");
    const [
      patients,
      identifiers,
      consultations,
      notes,
      observations,
      medications,
      documents,
      artifacts,
      operations,
      conflicts,
    ] = await Promise.all([
      patientRepository.listAllLocal({ includeArchived: true }),
      readRecords<LocalPatientIdentifier>(
        await db.patientIdentifiers.where("ownerId").equals(identity.userId).toArray(),
      ),
      readRecords<LocalConsultation>(
        (await db.consultations.where("ownerId").equals(identity.userId).toArray()),
      ),
      readRecords<LocalClinicalNote>(
        (await db.clinicalNotes.where("ownerId").equals(identity.userId).toArray()),
      ),
      readRecords<LocalObservation>(
        (await db.observations.where("ownerId").equals(identity.userId).toArray()),
      ),
      readRecords<{ id: string; patientId: string; name: string; dose: string; frequency: string; startedAt: string | null; stoppedAt: string | null }>(
        (await db.medications.where("ownerId").equals(identity.userId).toArray()),
      ),
      documentRepository.listLocal(),
      aiRepository.listLocal(),
      db.syncOperations.where("ownerId").equals(identity.userId).toArray(),
      db.syncConflicts.where("ownerId").equals(identity.userId).toArray(),
    ]);

    const findings = findDuplicatePatientCandidates(patients, identifiers);
    const patientById = new Map(patients.map((patient) => [patient.id, patient]));
    const consultationById = new Map(consultations.map((item) => [item.id, item]));
    const now = Date.now();

    for (const patient of patients) {
      const hasDob = Boolean(patient.dateOfBirth);
      const hasAge = patient.estimatedAge !== null && patient.estimatedAge !== undefined;
      if (hasDob && !validDate(patient.dateOfBirth)) {
        findings.push(draft(
          "patient_invalid_date_of_birth", "validation", "high", "patient", patient.id,
          "Patient date of birth needs verification",
          "The stored date is not a valid calendar date. Verify the source record before correcting it.",
          { patientId: patient.id, dateOfBirth: patient.dateOfBirth },
        ));
      } else if (validDate(patient.dateOfBirth) && patient.dateOfBirth! > new Date().toISOString().slice(0, 10)) {
        findings.push(draft(
          "patient_future_date_of_birth", "validation", "high", "patient", patient.id,
          "Patient date of birth is in the future",
          "Verify the date against the source record; no value has been changed.",
          { patientId: patient.id, dateOfBirth: patient.dateOfBirth },
        ));
      }
      if (hasDob && hasAge) {
        findings.push(draft(
          "patient_age_fields_both_present", "validation", "low", "patient", patient.id,
          "Date of birth and estimated age are both recorded",
          "Confirm which demographic value is authoritative. The guardian does not calculate or replace either value.",
          { patientId: patient.id, dateOfBirth: patient.dateOfBirth, estimatedAge: patient.estimatedAge },
        ));
      } else if (!hasDob && !hasAge) {
        findings.push(draft(
          "patient_age_missing", "validation", "low", "patient", patient.id,
          "Date of birth or estimated age is not recorded",
          "Review whether this demographic information is available and appropriate to record.",
          { patientId: patient.id },
        ));
      }
    }

    for (const consultation of consultations) {
      if (!patientById.has(consultation.patientId)) {
        findings.push(draft(
          "consultation_patient_missing", "relationship", "high", "consultation", consultation.id,
          "Consultation references a patient not found locally",
          "Check the local patient cache and synchronization history; the consultation has not been reassigned.",
          { consultationId: consultation.id, patientId: consultation.patientId },
        ));
      }
      if (
        consultation.status === "completed" &&
        !consultation.reason.trim() &&
        !consultation.notes.trim()
      ) {
        findings.push(draft(
          "completed_consultation_without_documentation", "validation", "medium", "consultation", consultation.id,
          "Completed consultation has no reason or notes",
          "Verify the documentation status with the clinician; this check does not infer a clinical omission.",
          { consultationId: consultation.id, patientId: consultation.patientId },
        ));
      }
    }

    for (const note of notes) {
      if (!patientById.has(note.patientId) || !consultationById.has(note.consultationId)) {
        findings.push(draft(
          "clinical_note_reference_missing", "relationship", "high", "clinicalNote", note.id,
          "Clinical note has a missing patient or consultation reference",
          "Check the related local records and synchronization history. No relationships were changed.",
          { noteId: note.id, patientId: note.patientId, consultationId: note.consultationId },
        ));
      }
    }

    const observationsByTime = new Map<string, LocalObservation[]>();
    for (const observation of observations) {
      if (!patientById.has(observation.patientId)) {
        findings.push(draft(
          "observation_patient_missing", "relationship", "high", "observation", observation.id,
          "Observation references a patient not found locally",
          "Check the local patient cache and synchronization history; the observation has not been reassigned.",
          { observationId: observation.id, patientId: observation.patientId },
        ));
      }
      if (observation.consultationId && !consultationById.has(observation.consultationId)) {
        findings.push(draft(
          "observation_consultation_missing", "relationship", "medium", "observation", observation.id,
          "Observation references a consultation not found locally",
          "Check the local consultation cache and synchronization history.",
          { observationId: observation.id, consultationId: observation.consultationId },
        ));
      }
      const key = `${observation.patientId}|${observation.code.trim().toLowerCase()}|${observation.recordedAt}`;
      observationsByTime.set(key, [...(observationsByTime.get(key) ?? []), observation]);
    }
    for (const [key, sameTime] of observationsByTime) {
      const distinctValues = new Set(sameTime.map((item) => `${item.value.trim()}|${item.unit.trim().toLowerCase()}`));
      if (sameTime.length > 1 && distinctValues.size > 1) {
        const ids = sameTime.map((item) => item.id).sort();
        findings.push(draft(
          "observation_same_time_disagreement", "validation", "medium", "observation", ids[0],
          "Measurements with the same code and timestamp disagree",
          "Review the source entries and units. SynCareX does not select a value or interpret its clinical significance.",
          { observationIds: ids, observations: sameTime.map(({ id, value, unit, recordedAt }) => ({ id, value, unit, recordedAt })), key },
        ));
      }
    }

    for (const medication of medications) {
      if (medication.startedAt && medication.stoppedAt && medication.stoppedAt < medication.startedAt) {
        findings.push(draft(
          "medication_date_order", "validation", "medium", "medication", medication.id,
          "Medication record dates are out of order",
          "Verify the recorded dates. This warning does not recommend starting, stopping, or changing medication.",
          { medicationId: medication.id, startedAt: medication.startedAt, stoppedAt: medication.stoppedAt, name: medication.name },
        ));
      }
    }

    for (const document of documents) {
      if (!patientById.has(document.patientId)) {
        findings.push(draft(
          "document_patient_missing", "relationship", "high", "document", document.id,
          "Document references a patient not found locally",
          "Check the local patient cache and synchronization history.",
          { documentId: document.id, patientId: document.patientId },
        ));
      }
      if (document.uploadStatus !== "uploaded" && !(await documentRepository.hasLocalBytes(document.id))) {
        findings.push(draft(
          "document_local_bytes_missing", "sync", "high", "document", document.id,
          "Queued document has no local encrypted file",
          "The upload cannot be verified or safely retried until the source file is restored.",
          { documentId: document.id, fileName: document.fileName, checksum: document.checksum },
        ));
      } else if (await documentRepository.hasLocalBytes(document.id)) {
        try {
          const bytes = await documentRepository.readBytes(document.id);
          if (bytes && ((await sha256Hex(bytes)) !== document.checksum || bytes.byteLength !== document.byteSize)) {
            findings.push(draft(
              "document_checksum_mismatch", "sync", "high", "document", document.id,
              "Stored document does not match its registered integrity metadata",
              "The file was not opened or uploaded. Restore a verified copy before retrying.",
              { documentId: document.id, fileName: document.fileName, expectedChecksum: document.checksum, actualSize: bytes.byteLength },
            ));
          }
        } catch (reason) {
          const errorMessage =
            reason instanceof Error ? reason.message : "Unknown decryption error";
          findings.push(draft(
            "document_decryption_failure", "sync", "high", "document", document.id,
            "Stored document could not be verified because its encrypted content could not be opened.",
            "The file was not uploaded. Preserve this local copy and restore from a verified source.",
            { documentId: document.id, fileName: document.fileName, expectedChecksum: document.checksum, verificationError: errorMessage },
          ));
        }
      }
    }

    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const artifact of artifacts) {
      const payload = artifact.payload;
      if (artifact.kind === "extraction") {
        const sourceId = typeof payload.source_id === "string" ? payload.source_id : "";
        const source = artifactById.get(sourceId);
        const facts = Array.isArray(payload.facts) ? payload.facts : [];
        const invalidFactIndexes = facts.flatMap((rawFact, index) => {
          if (!rawFact || typeof rawFact !== "object") return [index];
          const fact = rawFact as Record<string, unknown>;
          const evidence = typeof fact.evidence === "string" ? fact.evidence : "";
          const confidence = fact.confidence;
          const sourceText = typeof source?.payload.text === "string" ? source.payload.text : "";
          return !evidence || !sourceText.includes(evidence) ||
            typeof confidence !== "number" || confidence < 0 || confidence > 1
            ? [index]
            : [];
        });
        if (!source || (source.kind !== "transcript" && source.kind !== "ocr_text")) {
          findings.push(draft(
            "ai_extraction_source_missing", "provenance", "high", "aiArtifact", artifact.id,
            "AI extraction has no available source artifact",
            "Review the original source and extraction. No extracted statement has been added to the clinical record.",
            { artifactId: artifact.id, sourceId, modelId: payload.model_id ?? null },
          ));
        } else if (invalidFactIndexes.length) {
          findings.push(draft(
            "ai_extraction_evidence_invalid", "provenance", "high", "aiArtifact", artifact.id,
            "AI extraction contains evidence that does not verify against its source",
            "Review the quoted text and source artifact manually. The guardian does not accept or repair extracted facts.",
            { artifactId: artifact.id, sourceId, invalidFactIndexes },
          ));
        }
        if (artifact.status === "review_required") {
          findings.push(draft(
            "ai_extraction_pending_review", "provenance", "medium", "aiArtifact", artifact.id,
            "AI-generated statements are awaiting clinician review",
            "Review each statement against the original source in the AI workspace. AI output is not clinical fact until a clinician records it.",
            { artifactId: artifact.id, sourceId },
          ));
        }
      } else if (artifact.kind === "transcript" && payload.source_id) {
        const source = typeof payload.source_id === "string"
          ? artifactById.get(payload.source_id)
          : undefined;
        if (!source || source.kind !== "audio_source") {
          findings.push(draft(
            "ai_transcript_source_missing", "provenance", "medium", "aiArtifact", artifact.id,
            "Transcript source artifact is not available",
            "Verify the source recording before relying on this transcript.",
            { artifactId: artifact.id, sourceId: payload.source_id },
          ));
        }
      } else if (artifact.kind === "ocr_text") {
        const source = typeof payload.source_id === "string"
          ? artifactById.get(payload.source_id)
          : undefined;
        if (!source || source.kind !== "document_source") {
          findings.push(draft(
            "ai_ocr_source_missing", "provenance", "medium", "aiArtifact", artifact.id,
            "OCR result has no available source document",
            "Verify the original image before relying on extracted text.",
            { artifactId: artifact.id, sourceId: payload.source_id ?? null },
          ));
        }
      } else if (artifact.kind === "summary") {
        const source = typeof payload.source_id === "string"
          ? artifactById.get(payload.source_id)
          : undefined;
        if (!source) {
          findings.push(draft(
            "ai_summary_source_missing", "provenance", "low", "aiArtifact", artifact.id,
            "Saved summary has no available source artifact",
            "Confirm whether this summary was based on a source; it remains editable documentation, not a clinical fact.",
            { artifactId: artifact.id, sourceId: payload.source_id ?? null },
          ));
        }
      }
    }

    for (const operation of operations) {
      const staleProcessing =
        operation.status === "processing" &&
        now - Date.parse(operation.lastAttemptAt ?? operation.updatedAt) > PROCESSING_RECOVERY_MS;
      const exhausted =
        operation.retryCount >= MAX_AUTOMATIC_RETRIES &&
        ["pending", "retry_wait", "processing"].includes(operation.status);
      if (operation.status === "failed" || staleProcessing || exhausted) {
        findings.push(draft(
          "sync_operation_requires_attention", "sync", operation.status === "failed" ? "high" : "medium",
          operation.entityType, operation.entityId,
          "Synchronization operation needs attention",
          "The operation failed or stopped progressing. Review its sync-center status before retrying.",
          { operationId: operation.operationId, operationType: operation.operationType, status: operation.status, retryCount: operation.retryCount, lastAttemptAt: operation.lastAttemptAt, error: operation.lastError },
          `sync_operation_requires_attention:${operation.operationId}`,
        ));
      }
    }

    for (const conflict of conflicts.filter((item) => item.status === "open")) {
      findings.push(draft(
        "sync_conflict_open", "sync", "medium", conflict.entityType, conflict.entityId,
        "Synchronization conflict is unresolved",
        "Review both retained versions in Conflict review. No automatic merge has been attempted.",
        { conflictId: conflict.id, operationId: conflict.operationId, detectedAt: conflict.detectedAt },
        `sync_conflict_open:${conflict.id}`,
      ));
    }

    const existing = await db.integrityFindings.where("ownerId").equals(identity.userId).toArray();
    const existingById = new Map(existing.map((item) => [item.id, item]));
    const activeIds = new Set(findings.map((item) => item.id));
    const nowIso = new Date().toISOString();
    const toWrite: IntegrityFinding[] = [];
    const reopened: IntegrityFinding[] = [];
    for (const item of findings) {
      const old = existingById.get(item.id);
      let status = old?.status ?? "open";
      let detectedAt = old?.detectedAt ?? nowIso;
      let reviewedAt = old?.reviewedAt ?? null;
      let reviewedBy = old?.reviewedBy ?? null;
      let reviewRationale = old?.reviewRationale ?? null;
      if (old?.status === "resolved") {
        status = "open";
        detectedAt = nowIso;
        reviewedAt = null;
        reviewedBy = null;
        reviewRationale = null;
        reopened.push(old);
      } else if (old?.status === "dismissed") {
        const previousEvidence = await decryptLocalValue<Record<string, unknown>>(old.evidence);
        if (JSON.stringify(previousEvidence) !== JSON.stringify(item.evidence)) {
          status = "open";
          detectedAt = nowIso;
          reviewedAt = null;
          reviewedBy = null;
          reviewRationale = null;
          reopened.push(old);
        }
      }
      toWrite.push({
        id: item.id,
        ownerId: identity.userId,
        ruleId: item.ruleId,
        category: item.category,
        severity: item.severity,
        entityType: item.entityType,
        entityId: item.entityId,
        status,
        title: item.title,
        summary: item.summary,
        evidence: await encryptLocalValue(item.evidence),
        detectedAt,
        updatedAt: nowIso,
        reviewedAt,
        reviewedBy,
        reviewRationale,
      });
    }
    for (const old of existing) {
      if (
        !activeIds.has(old.id) &&
        (old.status === "open" || old.status === "acknowledged")
      ) {
        toWrite.push({
          ...old,
          status: "resolved",
          summary: `${old.summary} The deterministic check no longer matches after a rescan.`,
          updatedAt: nowIso,
          reviewedAt: nowIso,
          reviewedBy: null,
          reviewRationale: await encryptLocalValue("Automatically resolved by local rescan; rule no longer matched."),
        });
      }
    }

    await db.transaction("rw", db.integrityFindings, async () => {
      if (toWrite.length) await db.integrityFindings.bulkPut(toWrite);
    });
    const newlyResolved = toWrite.filter((item) => item.status === "resolved" && !activeIds.has(item.id));
    for (const item of newlyResolved) {
      await auditRepository.record({
        action: "integrity.finding.resolved_by_rescan",
        entityType: item.entityType,
        entityId: item.entityId,
        details: { rule_id: item.ruleId },
      });
    }
    for (const item of reopened) {
      await auditRepository.record({
        action: "integrity.finding.reopened_by_rescan",
        entityType: item.entityType,
        entityId: item.entityId,
        details: { rule_id: item.ruleId },
      });
    }
    await auditRepository.record({
      action: "integrity.scan.completed",
      entityType: "integrityScan",
      entityId: null,
      details: { finding_count: findings.length },
    });
    return this.listLocal();
  },

  async listLocal(): Promise<DecryptedIntegrityFinding[]> {
    const identity = requireUnlockedIdentity("read local integrity findings");
    const rows = await db.integrityFindings.where("ownerId").equals(identity.userId).toArray();
    const result = await Promise.all(rows.map(async (finding) => ({
      ...finding,
      evidenceValue: await decryptLocalValue<Record<string, unknown>>(finding.evidence),
      rationale: finding.reviewRationale
        ? await decryptLocalValue<string>(finding.reviewRationale)
        : null,
    })));
    return result.sort((left, right) =>
      right.detectedAt.localeCompare(left.detectedAt),
    );
  },

  async review(
    findingId: string,
    status: IntegrityFindingStatus,
    rationale: string,
  ): Promise<void> {
    const identity = requireUnlockedIdentity("review local integrity findings");
    if (!identity.permissions.includes("patients.write")) {
      throw new Error("Your provisioned role does not permit integrity review actions.");
    }
    const allowed = new Set<IntegrityFindingStatus>([
      "open", "acknowledged", "resolved", "dismissed",
    ]);
    if (!allowed.has(status)) throw new Error("Unsupported integrity review action.");
    if ((status === "resolved" || status === "dismissed") && rationale.trim().length < 3) {
      throw new Error("Add a short reason before resolving or dismissing a finding.");
    }
    const current = await db.integrityFindings.get(findingId);
    if (!current || current.ownerId !== identity.userId) {
      throw new Error("Integrity finding was not found for this local account.");
    }
    const now = new Date().toISOString();
    await db.integrityFindings.update(findingId, {
      status,
      updatedAt: now,
      reviewedAt: status === "open" ? null : now,
      reviewedBy: status === "open" ? null : identity.userId,
      reviewRationale: status === "open" ? null : await encryptLocalValue(rationale.trim()),
    });
    await auditRepository.record({
      action: `integrity.finding.${status}`,
      entityType: current.entityType,
      entityId: current.entityId,
      details: { rule_id: current.ruleId },
    });
  },

  async countOpen(): Promise<number> {
    const identity = requireUnlockedIdentity("count local integrity findings");
    const rows = await db.integrityFindings.where("ownerId").equals(identity.userId).toArray();
    return rows.filter((item) => item.status === "open" || item.status === "acknowledged").length;
  },
};
