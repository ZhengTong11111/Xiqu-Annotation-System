import type {
  AttachedPointTrack,
  BuiltinTrack,
  CustomTrack,
  InspectorFocusTarget,
} from "../types";

// 本模块是顶栏「搜索」菜单的功能目录：只描述“有哪些可搜索的功能项、它们叫什么、藏在哪条路径下”，
// 不持有任何 React 状态，也不知道如何执行。真正的执行/勾选状态由 App 在运行时按 id 映射补齐。
// 这样做的目的是让目录保持纯函数、可被 node --test 覆盖，同时避免搜索变成第二套设置实现。

// 静态命令 id 使用字面量联合，App 侧的运行时映射按同一份联合类型建表；
// 新增定义却忘记接线时，tsc 会在编译期直接报错，而不是等到用户点出一个空按钮。
export type LocalStaticCommandId =
  | "file.import-video"
  | "file.import-srt"
  | "file.import-project"
  | "file.import-merge-project"
  | "file.save-local"
  | "file.export-character-srt"
  | "file.export-singing-srt"
  | "edit.undo"
  | "edit.redo"
  | "edit.repair-sentence-character-track"
  | "playback.toggle"
  | "playback.step-back-100ms"
  | "playback.step-forward-100ms"
  | "playback.step-back-frame"
  | "playback.step-forward-frame"
  | "playback.rate-0.5"
  | "playback.rate-0.75"
  | "playback.rate-1"
  | "playback.rate-1.25"
  | "playback.rate-1.5"
  | "playback.toggle-loop"
  | "playback.clear-loop-range"
  | "view.waveform"
  | "view.spectrogram"
  | "view.banyan-track"
  | "view.banyan-grid"
  | "audio.panel"
  | "audio.pitch-contour"
  | "audio.frequency-scale"
  | "audio.frequency-preset"
  | "audio.analysis-preset";

// 平台命令只有在平台编辑会话下才会被 App 写入运行时映射；本地模式下它们不会出现在搜索结果里，
// 因此不需要额外的禁用文案，也不可能被点成报错入口。
export type PlatformStaticCommandId =
  | "file.bind-server-media"
  | "file.save-server"
  | "view.annotation-confirmation-docked"
  | "view.annotation-confirmation-detached"
  | "audio.analysis-source";

export type StaticCommandId = LocalStaticCommandId | PlatformStaticCommandId;

// 轨道级设置随项目动态展开，id 由轨道 id 和字段名拼成，保证同一字段在不同轨道上互不冲突。
export type TrackCommandFieldKey =
  | "name"
  | "color"
  | "branching"
  | "track-snap"
  | "waveform-snap"
  | "auto-loop-range"
  | "parent-boundary-snap"
  | "type-options"
  | "attached-point-tracks"
  | "gongche-import";

export type TrackCommandId = `track:${string}:${TrackCommandFieldKey}`;

export type CommandId = StaticCommandId | TrackCommandId;

// 命令目标决定 App 用哪条既有路径去执行：静态项直接调用现成 handler；
// 轨道/音频设置项统一走「选中对象 + 请求 Inspector 聚焦」的既有导航模式。
export type CommandTarget =
  | { kind: "static" }
  | {
      kind: "track-setting";
      trackId: string;
      trackKind: "builtin" | "custom" | "attached-point";
      parentTrackId?: string;
      field: TrackCommandFieldKey;
      focusTarget: InspectorFocusTarget;
      // 开关类字段在搜索结果里直接翻转（与点开关等价），其余字段只做定位。
      toggle: boolean;
    }
  | { kind: "audio-setting"; focusTarget: InspectorFocusTarget };

export type CommandDefinition = {
  id: CommandId;
  // 结果条目的主标题，尽量与用户在真实 UI 上看到的文案一致。
  label: string;
  // 面包屑路径，既用于展示（视图 › 音频波形），也参与搜索打分。
  path: string[];
  // 中英同义词。中文按子串匹配，英文/缩写靠这里补全（loop、f0、stft…）。
  keywords: string[];
  // 空查询时展示的默认列表，用来当作「常用功能」入口。
  featured?: boolean;
  target: CommandTarget;
};

// 静态目录收窄 id 类型，使 App 侧可以用 Record<StaticId, Runtime> 直接索引而无需类型断言。
export type StaticCommandDefinition<Id extends StaticCommandId> = CommandDefinition & { id: Id };

// 顶栏 文件 / 编辑 / 播放 / 视图 四个菜单里本地模式恒定可用的条目。
// 顺序与 TopMenuBar 的实际菜单顺序保持一致，便于对照检查是否有遗漏。
export const LOCAL_STATIC_COMMAND_DEFINITIONS: StaticCommandDefinition<LocalStaticCommandId>[] = [
  {
    id: "file.import-video",
    label: "导入本地视频",
    path: ["文件", "导入本地视频"],
    keywords: ["video", "import", "视频", "导入", "打开视频", "媒体"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "file.import-srt",
    label: "导入句级 SRT",
    path: ["文件", "导入句级 SRT"],
    keywords: ["srt", "subtitle", "字幕", "句子", "导入"],
    target: { kind: "static" },
  },
  {
    id: "file.import-project",
    label: "导入项目",
    path: ["文件", "导入项目"],
    keywords: ["project", "json", "import", "项目", "导入", "打开"],
    target: { kind: "static" },
  },
  {
    id: "file.import-merge-project",
    label: "导入并整合标注",
    path: ["文件", "导入并整合标注"],
    keywords: ["merge", "integrate", "整合", "合并", "导入"],
    target: { kind: "static" },
  },
  {
    id: "file.save-local",
    label: "保存本地项目",
    path: ["文件", "保存本地项目"],
    keywords: ["save", "保存", "导出项目", "json"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "file.export-character-srt",
    label: "导出逐字 SRT",
    path: ["文件", "导出逐字 SRT"],
    keywords: ["export", "srt", "导出", "逐字", "字级"],
    target: { kind: "static" },
  },
  {
    id: "file.export-singing-srt",
    label: "导出唱腔 SRT",
    path: ["文件", "导出唱腔 SRT"],
    keywords: ["export", "srt", "导出", "唱腔"],
    target: { kind: "static" },
  },
  {
    id: "edit.undo",
    label: "撤销",
    path: ["编辑", "撤销"],
    keywords: ["undo", "撤销", "回退"],
    target: { kind: "static" },
  },
  {
    id: "edit.redo",
    label: "重做",
    path: ["编辑", "重做"],
    keywords: ["redo", "重做", "恢复"],
    target: { kind: "static" },
  },
  {
    id: "edit.repair-sentence-character-track",
    label: "检查句级/逐字文字轨",
    path: ["编辑", "检查句级/逐字文字轨"],
    keywords: ["repair", "check", "检查", "修复", "对齐", "句级", "逐字"],
    target: { kind: "static" },
  },
  {
    id: "playback.toggle",
    label: "播放 / 暂停",
    path: ["播放", "播放 / 暂停"],
    keywords: ["play", "pause", "播放", "暂停", "空格", "space"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "playback.step-back-100ms",
    label: "后退 0.1s",
    path: ["播放", "后退 0.1s"],
    keywords: ["step", "back", "后退", "步进"],
    target: { kind: "static" },
  },
  {
    id: "playback.step-forward-100ms",
    label: "前进 0.1s",
    path: ["播放", "前进 0.1s"],
    keywords: ["step", "forward", "前进", "步进"],
    target: { kind: "static" },
  },
  {
    id: "playback.step-back-frame",
    label: "后退 1 帧",
    path: ["播放", "后退 1 帧"],
    keywords: ["frame", "后退", "帧", "步进"],
    target: { kind: "static" },
  },
  {
    id: "playback.step-forward-frame",
    label: "前进 1 帧",
    path: ["播放", "前进 1 帧"],
    keywords: ["frame", "前进", "帧", "步进"],
    target: { kind: "static" },
  },
  {
    id: "playback.rate-0.5",
    label: "播放速度 0.5x",
    path: ["播放", "播放速度", "0.5x"],
    keywords: ["rate", "speed", "速度", "倍速", "慢放"],
    target: { kind: "static" },
  },
  {
    id: "playback.rate-0.75",
    label: "播放速度 0.75x",
    path: ["播放", "播放速度", "0.75x"],
    keywords: ["rate", "speed", "速度", "倍速", "慢放"],
    target: { kind: "static" },
  },
  {
    id: "playback.rate-1",
    label: "播放速度 1x",
    path: ["播放", "播放速度", "1x"],
    keywords: ["rate", "speed", "速度", "倍速", "正常"],
    target: { kind: "static" },
  },
  {
    id: "playback.rate-1.25",
    label: "播放速度 1.25x",
    path: ["播放", "播放速度", "1.25x"],
    keywords: ["rate", "speed", "速度", "倍速", "快放"],
    target: { kind: "static" },
  },
  {
    id: "playback.rate-1.5",
    label: "播放速度 1.5x",
    path: ["播放", "播放速度", "1.5x"],
    keywords: ["rate", "speed", "速度", "倍速", "快放"],
    target: { kind: "static" },
  },
  {
    id: "playback.toggle-loop",
    label: "循环播放选区",
    path: ["播放", "循环播放选区"],
    keywords: ["loop", "repeat", "循环", "选区", "范围", "重复"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "playback.clear-loop-range",
    label: "清除循环选区",
    path: ["播放", "清除循环选区"],
    keywords: ["loop", "clear", "循环", "选区", "清除", "范围"],
    target: { kind: "static" },
  },
  {
    id: "view.waveform",
    label: "音频波形",
    path: ["视图", "音频波形"],
    keywords: ["waveform", "audio", "波形", "音频", "轨道", "显示", "隐藏"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "view.spectrogram",
    label: "人声频谱图",
    path: ["视图", "人声频谱图"],
    keywords: ["spectrogram", "频谱", "人声", "轨道", "显示", "隐藏"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "view.banyan-track",
    label: "板眼轨",
    path: ["视图", "板眼轨"],
    keywords: ["banyan", "beat", "板眼", "轨道", "显示", "隐藏"],
    target: { kind: "static" },
  },
  {
    id: "view.banyan-grid",
    label: "全局板眼纵线",
    path: ["视图", "全局板眼纵线"],
    keywords: ["banyan", "grid", "板眼", "纵线", "网格", "参考线"],
    target: { kind: "static" },
  },
  {
    id: "audio.panel",
    label: "打开音频轨道设置",
    path: ["音频轨道设置"],
    keywords: ["audio", "settings", "音频", "设置", "波形", "频谱", "分析"],
    featured: true,
    target: { kind: "audio-setting", focusTarget: "audio-waveform-visible" },
  },
  {
    id: "audio.pitch-contour",
    label: "F0 / Pitch contour",
    path: ["音频轨道设置", "频谱图", "F0 / Pitch contour"],
    keywords: ["f0", "pitch", "基频", "音高", "曲线", "voiced"],
    target: { kind: "audio-setting", focusTarget: "audio-pitch-contour" },
  },
  {
    id: "audio.frequency-scale",
    label: "频谱纵轴映射",
    path: ["音频轨道设置", "纵轴映射"],
    keywords: ["log", "mel", "linear", "纵轴", "映射", "频率", "刻度"],
    target: { kind: "audio-setting", focusTarget: "audio-frequency-scale" },
  },
  {
    id: "audio.frequency-preset",
    label: "频谱频率范围",
    path: ["音频轨道设置", "频率范围"],
    keywords: ["frequency", "hz", "频率", "范围", "人声细节", "预设"],
    target: { kind: "audio-setting", focusTarget: "audio-frequency-preset" },
  },
  {
    id: "audio.analysis-preset",
    label: "频谱分析精度",
    path: ["音频轨道设置", "分析精度"],
    keywords: ["stft", "fft", "hop", "分析", "精度", "预设", "人声清晰", "频率细节"],
    target: { kind: "audio-setting", focusTarget: "audio-analysis-preset" },
  },
];

// 仅平台编辑会话可用的条目：涉及服务器媒体、服务器保存、标注审核栏和服务端分析音频。
export const PLATFORM_STATIC_COMMAND_DEFINITIONS: StaticCommandDefinition<PlatformStaticCommandId>[] = [
  {
    id: "file.bind-server-media",
    label: "关联服务器媒体",
    path: ["文件", "关联服务器媒体"],
    keywords: ["media", "bind", "server", "服务器", "媒体", "关联", "vod"],
    target: { kind: "static" },
  },
  {
    id: "file.save-server",
    label: "保存平台标注文件",
    path: ["文件", "保存平台标注文件"],
    keywords: ["save", "server", "platform", "保存", "平台", "服务器", "上传"],
    target: { kind: "static" },
  },
  {
    id: "view.annotation-confirmation-docked",
    label: "右侧标注审核",
    path: ["视图", "右侧标注审核"],
    keywords: ["confirmation", "comment", "标注审核", "确认", "评论", "右侧", "侧栏", "面板"],
    target: { kind: "static" },
  },
  {
    id: "view.annotation-confirmation-detached",
    label: "标注审核独立窗口",
    path: ["视图", "标注审核独立窗口"],
    keywords: ["confirmation", "comment", "detach", "标注审核", "独立窗口", "浮动"],
    target: { kind: "static" },
  },
  {
    id: "audio.analysis-source",
    label: "分析音频来源",
    path: ["音频轨道设置", "分析音频来源"],
    keywords: ["analysis", "audio", "source", "分析", "音频", "来源", "重新分析", "预加载"],
    target: { kind: "audio-setting", focusTarget: "audio-analysis-source" },
  },
];

// 轨道设置字段的展示文案与关键词集中在这里，三种轨道共用，避免同一字段在多处各写一份文案。
// toggle 为 true 的字段在搜索结果里点击即翻转开关，与在面板上点那个开关完全等价；
// 其余字段（名称、颜色、类型列表等）需要真正的表单输入，只能定位过去。
// group 用于面包屑第二段：多数字段属于「轨道设置」，轨道吸附开关则位于时间轴轨道头。
const TRACK_FIELD_META: Record<
  TrackCommandFieldKey,
  {
    label: string;
    keywords: string[];
    focusTarget: InspectorFocusTarget;
    toggle: boolean;
    group?: string;
  }
> = {
  name: {
    label: "轨道名称",
    keywords: ["rename", "name", "名称", "重命名", "改名"],
    focusTarget: "track-name",
    toggle: false,
  },
  color: {
    label: "轨道颜色",
    keywords: ["color", "颜色", "配色", "色块"],
    focusTarget: "track-color",
    toggle: false,
  },
  branching: {
    label: "启用轨道内分叉",
    keywords: ["branch", "分叉", "递归", "子轨", "层级"],
    focusTarget: "track-branching",
    toggle: true,
  },
  "track-snap": {
    label: "吸附",
    keywords: ["snap", "吸附", "轨道头", "总开关"],
    focusTarget: "track-waveform-snap",
    toggle: true,
    group: "轨道头",
  },
  "waveform-snap": {
    label: "吸附到音频关键点",
    keywords: ["snap", "waveform", "吸附", "波形", "关键点"],
    focusTarget: "track-waveform-snap",
    toggle: true,
  },
  "auto-loop-range": {
    label: "选中块时更新循环范围",
    keywords: ["loop", "range", "循环", "范围", "选区", "选中块", "同步"],
    focusTarget: "track-auto-loop-range",
    toggle: true,
  },
  "parent-boundary-snap": {
    label: "吸附到父轨道标注边界",
    keywords: ["snap", "parent", "吸附", "父轨道", "边界"],
    focusTarget: "track-parent-boundary-snap",
    toggle: true,
  },
  "type-options": {
    label: "类型列表",
    keywords: ["type", "options", "类型", "列表", "选项", "标签"],
    focusTarget: "track-type-options",
    toggle: false,
  },
  "attached-point-tracks": {
    label: "附属打点轨",
    keywords: ["point", "attached", "附属", "打点", "点轨"],
    focusTarget: "track-attached-point-tracks",
    toggle: false,
  },
  "gongche-import": {
    label: "导入工尺谱",
    keywords: ["gongche", "工尺", "谱", "导入"],
    focusTarget: "track-gongche-import",
    toggle: false,
  },
};

// 按轨道种类决定 Inspector 上真实存在的字段，必须与 InspectorPanel 的条件渲染保持一致，
// 否则搜索会把用户带到一个当前不会渲染出来的位置。
const BUILTIN_TRACK_FIELDS: TrackCommandFieldKey[] = [
  "name",
  "track-snap",
  "waveform-snap",
  "auto-loop-range",
  "attached-point-tracks",
  "type-options",
];

const CUSTOM_TRACK_FIELDS: TrackCommandFieldKey[] = [
  "name",
  "color",
  "branching",
  "track-snap",
  "waveform-snap",
  "auto-loop-range",
  "attached-point-tracks",
  "type-options",
];

const ATTACHED_POINT_TRACK_FIELDS: TrackCommandFieldKey[] = [
  "name",
  "waveform-snap",
  "parent-boundary-snap",
  "type-options",
];

// 单条轨道设置命令的构造入口，统一拼 id / 面包屑 / 关键词，并把轨道名也放进关键词，
// 让用户既能搜字段名（循环）也能搜轨道名（身段轨）。
function createTrackSettingCommand(params: {
  trackId: string;
  trackName: string;
  trackKind: "builtin" | "custom" | "attached-point";
  parentTrackId?: string;
  field: TrackCommandFieldKey;
}): CommandDefinition {
  const meta = TRACK_FIELD_META[params.field];
  const settingsLabel = meta.group ??
    (params.trackKind === "attached-point" ? "附属打点轨设置" : "轨道设置");
  return {
    id: `track:${params.trackId}:${params.field}`,
    label: meta.label,
    path: [params.trackName, settingsLabel, meta.label],
    keywords: [...meta.keywords, params.trackName],
    target: {
      kind: "track-setting",
      trackId: params.trackId,
      trackKind: params.trackKind,
      parentTrackId: params.parentTrackId,
      field: params.field,
      focusTarget: meta.focusTarget,
      toggle: meta.toggle,
    },
  };
}

// 工尺谱导入只出现在文字类轨道（内置文字轨或自定义 text 轨），与 InspectorPanel 的
// supportsGongcheImport 判断保持同一条规则。
function supportsGongcheImport(track: BuiltinTrack | CustomTrack) {
  if ("type" in track) {
    return track.type === "character";
  }
  return track.trackType === "text";
}

// 依据当前项目展开所有轨道级设置命令：先父轨道自身，再其附属打点轨。
// 该函数是纯函数，输入相同则输出相同，App 可以直接放进 useMemo。
export function buildTrackSettingCommands(
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
): CommandDefinition[] {
  const commands: CommandDefinition[] = [];

  const appendTrack = (
    track: BuiltinTrack | CustomTrack,
    trackKind: "builtin" | "custom",
    fields: TrackCommandFieldKey[],
  ) => {
    for (const field of fields) {
      commands.push(
        createTrackSettingCommand({
          trackId: track.id,
          trackName: track.name,
          trackKind,
          field,
        }),
      );
    }
    if (supportsGongcheImport(track)) {
      commands.push(
        createTrackSettingCommand({
          trackId: track.id,
          trackName: track.name,
          trackKind,
          field: "gongche-import",
        }),
      );
    }
    // 附属打点轨的设置面板由父轨道选中态之外的独立 SelectedItem 驱动，需要带上 parentTrackId。
    for (const pointTrack of track.attachedPointTracks) {
      for (const field of ATTACHED_POINT_TRACK_FIELDS) {
        commands.push(
          createTrackSettingCommand({
            trackId: pointTrack.id,
            trackName: pointTrack.name,
            trackKind: "attached-point",
            parentTrackId: track.id,
            field,
          }),
        );
      }
    }
  };

  for (const track of builtinTracks) {
    appendTrack(track, "builtin", BUILTIN_TRACK_FIELDS);
  }
  for (const track of customTracks) {
    appendTrack(track, "custom", CUSTOM_TRACK_FIELDS);
  }

  return commands;
}

export type TrackSettingCommandTarget = Extract<CommandTarget, { kind: "track-setting" }>;

// 在轨道集合里按 id 找轨道，附属打点轨也一并查找，供开关取值和执行使用。
export function findTrackForCommand(
  trackId: string,
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
): BuiltinTrack | CustomTrack | AttachedPointTrack | null {
  const parents: (BuiltinTrack | CustomTrack)[] = [...builtinTracks, ...customTracks];
  const parent = parents.find((track) => track.id === trackId);
  if (parent) {
    return parent;
  }
  for (const track of parents) {
    const pointTrack = track.attachedPointTracks.find((item) => item.id === trackId);
    if (pointTrack) {
      return pointTrack;
    }
  }
  return null;
}

// 计算一条轨道设置命令当前的勾选态与禁用原因。规则必须与 InspectorPanel 的开关一致：
// 两个吸附细项在轨道头「吸附」总开关关闭时不可编辑，否则搜索会给出面板上点不动的操作。
export function resolveTrackSettingCommandState(
  target: TrackSettingCommandTarget,
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
  trackSnapEnabled: Record<string, boolean>,
): { checked?: boolean; disabledReason?: string } {
  const track = findTrackForCommand(target.trackId, builtinTracks, customTracks);
  if (!track) {
    return { disabledReason: "轨道已不存在" };
  }
  const trackSnapOn = Boolean(trackSnapEnabled[target.trackId]);
  switch (target.field) {
    case "track-snap":
      return { checked: trackSnapOn };
    case "waveform-snap":
      return {
        checked: Boolean(track.snapToWaveformKeypoints),
        disabledReason: trackSnapOn ? undefined : "请先开启该轨道的吸附总开关",
      };
    case "parent-boundary-snap":
      return {
        checked: "snapToParentBoundaries" in track ? Boolean(track.snapToParentBoundaries) : false,
        disabledReason: trackSnapOn ? undefined : "请先开启该轨道的吸附总开关",
      };
    case "auto-loop-range":
      return { checked: Boolean(track.autoSetLoopRangeOnSelect) };
    case "branching":
      return { checked: "branching" in track ? Boolean(track.branching?.enabled) : false };
    default:
      return {};
  }
}
