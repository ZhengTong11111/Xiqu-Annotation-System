import type { ReactNode } from "react";
import { ResizableSplitLayout } from "./ResizableSplitLayout";

type LeftWorkspaceProps = {
  previewPanel: ReactNode;
  timelinePanel: ReactNode;
};

export function LeftWorkspace({ previewPanel, timelinePanel }: LeftWorkspaceProps) {
  return (
    <section className="left-workspace">
      <ResizableSplitLayout
        orientation="vertical"
        initialPrimarySize={0.46}
        minPrimarySize={240}
        minSecondarySize={280}
        storageKey="layout:left-workspace"
        className="left-workspace-split"
        primaryClassName="workspace-pane"
        secondaryClassName="workspace-pane"
        primary={previewPanel}
        secondary={timelinePanel}
      />
    </section>
  );
}
