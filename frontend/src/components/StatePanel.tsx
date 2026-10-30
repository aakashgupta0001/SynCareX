import type { ReactNode } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <div className="state-panel state-error" role="alert">
      <CircleAlert size={19} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-mark">
        <CircleAlert size={20} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
