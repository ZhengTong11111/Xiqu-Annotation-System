import { useEffect, useRef } from "react";
import {
  AudioLines,
  Check,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Settings2,
  Star,
  VolumeX,
} from "lucide-react";
import type {
  AnnotationAudioPlaybackOptions,
  MediaAudioTrackAvailability,
} from "@xiqu/shared";
import type { SynchronizedPlaybackState } from "../media/synchronizedPlaybackState";
import {
  describeSynchronizedPlaybackDiagnostic,
  type SynchronizedPlaybackDiagnostic,
} from "../media/synchronizedPlaybackDiagnostic";
import {
  findAudioTrackOption,
  getAudioTrackAvailabilityLabel,
  getAudioTrackKindLabel,
  getAudioTrackSourceLabel,
} from "../platform/platformAudioTrackSelection";

export type AudioTrackSelectorModel = {
  options: AnnotationAudioPlaybackOptions | null;
  selectedTrackId: string | null;
  loading: boolean;
  refreshing: boolean;
  loadError: string | null;
  runtimeState: SynchronizedPlaybackState;
  runtimeError: string | null;
  runtimeDiagnostic: SynchronizedPlaybackDiagnostic | null;
  canSetDefault: boolean;
  canManageTracks: boolean;
  defaultUpdatingTrackId: string | null;
  defaultUpdateError: string | null;
  onSelect: (trackId: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onSetDefault: (trackId: string) => void;
  onManageTracks: () => void;
};

type AudioTrackSelectorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: AudioTrackSelectorModel;
};

/** 顶栏只呈现高频试听与共享默认；新增、排序、偏移等低频管理不混入这个弹层。 */
export function AudioTrackSelector({
  open,
  onOpenChange,
  model,
}: AudioTrackSelectorProps) {
  const optionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedOption = findAudioTrackOption(model.options, model.selectedTrackId);
  const originalOption = model.options?.tracks.find(({ track }) => track.kind === "original") ?? null;
  const selectedName = selectedOption?.track.name ??
    (model.loading ? "读取音轨" : model.loadError ? "音轨不可用" : "选择音轨");
  const status = getSelectorStatus(model, selectedOption?.availability ?? null);
  const diagnosticSummary = describeSynchronizedPlaybackDiagnostic(
    model.runtimeDiagnostic,
  );
  const selectionError = model.selectedTrackId && !selectedOption
    ? "当前选择已失效，请刷新或选择其他音轨。"
    : selectedOption?.availability && selectedOption.availability !== "available"
      ? getAudioTrackAvailabilityLabel(selectedOption.availability)
      : null;
  const errorMessage = model.runtimeError ?? selectionError ??
    model.defaultUpdateError ?? model.loadError;
  const retryAction = model.runtimeError
    ? { label: "重试当前音轨", run: model.onRetry }
    : model.loadError || selectionError
      ? { label: "重新读取音轨", run: model.onRefresh }
      : null;

  useEffect(() => {
    if (!open || !model.options) return;
    const selectedIndex = model.options.tracks.findIndex(
      ({ track }) => track.id === model.selectedTrackId,
    );
    optionButtonRefs.current[Math.max(0, selectedIndex)]?.focus();
  }, [model.options, model.selectedTrackId, open]);

  function moveOptionFocus(currentIndex: number, direction: -1 | 1) {
    const count = model.options?.tracks.length ?? 0;
    if (!count) return;
    const nextIndex = (currentIndex + direction + count) % count;
    optionButtonRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="audio-track-selector">
      <button
        type="button"
        className={`audio-track-selector-trigger ${open ? "is-open" : ""} ${status.tone}`.trim()}
        title={`监听音轨：${selectedName}（${status.label}）`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <AudioLines size={14} aria-hidden="true" />
        <span className="audio-track-selector-name">{selectedName}</span>
        <span className="audio-track-selector-status-dot" aria-hidden="true" />
      </button>

      {open ? (
        <div className="audio-track-selector-popover" aria-label="监听音轨">
          <div className="audio-track-selector-heading">
            <div>
              <strong>监听音轨</strong>
              <span>{status.label}</span>
            </div>
            <div className="audio-track-selector-heading-actions">
              {model.canManageTracks ? (
                <button
                  type="button"
                  className="icon-button"
                  title="管理监听音轨"
                  aria-label="管理监听音轨"
                  onClick={() => {
                    onOpenChange(false);
                    model.onManageTracks();
                  }}
                >
                  <Settings2 size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button audio-track-selector-refresh"
                title="刷新音轨与权限"
                aria-label="刷新音轨与权限"
                disabled={model.loading || model.refreshing}
                onClick={model.onRefresh}
              >
                <RefreshCw size={14} className={model.refreshing ? "is-spinning" : ""} />
              </button>
            </div>
          </div>

          {diagnosticSummary ? (
            <div className="audio-track-selector-diagnostic" role="status">
              {diagnosticSummary}
            </div>
          ) : null}

          {model.options ? (
            <div className="audio-track-selector-list" role="listbox" aria-label="可用监听音轨">
              {model.options.tracks.map((option, index) => {
                const selected = option.track.id === model.selectedTrackId;
                const available = option.availability === "available";
                const isDefault = option.track.kind === "original"
                  ? model.options?.defaultAudioTrackId === null
                  : model.options?.defaultAudioTrackId === option.track.id;
                return (
                  <div
                    key={option.track.id}
                    className={`audio-track-selector-row ${selected ? "is-selected" : ""} ${
                      available ? "" : "is-unavailable"
                    }`.trim()}
                  >
                    <button
                      ref={(element) => {
                        optionButtonRefs.current[index] = element;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={!available}
                      className="audio-track-selector-option"
                      title={available
                        ? `试听 ${option.track.name}`
                        : getAudioTrackAvailabilityLabel(option.availability)}
                      onClick={() => {
                        if (available) model.onSelect(option.track.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          moveOptionFocus(index, event.key === "ArrowDown" ? 1 : -1);
                        }
                        if (event.key === "Enter" && available) {
                          event.preventDefault();
                          model.onSelect(option.track.id);
                        }
                      }}
                    >
                      <span className="audio-track-selector-check" aria-hidden="true">
                        {selected ? <Check size={14} /> : null}
                      </span>
                      <span className="audio-track-selector-copy">
                        <strong>{option.track.name}</strong>
                        <span>
                          {getAudioTrackKindLabel(option.track.kind)} · {getAudioTrackSourceLabel(option)}
                          {!available ? ` · ${getAudioTrackAvailabilityLabel(option.availability)}` : ""}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`icon-button audio-track-default-button ${isDefault ? "is-default" : ""}`}
                      title={isDefault
                        ? "当前共享默认音轨"
                        : model.canSetDefault
                          ? "设为共享默认音轨"
                          : "当前账号不能修改共享默认音轨"}
                      aria-label={isDefault ? "当前共享默认音轨" : "设为共享默认音轨"}
                      disabled={
                        isDefault ||
                        !model.canSetDefault ||
                        Boolean(model.defaultUpdatingTrackId)
                      }
                      onClick={() => model.onSetDefault(option.track.id)}
                    >
                      <Star
                        size={13}
                        fill={isDefault ? "currentColor" : "none"}
                        className={model.defaultUpdatingTrackId === option.track.id ? "is-hidden" : ""}
                      />
                      {model.defaultUpdatingTrackId === option.track.id ? (
                        <LoaderCircle size={13} className="is-spinning audio-track-default-spinner" />
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="audio-track-selector-empty">
              <VolumeX size={18} aria-hidden="true" />
              <span>{model.loadError ?? "正在读取当前文件的监听音轨…"}</span>
            </div>
          )}

          {errorMessage ? (
            <div className="audio-track-selector-error" role="status">
              <span>{errorMessage}</span>
              <div className="audio-track-selector-error-actions">
                {originalOption && originalOption.track.id !== model.selectedTrackId &&
                originalOption.availability === "available" ? (
                  <button
                    type="button"
                    className="audio-track-selector-original-button"
                    onClick={() => model.onSelect(originalOption.track.id)}
                  >
                    视频原声
                  </button>
                ) : null}
                {retryAction ? (
                  <button
                    type="button"
                    className="icon-button"
                    title={retryAction.label}
                    aria-label={retryAction.label}
                    onClick={retryAction.run}
                  >
                    <RotateCcw size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getSelectorStatus(
  model: AudioTrackSelectorModel,
  availability: MediaAudioTrackAvailability | null,
) {
  if (model.loading) return { label: "正在读取", tone: "is-loading" };
  if (model.runtimeState.phase === "preparing_external" ||
    model.runtimeState.phase === "starting" ||
    model.runtimeState.phase === "resyncing") {
    return { label: "正在同步", tone: "is-loading" };
  }
  if (
    model.runtimeState.phase === "buffering_master" ||
    model.runtimeState.phase === "buffering_external"
  ) {
    return { label: "正在缓冲", tone: "is-loading" };
  }
  if (model.runtimeState.phase === "playing_synced") {
    return { label: "已同步", tone: "is-ready" };
  }
  if (model.runtimeState.phase === "ready_paused" ||
    model.runtimeState.phase === "original") {
    return { label: "已就绪", tone: "is-ready" };
  }
  if (availability && availability !== "available") {
    return { label: getAudioTrackAvailabilityLabel(availability), tone: "is-error" };
  }
  if (
    model.runtimeState.phase === "error_external" ||
    model.runtimeError ||
    model.loadError
  ) return { label: "播放受阻", tone: "is-error" };
  return { label: "等待选择", tone: "is-idle" };
}
