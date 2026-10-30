"""Fix AIWorkspacePage.tsx function scopes and syncPullRepository.ts."""
import os

ai_path = os.path.join(os.path.dirname(__file__), "src", "pages", "AIWorkspacePage.tsx")
with open(ai_path, "r", encoding="utf-8") as f:
    ai_content = f.read()

# We need to extract startRecording, stopRecording, retrievePatientHistory from submitTranscription
bad_block = '''  async function submitTranscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!audio) {
      setError("Choose an audio file first.");
      return;
    }

    async function startRecording() {'''

fixed_block = '''  async function startRecording() {'''

# Find the end of retrievePatientHistory and start of submitTranscription body:
split_marker = '''    }
    setBusy("transcription");'''

corrected_split = '''    }
  }

  async function submitTranscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!audio) {
      setError("Choose an audio file first.");
      return;
    }

    setBusy("transcription");'''

if bad_block in ai_content and split_marker in ai_content:
    ai_content = ai_content.replace(bad_block, fixed_block)
    ai_content = ai_content.replace(split_marker, corrected_split)
    with open(ai_path, "w", encoding="utf-8") as f:
        f.write(ai_content)
    print("AIWorkspacePage.tsx fixed successfully")
else:
    print("Could not find markers in AIWorkspacePage.tsx")

# Now fix syncPullRepository.ts
pull_path = os.path.join(os.path.dirname(__file__), "src", "repositories", "syncPullRepository.ts")
with open(pull_path, "r", encoding="utf-8") as f:
    pull_content = f.read()

pull_content = pull_content.replace(
    "const tableNames: Record<EntityType, string> = {",
    "const tableNames: Partial<Record<EntityType, string>> = {",
)
pull_content = pull_content.replace(
    '    await db.transaction(\n      "rw",\n      db.patients,',
    '    await db.transaction(\n      "rw",\n      [\n        db.patients,',
)
pull_content = pull_content.replace(
    '      db.localSettings,\n      async () => {',
    '      db.localSettings,\n      ],\n      async () => {',
)

with open(pull_path, "w", encoding="utf-8") as f:
    f.write(pull_content)
print("syncPullRepository.ts fixed successfully")

