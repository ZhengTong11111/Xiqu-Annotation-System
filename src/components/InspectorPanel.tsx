import type {
  ActionAnnotation,
  CharacterAnnotation,
  SelectedItem,
  SubtitleLine,
  TrackDefinition,
} from "../types";
import { singingStyleOptions } from "../utils/project";

type InspectorPanelProps = {
  selectedItem: SelectedItem;
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  trackDefinitions: TrackDefinition[];
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onDeleteSelected: () => void;
};

export function InspectorPanel({
  selectedItem,
  subtitleLines,
  characterAnnotations,
  actionAnnotations,
  trackDefinitions,
  onCharacterUpdate,
  onActionUpdate,
  onDeleteSelected,
}: InspectorPanelProps) {
  if (!selectedItem) {
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>属性面板</h2>
        </div>
        <p className="empty-state">选择一句字幕、一个字块或一个动作片段后可在这里编辑属性。</p>
      </section>
    );
  }

  if (selectedItem.type === "line") {
    const line = subtitleLines.find((item) => item.id === selectedItem.id);
    if (!line) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>句子属性</h2>
        </div>
        <div className="inspector-field">
          <label>文本</label>
          <div className="inspector-value">{line.text}</div>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <div className="inspector-value">{line.startTime.toFixed(3)}s</div>
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <div className="inspector-value">{line.endTime.toFixed(3)}s</div>
        </div>
      </section>
    );
  }

  if (selectedItem.type === "character") {
    const item = characterAnnotations.find((annotation) => annotation.id === selectedItem.id);
    if (!item) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>逐字属性</h2>
          <button onClick={onDeleteSelected}>删除</button>
        </div>
        <div className="inspector-field">
          <label>字</label>
          <div className="inspector-value character-preview">{item.char}</div>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <input
            type="number"
            step="0.001"
            value={item.startTime}
            onChange={(event) =>
              onCharacterUpdate(item.id, { startTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <input
            type="number"
            step="0.001"
            value={item.endTime}
            onChange={(event) =>
              onCharacterUpdate(item.id, { endTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>唱腔类型</label>
          <select
            value={item.singingStyle}
            onChange={(event) =>
              onCharacterUpdate(item.id, {
                singingStyle: event.target.value as CharacterAnnotation["singingStyle"],
              })
            }
          >
            {singingStyleOptions.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </div>
      </section>
    );
  }

  const action = actionAnnotations.find((annotation) => annotation.id === selectedItem.id);
  if (!action) {
    return null;
  }
  const track = trackDefinitions.find((item) => item.id === action.trackId);
  return (
    <section className="panel inspector-panel">
      <div className="panel-header">
        <h2>动作属性</h2>
        <button onClick={onDeleteSelected}>删除</button>
      </div>
      <div className="inspector-field">
        <label>轨道</label>
        <div className="inspector-value">{track?.name ?? action.trackId}</div>
      </div>
      <div className="inspector-field">
        <label>标签</label>
        <select
          value={action.label}
          onChange={(event) => onActionUpdate(action.id, { label: event.target.value })}
        >
          {(track?.labels ?? ["其他"]).map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="inspector-field">
        <label>开始时间</label>
        <input
          type="number"
          step="0.001"
          value={action.startTime}
          onChange={(event) => onActionUpdate(action.id, { startTime: Number(event.target.value) })}
        />
      </div>
      <div className="inspector-field">
        <label>结束时间</label>
        <input
          type="number"
          step="0.001"
          value={action.endTime}
          onChange={(event) => onActionUpdate(action.id, { endTime: Number(event.target.value) })}
        />
      </div>
    </section>
  );
}
