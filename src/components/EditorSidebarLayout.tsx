import type { ReactNode } from "react";
import { ResizableSplitLayout } from "./ResizableSplitLayout";

type EditorSidebarLayoutProps = {
  subtitlePanel: ReactNode;
  splitPanel: ReactNode;
  confirmationPanel: ReactNode | null;
  inspectorPanel: ReactNode;
  subtitleCollapsed: boolean;
  splitCollapsed: boolean;
  confirmationCollapsed: boolean;
};

/**
 * 右侧编辑区按四个同级面板逐层切分。标注确认不再嵌入 Inspector，
 * 因此每一层都有独立拖柄，隐藏确认面板时 Inspector 会直接接管剩余空间。
 */
export function EditorSidebarLayout(props: EditorSidebarLayoutProps) {
  // 标注确认隐藏时不保留空白分栏，属性面板直接接管下半区。
  const inspectorRegion = props.confirmationPanel ? (
    <ResizableSplitLayout
      orientation="vertical"
      initialPrimarySize={0.5}
      minPrimarySize={160}
      minSecondarySize={180}
      storageKey="layout:sidebar-confirmation:v1"
      className="sidebar-stack"
      primaryClassName="workspace-pane sidebar-pane"
      secondaryClassName="workspace-pane sidebar-pane"
      collapsedPrimary={props.confirmationCollapsed}
      collapsedSize={42}
      primary={props.confirmationPanel}
      secondary={props.inspectorPanel}
    />
  ) : props.inspectorPanel;

  return (
    <ResizableSplitLayout
      orientation="vertical"
      initialPrimarySize={0.25}
      minPrimarySize={150}
      minSecondarySize={360}
      storageKey="layout:sidebar-workspace:v2"
      className="sidebar-shell"
      primaryClassName="workspace-pane sidebar-pane"
      secondaryClassName="workspace-pane sidebar-pane"
      collapsedPrimary={props.subtitleCollapsed}
      collapsedSize={42}
      primary={props.subtitlePanel}
      secondary={
        <ResizableSplitLayout
          orientation="vertical"
          initialPrimarySize={1 / 3}
          minPrimarySize={150}
          minSecondarySize={300}
          storageKey="layout:sidebar-detail:v2"
          className="sidebar-stack"
          primaryClassName="workspace-pane sidebar-pane"
          secondaryClassName="workspace-pane sidebar-pane"
          collapsedPrimary={props.splitCollapsed}
          collapsedSize={42}
          primary={props.splitPanel}
          secondary={inspectorRegion}
        />
      }
    />
  );
}
