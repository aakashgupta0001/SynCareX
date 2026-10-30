/**
 * SynCareX FHIR R4 Mapper & Validator.
 *
 * Implements deterministic serialization of local patient records and referrals
 * into standard HL7 FHIR R4 JSON resources, with client-side structural validation.
 */

export interface FHIRResource {
  resourceType: string;
  id: string;
  [key: string]: unknown;
}

export interface FHIRBundle {
  resourceType: "Bundle";
  id: string;
  type: "collection" | "document" | "transaction" | "message";
  timestamp: string;
  entry: Array<{
    fullUrl: string;
    resource: FHIRResource;
  }>;
}

export interface FHIRValidationResult {
  isValid: boolean;
  resourceType: string;
  resourceId: string;
  issues: string[];
}

export function patientToFHIR(patient: {
  id: string;
  patientNumber: string;
  fullName: string;
  dateOfBirth?: string | null;
  gender?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  village?: string | null;
  relevantHistory?: string | null;
}): FHIRResource {
  const genderMap: Record<string, string> = {
    Male: "male",
    Female: "female",
    Other: "other",
  };

  return {
    resourceType: "Patient",
    id: patient.id,
    identifier: [
      {
        system: "urn:syncarex:patient-number",
        value: patient.patientNumber,
      },
    ],
    name: [
      {
        use: "official",
        text: patient.fullName,
      },
    ],
    gender: genderMap[patient.gender || ""] || "unknown",
    birthDate: patient.dateOfBirth || undefined,
    telecom: patient.contactPhone
      ? [
          {
            system: "phone",
            value: patient.contactPhone,
            use: "mobile",
          },
        ]
      : [],
    address:
      patient.address || patient.village
        ? [
            {
              text: patient.address || undefined,
              city: patient.village || undefined,
            },
          ]
        : [],
  };
}

export function referralToFHIR(referral: {
  id: string;
  patientId: string;
  referringClinicianId?: string;
  reason: string;
  priority: string;
  status: string;
  createdAt: string;
}): FHIRResource {
  const statusMap: Record<string, string> = {
    draft: "draft",
    awaiting_review: "draft",
    approved: "active",
    ready_to_send: "active",
    sent: "active",
    received: "active",
    accepted: "active",
    completed: "completed",
    cancelled: "revoked",
  };

  return {
    resourceType: "ServiceRequest",
    id: referral.id,
    status: statusMap[referral.status] || "active",
    intent: "order",
    priority: referral.priority || "routine",
    code: {
      text: referral.reason,
    },
    subject: {
      reference: `urn:uuid:${referral.patientId}`,
    },
    authoredOn: referral.createdAt,
    requester: referral.referringClinicianId
      ? { reference: `urn:uuid:${referral.referringClinicianId}` }
      : undefined,
  };
}

export function buildFHIRPatientBundle(
  patient: Parameters<typeof patientToFHIR>[0],
  clinicalItems?: {
    allergies?: Array<{ id: string; substance: string; reaction?: string }>;
    medications?: Array<{ id: string; name: string; dose?: string; frequency?: string }>;
    observations?: Array<{ id: string; code: string; label: string; value: string; unit?: string }>;
  },
): FHIRBundle {
  const patientResource = patientToFHIR(patient);
  const entries: FHIRBundle["entry"] = [
    {
      fullUrl: `urn:uuid:${patient.id}`,
      resource: patientResource,
    },
  ];

  if (clinicalItems?.allergies) {
    for (const a of clinicalItems.allergies) {
      entries.push({
        fullUrl: `urn:uuid:${a.id}`,
        resource: {
          resourceType: "AllergyIntolerance",
          id: a.id,
          clinicalStatus: {
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" }],
          },
          verificationStatus: {
            coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification", code: "confirmed" }],
          },
          code: { text: a.substance },
          patient: { reference: `urn:uuid:${patient.id}` },
          reaction: a.reaction ? [{ manifestation: [{ text: a.reaction }] }] : undefined,
        },
      });
    }
  }

  if (clinicalItems?.medications) {
    for (const m of clinicalItems.medications) {
      entries.push({
        fullUrl: `urn:uuid:${m.id}`,
        resource: {
          resourceType: "MedicationStatement",
          id: m.id,
          status: "active",
          medicationCodeableConcept: { text: m.name },
          subject: { reference: `urn:uuid:${patient.id}` },
          dosage: m.dose || m.frequency ? [{ text: `${m.dose || ""} ${m.frequency || ""}`.trim() }] : undefined,
        },
      });
    }
  }

  if (clinicalItems?.observations) {
    for (const o of clinicalItems.observations) {
      entries.push({
        fullUrl: `urn:uuid:${o.id}`,
        resource: {
          resourceType: "Observation",
          id: o.id,
          status: "final",
          code: { text: o.label, coding: [{ code: o.code }] },
          subject: { reference: `urn:uuid:${patient.id}` },
          valueString: o.value,
        },
      });
    }
  }

  return {
    resourceType: "Bundle",
    id: `bundle-${patient.id}`,
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}

export function validateFHIRBundle(bundle: unknown): FHIRValidationResult {
  const issues: string[] = [];
  if (!bundle || typeof bundle !== "object") {
    return {
      isValid: false,
      resourceType: "Unknown",
      resourceId: "unknown",
      issues: ["Payload must be a JSON object"],
    };
  }

  const b = bundle as Record<string, unknown>;
  if (b.resourceType !== "Bundle") {
    issues.push("resourceType must be 'Bundle'");
  }
  if (!b.id || typeof b.id !== "string") {
    issues.push("Bundle must have a valid string id");
  }
  if (!b.type || typeof b.type !== "string") {
    issues.push("Bundle must have a type");
  }
  if (!Array.isArray(b.entry)) {
    issues.push("Bundle entry must be an array");
  } else {
    for (let i = 0; i < b.entry.length; i++) {
      const entry = b.entry[i] as Record<string, unknown>;
      if (!entry.resource || typeof entry.resource !== "object") {
        issues.push(`Entry ${i} missing resource object`);
        continue;
      }
      const res = entry.resource as Record<string, unknown>;
      if (!res.resourceType || typeof res.resourceType !== "string") {
        issues.push(`Entry ${i} missing valid resourceType`);
      }
      if (!res.id || typeof res.id !== "string") {
        issues.push(`Entry ${i} missing valid id`);
      }
    }
  }

  return {
    isValid: issues.length === 0,
    resourceType: "Bundle",
    resourceId: String(b.id || "unknown"),
    issues,
  };
}

