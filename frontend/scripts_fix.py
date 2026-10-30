import os

p = os.path.join(os.path.dirname(__file__), "src", "repositories", "syncPullRepository.ts")
with open(p, "r", encoding="utf-8") as f:
    c = f.read()

old_block = '''const tableNames: Partial<Record<EntityType, string>> = {
  patient: "patients",
  patientIdentifier: "patientIdentifiers",
  consultation: "consultations",
  clinicalNote: "clinicalNotes",
  observation: "observations",
  allergy: "allergies",
  medication: "medications",
  document: "documents",
};'''

new_block = '''const tableNames: Record<EntityType, string> = {
  patient: "patients",
  patientIdentifier: "patientIdentifiers",
  consultation: "consultations",
  clinicalNote: "clinicalNotes",
  observation: "observations",
  allergy: "allergies",
  medication: "medications",
  document: "documents",
  referral: "referrals",
  followup: "followUps",
  passport: "passports",
  transfer: "transfers",
};'''

c = c.replace(old_block, new_block)
with open(p, "w", encoding="utf-8") as f:
    f.write(c)
print("syncPullRepository updated")

