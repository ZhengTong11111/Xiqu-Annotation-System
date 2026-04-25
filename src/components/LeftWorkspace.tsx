import type { ReactNode } from "react";
import { ResizableSplitLayout } from "./ResizableSplitLayout";

type LeftWorkspaceProps = {
  previewPanel: ReactNode;
  timelinePanel: ReactNode;
  previewDetached?: boolean;
  timelineDetached?: boolean;
};

export function LeftWorkspace({
  previewPanel,
  timelinePanel,
  previewDetached = false,
  timelineDetached = false,
}: LeftWorkspaceProps) {
  if (previewDetached && timelineDetached) {
    return <section className="left-workspace left-workspace-empty" />;
  }

  if (previewDetached) {
    return (
      <section className="left-workspace">
        <div className="workspace-pane left-workspace-single-pane">
          {timelinePanel}
        </div>
      </section>
    );
  }

  if (timelineDetached) {
    return (
      <section className="left-workspace">
        <div className="workspace-pane left-workspace-single-pane">
          {previewPanel}
        </div>
      </section>
    );
  }

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
