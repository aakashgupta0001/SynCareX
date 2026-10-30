import os

layout_path = os.path.join(os.path.dirname(__file__), "src", "layouts", "AppLayout.tsx")
with open(layout_path, "r", encoding="utf-8") as f:
    content = f.read()

old_icons = """  Activity,
  BrainCircuit,"""
new_icons = """  Activity,
  BrainCircuit,
  CalendarCheck,
  QrCode,
  RefreshCw,
  Send,"""

old_nav = """  { to: "/consultations", label: "Consultations", icon: ClipboardList },
  { to: "/ai", label: "AI workspace", icon: BrainCircuit },"""
new_nav = """  { to: "/consultations", label: "Consultations", icon: ClipboardList },
  { to: "/passports", label: "Emergency passport", icon: QrCode },
  { to: "/referrals", label: "Referrals", icon: Send },
  { to: "/follow-ups", label: "Follow-ups", icon: CalendarCheck },
  { to: "/transfers", label: "Clinic exchange", icon: RefreshCw },
  { to: "/ai", label: "AI workspace", icon: BrainCircuit },"""

if old_icons in content:
    content = content.replace(old_icons, new_icons)
if old_nav in content:
    content = content.replace(old_nav, new_nav)

with open(layout_path, "w", encoding="utf-8") as f:
    f.write(content)
print("AppLayout.tsx updated")

