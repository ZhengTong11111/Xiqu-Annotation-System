import type { ReactNode } from "react";

type PreviewPanelProps = {
  children: ReactNode;
};

export function PreviewPanel({ children }: PreviewPanelProps) {
  return (
    <div className="workspace-pane-slot preview-pane-slot">
      {children}
    </div>
  );
}
