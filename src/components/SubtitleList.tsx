import type { SubtitleLine } from "../types";
import { formatSecondsToSrtTime } from "../utils/srt";

type SubtitleListProps = {
  subtitleLines: SubtitleLine[];
  currentTime: number;
  selectedLineId: string | null;
  onSelectLine: (lineId: string) => void;
};

export function SubtitleList({
  subtitleLines,
  currentTime,
  selectedLineId,
  onSelectLine,
}: SubtitleListProps) {
  return (
    <section className="panel subtitle-panel">
      <div className="panel-header">
        <h2>句级字幕</h2>
        <span>{subtitleLines.length} 句</span>
      </div>
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
    </section>
  );
}
