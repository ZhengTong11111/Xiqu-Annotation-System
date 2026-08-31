import * as ContextMenu from "@radix-ui/react-context-menu";
import type { SentenceAnnotationConfig, SubtitleLine } from "../types";
import { formatSecondsToSrtTime } from "../utils/srt";
import {
  getSentenceDeliveryModeLabel,
  isSentenceClassificationComplete,
  SENTENCE_DELIVERY_MODE_OPTIONS,
} from "../utils/sentenceClassification";
import { toggleSentenceRoleType } from "../utils/sentenceRoleSelection";

type SubtitleListProps = {
  subtitleLines: SubtitleLine[];
  sentenceAnnotationConfig: SentenceAnnotationConfig;
  currentTime: number;
  selectedLineId: string | null;
  onSelectLine: (lineId: string) => void;
  onClassificationChange: (
    lineId: string,
    changes: Partial<Pick<SubtitleLine, "deliveryMode" | "roleTypes">>,
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
                    <span>{line.roleTypes.length > 0 ? line.roleTypes.join("、") : "角色未选"}</span>
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
                        <ContextMenu.Item
                          disabled={line.roleTypes.length === 0}
                          onSelect={() => onClassificationChange(line.id, { roleTypes: [] })}
                        >
                          清空角色
                        </ContextMenu.Item>
                        <ContextMenu.Separator className="character-context-menu-divider" />
                        {sentenceAnnotationConfig.roleOptions.length === 0
                          ? <ContextMenu.Item disabled>尚未设置角色行当</ContextMenu.Item>
                          : sentenceAnnotationConfig.roleOptions.map((role) => (
                              <ContextMenu.CheckboxItem
                                key={role}
                                checked={line.roleTypes.includes(role)}
                                // 多选菜单保持展开，方便一次为合说句勾选所有角色。
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => {
                                  onClassificationChange(line.id, {
                                    roleTypes: toggleSentenceRoleType(
                                      sentenceAnnotationConfig.roleOptions,
                                      line.roleTypes,
                                      role,
                                      checked,
                                    ),
                                  });
                                }}
                              >
                                <ContextMenu.ItemIndicator>✓ </ContextMenu.ItemIndicator>
                                {role}
                              </ContextMenu.CheckboxItem>
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
