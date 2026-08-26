import { useEffect, useRef, useState } from "react";
import type {
  AnnotationAudioPlaybackTrackOption,
  AnnotationMediaAnalysisStatus,
} from "@xiqu/shared";
import type {
  InspectorFocusRequest,
  InspectorFocusTarget,
  SpectrogramAnalysisPreset,
  SpectrogramFrequencyPreset,
  SpectrogramFrequencyScale,
  SpectrogramSettings,
} from "../types";
import { Download, RefreshCw, X } from "lucide-react";
import {
  getAudioTrackAvailabilityLabel,
  getAudioTrackSourceLabel,
} from "../platform/platformAudioTrackSelection";
import {
  spectrogramAnalysisPresets,
  spectrogramFrequencyPresets,
} from "../utils/spectrogram";

type SpectrogramSettingsPanelProps = {
  settings: SpectrogramSettings;
  isWaveformLoading: boolean;
  hasWaveformData: boolean;
  waveformVisible: boolean;
  isLoading: boolean;
  hasData: boolean;
  analysisError?: string | null;
  onSettingsChange: (settings: SpectrogramSettings) => void;
  onWaveformVisibleChange: (visible: boolean) => void;
  // 与 InspectorPanel 共用同一个聚焦请求对象：顶栏搜索选中波形轨后，由本面板负责滚动并高亮对应分组。
  focusRequest?: InspectorFocusRequest | null;
  platformAnalysis?: {
    status: AnnotationMediaAnalysisStatus | null;
    canWrite: boolean;
    loading: boolean;
    mutationPending: boolean;
    error: string | null;
    followListening: boolean;
    analysisTrackId: string | null;
    analysisTrackOption: AnnotationAudioPlaybackTrackOption | null;
    trackOptions: AnnotationAudioPlaybackTrackOption[];
    onFollowListeningChange: (follow: boolean) => void;
    onFixedTrackChange: (trackId: string) => void;
    onStartAnalysis: (force: boolean) => void;
    preloadPending: boolean;
    preloadProgress: { completed: number; total: number } | null;
    preloadError: string | null;
    onStartPreload: () => void;
    onCancelPreload: () => void;
  };
};

export function SpectrogramSettingsPanel({
  settings,
  isWaveformLoading,
  hasWaveformData,
  waveformVisible,
  isLoading,
  hasData,
  analysisError,
  onSettingsChange,
  onWaveformVisibleChange,
  focusRequest,
  platformAnalysis,
}: SpectrogramSettingsPanelProps) {
  // 聚焦分组注册表：一个分组可以对应多个聚焦目标（例如「频谱图」同时承载可见性与 F0）。
  const focusGroupNodesRef = useRef(new Map<InspectorFocusTarget, HTMLElement>());
  const [highlightedFocusTarget, setHighlightedFocusTarget] = useState<InspectorFocusTarget | null>(null);
  const focusHighlightTimerRef = useRef<number | null>(null);

  // 组件卸载时清理高亮定时器，避免面板随选中项切换而消失后仍触发状态更新。
  useEffect(() => {
    return () => {
      if (focusHighlightTimerRef.current !== null) {
        window.clearTimeout(focusHighlightTimerRef.current);
      }
    };
  }, []);

  // 收到聚焦请求后滚动到目标分组并短暂高亮，行为与 InspectorPanel 保持一致。
  useEffect(() => {
    if (!focusRequest) {
      return;
    }
    const targetElement = focusGroupNodesRef.current.get(focusRequest.target) ?? null;
    if (!targetElement) {
      return;
    }
    targetElement.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedFocusTarget(focusRequest.target);
    if (focusHighlightTimerRef.current !== null) {
      window.clearTimeout(focusHighlightTimerRef.current);
    }
    focusHighlightTimerRef.current = window.setTimeout(() => {
      setHighlightedFocusTarget((current) => (current === focusRequest.target ? null : current));
      focusHighlightTimerRef.current = null;
    }, 1200);
  }, [focusRequest]);

  // 把一组聚焦目标绑定到同一个分组节点，并返回该分组当前是否处于高亮态。
  function focusGroupProps(targets: InspectorFocusTarget[]) {
    const isFocused = highlightedFocusTarget !== null && targets.includes(highlightedFocusTarget);
    return {
      ref: (element: HTMLElement | null) => {
        for (const target of targets) {
          if (element) {
            focusGroupNodesRef.current.set(target, element);
          } else {
            focusGroupNodesRef.current.delete(target);
          }
        }
      },
      className: `spectrogram-setting-group ${isFocused ? "is-focused" : ""}`.trim(),
    };
  }

  function updateSetting<K extends keyof SpectrogramSettings>(
    key: K,
    value: SpectrogramSettings[K],
  ) {
    onSettingsChange({
      ...settings,
      [key]: value,
    });
  }

  const statusText = !settings.visible
    ? "已隐藏"
    : isLoading
      ? "分析中"
      : hasData
        ? "预览已生成"
        : "等待音频";
  const waveformStatusText = isWaveformLoading
    ? "波形提取中"
    : hasWaveformData
      ? "波形已就绪"
      : "等待音频";
  const frequencyScaleOptions: Array<{
    value: SpectrogramFrequencyScale;
    label: string;
    hint: string;
  }> = [
    { value: "log", label: "Log", hint: "更适合观察人声走向" },
    { value: "mel", label: "Mel", hint: "接近听感压缩" },
    { value: "linear", label: "Linear", hint: "保留线性频率间距" },
  ];
  const frequencyPresetOptions = Object.entries(spectrogramFrequencyPresets) as Array<[
    SpectrogramFrequencyPreset,
    (typeof spectrogramFrequencyPresets)[SpectrogramFrequencyPreset],
  ]>;
  const analysisPresetOptions = Object.entries(spectrogramAnalysisPresets) as Array<[
    SpectrogramAnalysisPreset,
    (typeof spectrogramAnalysisPresets)[SpectrogramAnalysisPreset],
  ]>;
  const activeAnalysisPreset = spectrogramAnalysisPresets[settings.analysisPreset];
  const analysisRunActive = platformAnalysis?.status?.currentRun?.status === "queued" ||
    platformAnalysis?.status?.currentRun?.status === "running";
  const analysisSourceReady = platformAnalysis?.status?.audioTrackId ===
    platformAnalysis?.analysisTrackId &&
    platformAnalysis?.status?.resolvedSource.status === "ready";

  return (
    <section className="panel spectrogram-settings-panel">
      <div className="panel-header">
        <div className="panel-header-copy">
          <h2>音频轨道设置</h2>
          <span>{waveformStatusText} · 频谱{statusText}</span>
        </div>
      </div>

      <div className="spectrogram-settings-body">
        {analysisError ? (
          <p className="spectrogram-setting-error" role="alert">{analysisError}</p>
        ) : null}
        {platformAnalysis ? (
          <div {...focusGroupProps(["audio-analysis-track"])}>
            <div className="spectrogram-setting-heading">
              <strong>分析显示音轨</strong>
              <span>{platformAnalysis.followListening ? "跟随监听" : "固定音轨"}</span>
            </div>
            <ToggleRow
              label="分析显示跟随监听音轨"
              description="关闭后可固定分析音轨，试听切换不再改变波形和频谱。"
              checked={platformAnalysis.followListening}
              disabled={platformAnalysis.followListening && !platformAnalysis.analysisTrackId}
              onChange={platformAnalysis.onFollowListeningChange}
            />
            {!platformAnalysis.followListening ? (
              <label className="spectrogram-analysis-track-select">
                <span>固定分析音轨</span>
                <select
                  value={platformAnalysis.analysisTrackId ?? ""}
                  onChange={(event) => platformAnalysis.onFixedTrackChange(event.target.value)}
                >
                  {!platformAnalysis.analysisTrackId ? (
                    <option value="">请选择音轨</option>
                  ) : platformAnalysis.analysisTrackOption ? null : (
                    <option value={platformAnalysis.analysisTrackId}>已失效音轨</option>
                  )}
                  {platformAnalysis.trackOptions.map((option) => (
                    <option
                      key={option.track.id}
                      value={option.track.id}
                      disabled={option.availability !== "available"}
                    >
                      {option.track.name}
                      {option.availability === "available"
                        ? ""
                        : ` · ${getAudioTrackAvailabilityLabel(option.availability)}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="spectrogram-static-row">
              <span>{describeAnalysisTrack(platformAnalysis)}</span>
            </div>
            <div className="spectrogram-static-row">
              <span>{describeAnalysisRun(
                platformAnalysis.status,
                platformAnalysis.loading,
                platformAnalysis.analysisTrackId,
              )}</span>
            </div>
            {platformAnalysis.error ? (
              <p className="spectrogram-setting-error" role="alert">{platformAnalysis.error}</p>
            ) : null}
            {platformAnalysis.preloadError ? (
              <p className="spectrogram-setting-error" role="alert">
                {platformAnalysis.preloadError}
              </p>
            ) : null}
            {platformAnalysis.preloadProgress?.total ? (
              <div className="spectrogram-static-row" role="status">
                <span>
                  分析缓存 {platformAnalysis.preloadProgress.completed}/
                  {platformAnalysis.preloadProgress.total}
                </span>
              </div>
            ) : null}
            <div className="spectrogram-analysis-actions">
              <button
                type="button"
                disabled={
                  !platformAnalysis.canWrite ||
                  !platformAnalysis.analysisTrackId ||
                  !analysisSourceReady ||
                  platformAnalysis.mutationPending ||
                  analysisRunActive
                }
                onClick={() => platformAnalysis.onStartAnalysis(
                  platformAnalysis.status?.currentRun?.status === "succeeded" ||
                  platformAnalysis.status?.currentRun?.status === "failed",
                )}
              >
                <RefreshCw size={15} />
                {platformAnalysis.status?.currentRun?.status === "queued"
                  ? "排队中"
                  : platformAnalysis.status?.currentRun?.status === "running"
                    ? "分析中"
                    : platformAnalysis.status?.currentRun?.status === "succeeded"
                      ? "重新分析"
                    : "开始分析"}
              </button>
              <button
                type="button"
                disabled={
                  platformAnalysis.status?.audioTrackId !== platformAnalysis.analysisTrackId ||
                  platformAnalysis.status?.currentRun?.status !== "succeeded"
                }
                onClick={platformAnalysis.preloadPending
                  ? platformAnalysis.onCancelPreload
                  : platformAnalysis.onStartPreload}
              >
                {platformAnalysis.preloadPending ? <X size={15} /> : <Download size={15} />}
                {platformAnalysis.preloadPending ? "停止预加载" : "预加载分析数据"}
              </button>
            </div>
          </div>
        ) : null}
        <div {...focusGroupProps(["audio-waveform-visible"])}>
          <div className="spectrogram-setting-heading">
            <strong>波形图</strong>
            <span>{waveformStatusText}</span>
          </div>
          <ToggleRow
            label="音频波形轨道"
            description="关闭后从时间轴中移除；可从视图菜单或顶栏搜索重新打开。"
            checked={waveformVisible}
            onChange={onWaveformVisibleChange}
          />
        </div>

        <div {...focusGroupProps(["audio-spectrogram-visible", "audio-pitch-contour"])}>
          <div className="spectrogram-setting-heading">
            <strong>频谱图</strong>
            <span>{settings.visible ? "时间轴中显示" : "不占用轨道高度"}</span>
          </div>
          <ToggleRow
            label="人声频谱图"
            description="关闭后从时间轴移除，不再占位；可从视图菜单或顶栏搜索重新打开。"
            checked={settings.visible}
            onChange={(checked) => updateSetting("visible", checked)}
          />
          <ToggleRow
            label="F0 / Pitch contour"
            description="仅在 voiced frame 上叠加基频曲线。"
            checked={settings.showPitchContour}
            onChange={(checked) => updateSetting("showPitchContour", checked)}
          />
        </div>

        <div {...focusGroupProps(["audio-frequency-scale"])}>
          <div className="spectrogram-setting-heading">
            <strong>纵轴映射</strong>
            <span>{settings.frequencyScale}</span>
          </div>
          <div className="spectrogram-segmented-control" role="group" aria-label="频谱图纵轴映射">
            {frequencyScaleOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={settings.frequencyScale === option.value ? "active" : ""}
                aria-pressed={settings.frequencyScale === option.value}
                title={option.hint}
                onClick={() => updateSetting("frequencyScale", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="spectrogram-setting-help">
            Log 默认用于看唱腔/念白的音高走势；Mel 可作为听感参考，Linear 便于检查原始频率分布。
          </p>
        </div>

        <div {...focusGroupProps(["audio-frequency-preset"])}>
          <div className="spectrogram-setting-heading">
            <strong>频率范围</strong>
            <span>{spectrogramFrequencyPresets[settings.frequencyPreset].label}</span>
          </div>
          <div className="spectrogram-preset-list">
            {frequencyPresetOptions.map(([value, preset]) => (
              <button
                key={value}
                type="button"
                className={settings.frequencyPreset === value ? "active" : ""}
                aria-pressed={settings.frequencyPreset === value}
                onClick={() => updateSetting("frequencyPreset", value)}
              >
                <span>{preset.label}</span>
                <small>{preset.minFrequency}-{preset.maxFrequency} Hz</small>
              </button>
            ))}
          </div>
        </div>

        <div {...focusGroupProps(["audio-analysis-preset"])}>
          <div className="spectrogram-setting-heading">
            <strong>分析精度</strong>
            <span>{activeAnalysisPreset.label}</span>
          </div>
          <div className="spectrogram-preset-list">
            {analysisPresetOptions.map(([value, preset]) => (
              <button
                key={value}
                type="button"
                className={settings.analysisPreset === value ? "active" : ""}
                aria-pressed={settings.analysisPreset === value}
                onClick={() => updateSetting("analysisPreset", value)}
              >
                <span>{preset.label}</span>
                <small>n_fft={preset.fftSize} · hop={preset.hopLength}</small>
              </button>
            ))}
          </div>
          <p className="spectrogram-setting-help">{activeAnalysisPreset.description}</p>
        </div>

        <div className="spectrogram-analysis-summary">
          <strong>STFT</strong>
          <span>
            n_fft={activeAnalysisPreset.fftSize} · hop={activeAnalysisPreset.hopLength} · Hann · dB heatmap · Worker 离线计算
          </span>
        </div>
      </div>
    </section>
  );
}

function describeAnalysisTrack(platformAnalysis: NonNullable<
  SpectrogramSettingsPanelProps["platformAnalysis"]
>) {
  if (!platformAnalysis.analysisTrackId) return "正在等待监听音轨";
  const option = platformAnalysis.analysisTrackOption;
  if (!option) return "当前分析音轨已失效";
  if (option.availability !== "available") {
    return `${option.track.name} · ${getAudioTrackAvailabilityLabel(option.availability)}`;
  }
  return `${option.track.name} · ${getAudioTrackSourceLabel(option)}`;
}

function describeAnalysisRun(
  status: AnnotationMediaAnalysisStatus | null,
  loading: boolean,
  analysisTrackId: string | null,
) {
  if (!analysisTrackId) return "尚未选择可分析音轨";
  if (loading && !status) return "正在读取分析状态";
  if (!status || status.audioTrackId !== analysisTrackId) return "等待当前音轨分析状态";
  if (status.resolvedSource.status === "unavailable") {
    if (status.resolvedSource.code === "analysis_audio_forbidden") return "无权读取分析音频";
    if (status.resolvedSource.code === "analysis_source_invalid") return "当前分析音轨来源已失效";
    return "尚未关联可分析来源";
  }
  const run = status?.currentRun;
  if (!run) return "尚未生成波形、频谱和 F0";
  if (run.status === "queued") return "已进入后台分析队列";
  if (run.status === "running") return `后台分析中 · ${Math.round(run.progress * 100)}%`;
  if (run.status === "failed") return `分析失败 · ${run.errorCode ?? "analysis_failed"}`;
  return `分析完成 · ${run.duration?.toFixed(1) ?? "?"} 秒`;
}

export type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

export function ToggleRow({ label, description, checked, disabled = false, onChange }: ToggleRowProps) {
  return (
    <label className={`spectrogram-toggle-row ${disabled ? "is-disabled" : ""}`.trim()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="spectrogram-toggle-switch" aria-hidden="true" />
      <span className="spectrogram-toggle-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}
