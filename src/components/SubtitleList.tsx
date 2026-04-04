import type { SubtitleLine } from "../types";
import { formatSecondsToSrtTime } from "../utils/srt";

type SubtitleListProps = {
  subtitleLines: SubtitleLine[];
  currentTime: number;
  selectedLineId: string | null;
  onSelectLine: (lineId: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

export function SubtitleList({
  subtitleLines,
  currentTime,
  selectedLineId,
  onSelectLine,
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
          return (
            <button
              key={line.id}
              className={[
                "subtitle-item",
                isActive ? "active" : "",
                isSelected ? "selected" : "",
              ].join(" ")}
              onClick={() => onSelectLine(line.id)}
            >
              <div className="subtitle-time">
                {formatSecondsToSrtTime(line.startTime)} - {formatSecondsToSrtTime(line.endTime)}
              </div>
              <div className="subtitle-text">{line.text}</div>
            </button>
          );
        })}
        </div>
      ) : null}
    </section>
  );
}
