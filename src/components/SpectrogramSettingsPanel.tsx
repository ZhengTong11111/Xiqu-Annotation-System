import type { AnnotationMediaAnalysisStatus } from "@xiqu/shared";
import type {
  SpectrogramAnalysisPreset,
  SpectrogramFrequencyPreset,
  SpectrogramFrequencyScale,
  SpectrogramSettings,
} from "../types";
import { Download, FolderOpen, RefreshCw, RotateCcw, X } from "lucide-react";
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
  platformAnalysis?: {
    status: AnnotationMediaAnalysisStatus | null;
    canWrite: boolean;
    loading: boolean;
    mutationPending: boolean;
    error: string | null;
    onChooseSource: () => void;
    onRestoreAutomatic: () => void;
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
  platformAnalysis,
}: SpectrogramSettingsPanelProps) {
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
          <div className="spectrogram-setting-group">
            <div className="spectrogram-setting-heading">
              <strong>分析音频来源</strong>
              <span>{describeAnalysisSource(platformAnalysis.status)}</span>
            </div>
            <div className="spectrogram-static-row">
              <span>{describeAnalysisRun(platformAnalysis.status, platformAnalysis.loading)}</span>
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
            <div className="spectrogram-analysis-source-actions">
              <button
                type="button"
                disabled={!platformAnalysis.canWrite || platformAnalysis.mutationPending}
                onClick={platformAnalysis.onChooseSource}
              >
                <FolderOpen size={15} />选择分析音频
              </button>
              {platformAnalysis.status?.setting.mode === "media_override" ? (
                <button
                  type="button"
                  disabled={!platformAnalysis.canWrite || platformAnalysis.mutationPending}
                  onClick={platformAnalysis.onRestoreAutomatic}
                >
                  <RotateCcw size={15} />恢复自动
                </button>
              ) : null}
              <button
                type="button"
                disabled={
                  !platformAnalysis.canWrite ||
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
                disabled={platformAnalysis.status?.currentRun?.status !== "succeeded"}
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
        <div className="spectrogram-setting-group">
          <div className="spectrogram-setting-heading">
            <strong>波形图</strong>
            <span>{waveformStatusText}</span>
          </div>
          <ToggleRow
            label="音频波形轨道"
            description="关闭后从时间轴中移除；可从视图菜单重新打开。"
            checked={waveformVisible}
            onChange={onWaveformVisibleChange}
          />
        </div>

        <div className="spectrogram-setting-group">
          <div className="spectrogram-setting-heading">
            <strong>频谱图</strong>
            <span>{settings.visible ? "时间轴中显示" : "不占用轨道高度"}</span>
          </div>
          <ToggleRow
            label="人声频谱图"
            description="关闭后从时间轴移除，不再占位；可从波形图设置重新打开。"
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

        <div className="spectrogram-setting-group">
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

        <div className="spectrogram-setting-group">
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

        <div className="spectrogram-setting-group">
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

function describeAnalysisSource(status: AnnotationMediaAnalysisStatus | null) {
  if (!status) return "正在读取";
  if (status.resolvedSource.status === "ready") {
    const prefix = status.setting.mode === "auto" ? "自动" : "强制";
    return `${prefix} · ${status.resolvedSource.mediaName}`;
  }
  if (status.resolvedSource.code === "analysis_audio_forbidden") return "来源无读取权限";
  if (status.resolvedSource.code === "analysis_source_invalid") return "来源已失效";
  return "尚未关联来源";
}

function describeAnalysisRun(
  status: AnnotationMediaAnalysisStatus | null,
  loading: boolean,
) {
  if (loading && !status) return "正在读取分析状态";
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
  onChange: (checked: boolean) => void;
};

export function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="spectrogram-toggle-row">
      <input
        type="checkbox"
        checked={checked}
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
