import type {
  ActionAnnotation,
  CharacterAnnotation,
  CustomTrack,
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
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  onCharacterUpdate: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionUpdate: (id: string, changes: Partial<ActionAnnotation>) => void;
  onCustomTrackRename: (trackId: string, name: string) => void;
  onCustomTrackTypeOptionChange: (trackId: string, index: number, value: string) => void;
  onAddCustomTrackTypeOption: (trackId: string) => void;
  onRemoveCustomTrackTypeOption: (trackId: string, index: number) => void;
  onDeleteCustomTrack: (trackId: string) => void;
  onCustomBlockUpdate: (
    trackId: string,
    blockId: string,
    changes: {
      startTime?: number;
      endTime?: number;
      text?: string;
      type?: string;
    },
  ) => void;
  onDeleteSelected: () => void;
};

export function InspectorPanel({
  selectedItem,
  subtitleLines,
  characterAnnotations,
  actionAnnotations,
  customTracks,
  trackDefinitions,
  onCharacterUpdate,
  onActionUpdate,
  onCustomTrackRename,
  onCustomTrackTypeOptionChange,
  onAddCustomTrackTypeOption,
  onRemoveCustomTrackTypeOption,
  onDeleteCustomTrack,
  onCustomBlockUpdate,
  onDeleteSelected,
}: InspectorPanelProps) {
  if (!selectedItem) {
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>属性面板</h2>
        </div>
        <p className="empty-state">选择一句字幕、一个 block、或一条自定义轨道后可在这里编辑属性。</p>
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

  if (selectedItem.type === "custom-track") {
    const track = customTracks.find((item) => item.id === selectedItem.id);
    if (!track) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>轨道设置</h2>
          <button onClick={() => onDeleteCustomTrack(track.id)}>删除轨道</button>
        </div>
        <div className="inspector-field">
          <label>轨道名称</label>
          <input
            value={track.name}
            onChange={(event) => onCustomTrackRename(track.id, event.target.value)}
          />
        </div>
        <div className="inspector-field">
          <label>轨道类型</label>
          <div className="inspector-value">
            {track.trackType === "text" ? "文字类轨道" : "动作类轨道"}
          </div>
        </div>
        <div className="inspector-field">
          <label>类型列表</label>
          <div className="track-option-list">
            {track.typeOptions.map((option, index) => (
              <div key={`${track.id}-${index}`} className="track-option-row">
                <input
                  value={option}
                  onChange={(event) =>
                    onCustomTrackTypeOptionChange(track.id, index, event.target.value)
                  }
                />
                <button
                  type="button"
                  onClick={() => onRemoveCustomTrackTypeOption(track.id, index)}
                  disabled={track.typeOptions.length <= 1}
                >
                  删除
                </button>
              </div>
            ))}
            <button type="button" onClick={() => onAddCustomTrackTypeOption(track.id)}>
              新增类型
            </button>
          </div>
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

  if (selectedItem.type === "custom-block") {
    const track = customTracks.find((item) => item.id === selectedItem.trackId);
    const block = track?.blocks.find((item) => item.id === selectedItem.id);
    if (!track || !block) {
      return null;
    }
    return (
      <section className="panel inspector-panel">
        <div className="panel-header">
          <h2>{track.trackType === "text" ? "文字 block" : "动作 block"}</h2>
          <button onClick={onDeleteSelected}>删除</button>
        </div>
        <div className="inspector-field">
          <label>轨道</label>
          <div className="inspector-value">{track.name}</div>
        </div>
        {track.trackType === "text" ? (
          <div className="inspector-field">
            <label>文本内容</label>
            <input
              value={getOptionalBlockText(block as unknown as { text?: string })}
              onChange={(event) =>
                onCustomBlockUpdate(track.id, block.id, { text: event.target.value })
              }
            />
          </div>
        ) : null}
        <div className="inspector-field">
          <label>类型</label>
          <select
            value={block.type}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { type: event.target.value })
            }
          >
            {track.typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="inspector-field">
          <label>开始时间</label>
          <input
            type="number"
            step="0.001"
            value={block.startTime}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { startTime: Number(event.target.value) })
            }
          />
        </div>
        <div className="inspector-field">
          <label>结束时间</label>
          <input
            type="number"
            step="0.001"
            value={block.endTime}
            onChange={(event) =>
              onCustomBlockUpdate(track.id, block.id, { endTime: Number(event.target.value) })
            }
          />
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
          {(track?.options ?? ["其他"]).map((label) => (
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

function getOptionalBlockText(block: { text?: string }) {
  return typeof block.text === "string" ? block.text : "";
}
