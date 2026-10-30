import type { VerificationBadge } from "../database/types";

interface FreshnessBadgeProps {
  status: VerificationBadge;
  sourceClinic?: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

export function FreshnessBadge({
  status,
  sourceClinic,
  verifiedAt,
  verifiedBy,
}: FreshnessBadgeProps) {
  const configs: Record<
    VerificationBadge,
    { label: string; bg: string; text: string; border: string }
  > = {
    verified: {
      label: "Clinician Verified",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      border: "border-emerald-200",
    },
    imported: {
      label: "Imported (External)",
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
    },
    ai_draft: {
      label: "AI Draft (Unreviewed)",
      bg: "bg-purple-50",
      text: "text-purple-700",
      border: "border-purple-200",
    },
    outdated: {
      label: "Outdated",
      bg: "bg-amber-50",
      text: "text-amber-700",
      border: "border-amber-200",
    },
    expired: {
      label: "Expired",
      bg: "bg-rose-50",
      text: "text-rose-700",
      border: "border-rose-200",
    },
    unverified: {
      label: "Unverified",
      bg: "bg-slate-50",
      text: "text-slate-600",
      border: "border-slate-200",
    },
  };

  const current = configs[status] || configs.unverified;
  let title = current.label;
  if (sourceClinic) title += ` • Source: ${sourceClinic}`;
  if (verifiedBy) title += ` • By: ${verifiedBy}`;
  if (verifiedAt) title += ` • ${new Date(verifiedAt).toLocaleDateString()}`;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${current.bg} ${current.text} ${current.border}`}
      title={title}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-current opacity-75"
        aria-hidden="true"
      />
      {current.label}
    </span>
  );
}

