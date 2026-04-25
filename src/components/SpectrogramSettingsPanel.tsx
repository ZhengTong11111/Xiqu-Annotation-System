import type {
  SpectrogramAnalysisPreset,
  SpectrogramFrequencyPreset,
  SpectrogramFrequencyScale,
  SpectrogramSettings,
} from "../types";
import {
  spectrogramAnalysisPresets,
  spectrogramFrequencyPresets,
} from "../utils/spectrogram";

type SpectrogramSettingsPanelProps = {
  settings: SpectrogramSettings;
  isWaveformLoading: boolean;
  hasWaveformData: boolean;
  isLoading: boolean;
  hasData: boolean;
  onSettingsChange: (settings: SpectrogramSettings) => void;
};

export function SpectrogramSettingsPanel({
  settings,
  isWaveformLoading,
  hasWaveformData,
  isLoading,
  hasData,
  onSettingsChange,
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

  return (
    <section className="panel spectrogram-settings-panel">
      <div className="panel-header">
        <div className="panel-header-copy">
          <h2>音频轨道设置</h2>
          <span>{waveformStatusText} · 频谱{statusText}</span>
        </div>
      </div>

      <div className="spectrogram-settings-body">
        <div className="spectrogram-setting-group">
          <div className="spectrogram-setting-heading">
            <strong>波形图</strong>
            <span>{waveformStatusText}</span>
          </div>
          <div className="spectrogram-static-row">
            <strong>音频波形轨道</strong>
            <span>始终显示，用作频谱图设置入口和时间轴对齐参考。</span>
          </div>
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

type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
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
