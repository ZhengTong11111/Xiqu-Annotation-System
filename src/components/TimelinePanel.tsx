import type { ReactNode } from "react";

type TimelinePanelProps = {
  children: ReactNode;
};

export function TimelinePanel({ children }: TimelinePanelProps) {
  return (
    <div className="workspace-pane-slot timeline-pane-slot">
      {children}
    </div>
  );
}
