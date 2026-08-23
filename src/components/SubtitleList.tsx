import * as ContextMenu from "@radix-ui/react-context-menu";
import type { SentenceAnnotationConfig, SubtitleLine } from "../types";
import { formatSecondsToSrtTime } from "../utils/srt";
import {
  getSentenceDeliveryModeLabel,
  isSentenceClassificationComplete,
  SENTENCE_DELIVERY_MODE_OPTIONS,
} from "../utils/sentenceClassification";

type SubtitleListProps = {
  subtitleLines: SubtitleLine[];
  sentenceAnnotationConfig: SentenceAnnotationConfig;
  currentTime: number;
  selectedLineId: string | null;
  onSelectLine: (lineId: string) => void;
  onClassificationChange: (
    lineId: string,
    changes: Partial<Pick<SubtitleLine, "deliveryMode" | "roleType">>,
  ) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

export function SubtitleList({
  subtitleLines,
  sentenceAnnotationConfig,
  currentTime,
  selectedLineId,
  onSelectLine,
  onClassificationChange,
  collapsed = false,
  onToggleCollapse,
}: SubtitleListProps) {
  return (
    <section className={["panel", "subtitle-panel", collapsed ? "is-collapsed" : ""].join(" ")}>
      <div className="panel-header">
        <h2>句级字幕</h2>
        <div className="panel-header-actions">
          {!collapsed ? <span>{subtitleLines.length} 句</span> : null}
          {onToggleCollapse ? (
            <button
              type="button"
              className="panel-collapse-button"
              title={collapsed ? "展开面板" : "最小化面板"}
              aria-label={collapsed ? "展开面板" : "最小化面板"}
              onClick={onToggleCollapse}
            >
              {collapsed ? "▸" : "—"}
            </button>
          ) : null}
        </div>
      </div>
      {!collapsed ? (
        <div className="subtitle-list">
        {subtitleLines.map((line) => {
          const isActive = currentTime >= line.startTime && currentTime <= line.endTime;
          const isSelected = selectedLineId === line.id;
          const isComplete = isSentenceClassificationComplete(line, sentenceAnnotationConfig);
          return (
            <ContextMenu.Root key={line.id}>
              <ContextMenu.Trigger asChild>
                <button
                  className={[
                    "subtitle-item",
                    isComplete ? "classification-complete" : "classification-incomplete",
                    isActive ? "active" : "",
                    isSelected ? "selected" : "",
                  ].join(" ")}
                  onClick={() => onSelectLine(line.id)}
                >
                  <div className="subtitle-time">
                    {formatSecondsToSrtTime(line.startTime)} - {formatSecondsToSrtTime(line.endTime)}
                  </div>
                  <div className="subtitle-text">{line.text}</div>
                  <div className="subtitle-classification-summary">
                    <span>{getSentenceDeliveryModeLabel(line.deliveryMode)}</span>
                    <span>{line.roleType ?? "角色未选"}</span>
                  </div>
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="sentence-context-menu">
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger>发声方式</ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent className="sentence-context-menu">
                        <ContextMenu.Item onSelect={() =>
                          onClassificationChange(line.id, { deliveryMode: null })}>
                          {line.deliveryMode === null ? "✓ " : ""}未选择
                        </ContextMenu.Item>
                        {SENTENCE_DELIVERY_MODE_OPTIONS.map((option) => (
                          <ContextMenu.Item key={option.value} onSelect={() =>
                            onClassificationChange(line.id, { deliveryMode: option.value })}>
                            {line.deliveryMode === option.value ? "✓ " : ""}{option.label}
                          </ContextMenu.Item>
                        ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger>角色行当</ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent className="sentence-context-menu">
                        <ContextMenu.Item onSelect={() =>
                          onClassificationChange(line.id, { roleType: null })}>
                          {line.roleType === null ? "✓ " : ""}未选择
                        </ContextMenu.Item>
                        {sentenceAnnotationConfig.roleOptions.length === 0
                          ? <ContextMenu.Item disabled>尚未设置角色行当</ContextMenu.Item>
                          : sentenceAnnotationConfig.roleOptions.map((role) => (
                              <ContextMenu.Item key={role} onSelect={() =>
                                onClassificationChange(line.id, { roleType: role })}>
                                {line.roleType === role ? "✓ " : ""}{role}
                              </ContextMenu.Item>
                            ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
        </div>
      ) : null}
    </section>
  );
}
