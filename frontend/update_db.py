"""Update db.ts with Phase 6 stores."""
import os

db_path = os.path.join(os.path.dirname(__file__), "src", "database", "db.ts")
with open(db_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update imports
content = content.replace(
    "  IntegrityFinding,\n",
    "  IntegrityFinding,\n  ClinicTransferRecord,\n  EmergencyPassportRecord,\n  FollowUpRecord,\n  PairedClinicRecord,\n  PassportRevocationRecord,\n  ReferralRecord,\n",
)

# 2. Update version constant
content = content.replace("export const DATABASE_VERSION = 5;", "export const DATABASE_VERSION = 6;")

# 3. Add table declarations to class
old_tables = "  integrityFindings!: EntityTable<IntegrityFinding, \"id\">;"
new_tables = """  integrityFindings!: EntityTable<IntegrityFinding, "id">;
  passports!: EntityTable<EmergencyPassportRecord, "id">;
  referrals!: EntityTable<ReferralRecord, "id">;
  followUps!: EntityTable<FollowUpRecord, "id">;
  transfers!: EntityTable<ClinicTransferRecord, "id">;
  pairedClinics!: EntityTable<PairedClinicRecord, "id">;
  passportRevocations!: EntityTable<PassportRevocationRecord, "tokenHash">;"""

content = content.replace(old_tables, new_tables)

# 4. Add version(6)
v6_stores = '''
    this.version(6).stores({
      patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
      patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
      consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
      clinicalNotes:
        "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
      observations: "&id, ownerId, patientId, consultationId, updatedAt",
      allergies: "&id, ownerId, patientId, updatedAt",
      medications: "&id, ownerId, patientId, updatedAt",
      documents: "&id, ownerId, patientId, consultationId, createdAt",
      documentBlobs: "&id, ownerId, patientId",
      localUsers: "&id, email, userId",
      devices: "&id, &deviceId",
      syncOperations:
        "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
      syncConflicts: "&id, ownerId, entityId, status, detectedAt",
      auditEvents: "&id, ownerId, entityId, createdAt, synced",
      localSettings: "&key",
      aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
      aiBlobs: "&id, ownerId, createdAt",
      integrityFindings:
        "&id, ownerId, ruleId, category, severity, entityId, status, detectedAt, [ownerId+status]",
      passports: "&id, ownerId, patientId, tokenHash, expiresAt, createdAt",
      referrals:
        "&id, ownerId, patientId, status, priority, receivingClinicId, createdAt, updatedAt",
      followUps:
        "&id, ownerId, patientId, status, priority, scheduledAt, [ownerId+status]",
      transfers:
        "&id, ownerId, transferId, sourceClinicId, targetClinicId, status, createdAt",
      pairedClinics: "&id, clinicId, status",
      passportRevocations: "&tokenHash, revokedAt",
    });
  }'''

old_end = '''      integrityFindings:
        "&id, ownerId, ruleId, category, severity, entityId, status, detectedAt, [ownerId+status]",
    });
  }'''

if old_end in content:
    content = content.replace(old_end, old_end[:-4] + "\n    });\n" + v6_stores)

with open(db_path, "w", encoding="utf-8") as f:
    f.write(content)

print("db.ts updated successfully")

