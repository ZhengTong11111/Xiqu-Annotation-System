import type { CSSProperties } from "react";
import type { BranchLane, BranchScope, CustomTrack, TrackDefinition } from "../types";
import { flattenBranchLanes } from "./project";

export const DEFAULT_TRACK_COLORS = [
  "#0ea5e9",
  "#22c55e",
  "#f97316",
  "#a855f7",
  "#14b8a6",
  "#e11d48",
  "#eab308",
  "#6366f1",
];

export const QUICK_TRACK_COLOR_PALETTE = buildQuickTrackColorPalette();

export const STANDARD_TRACK_COLORS = [
  "#c2410c",
  "#dc2626",
  "#ea580c",
  "#f59e0b",
  "#facc15",
  "#84cc16",
  "#16a34a",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
  "#64748b",
];

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!HEX_COLOR_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized.toLowerCase();
}

export function getTrackFallbackColor(index: number) {
  return DEFAULT_TRACK_COLORS[((index % DEFAULT_TRACK_COLORS.length) + DEFAULT_TRACK_COLORS.length) % DEFAULT_TRACK_COLORS.length];
}

export function getNextTrackColor(customTracks: CustomTrack[]) {
  const usedColors = new Set(customTracks.map((track) => normalizeHexColor(track.color)).filter(Boolean));
  return DEFAULT_TRACK_COLORS.find((color) => !usedColors.has(color)) ??
    getTrackFallbackColor(customTracks.length);
}

export function resolveCustomTrackColor(track: CustomTrack, index = 0) {
  return normalizeHexColor(track.color) ?? getTrackFallbackColor(index);
}

export function getBranchLaneColor(
  parentColor: string,
  existingLanes: BranchLane[],
  parentLaneId: string | null,
) {
  const siblingCount = parentLaneId === null
    ? existingLanes.length
    : findBranchLane(existingLanes, parentLaneId)?.children?.length ?? 0;
  const baseColor = parentLaneId === null
    ? parentColor
    : normalizeHexColor(findBranchLane(existingLanes, parentLaneId)?.color) ?? parentColor;
  // 分叉颜色保持父轨色系，但按兄弟序号错开色相与亮度，避免合并显示时看不出来源。
  return deriveRelatedColor(baseColor, siblingCount + 1);
}

export function resolveBranchLaneColor(track: CustomTrack, laneId: string) {
  const parentColor = resolveCustomTrackColor(track);
  const lane = flattenBranchLanes(track.branching?.lanes ?? []).find((item) => item.id === laneId);
  return normalizeHexColor(lane?.color) ?? getBranchLaneColor(parentColor, track.branching?.lanes ?? [], lane?.parentId ?? null);
}

export function getCustomBlockDisplayColor(
  track: CustomTrack | undefined,
  block: { branchScope?: BranchScope },
  visualTrack?: TrackDefinition,
  trackIndex = 0,
) {
  if (!track) {
    return getTrackFallbackColor(trackIndex);
  }
  if (visualTrack?.isBranchLaneTrack && visualTrack.branchLaneId) {
    return resolveBranchLaneColor(track, visualTrack.branchLaneId);
  }
  if (block.branchScope?.mode === "lanes" && block.branchScope.laneIds.length > 0) {
    return resolveBranchLaneColor(track, block.branchScope.laneIds[0]);
  }
  return resolveCustomTrackColor(track, trackIndex);
}

export function getColorCssVariables(color: string) {
  const rgb = hexToRgb(normalizeHexColor(color) ?? DEFAULT_TRACK_COLORS[0]);
  return {
    "--track-color": `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    "--track-color-soft": `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`,
    "--track-color-softer": `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)`,
    "--track-color-border": `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.34)`,
    "--track-color-text": getReadableTextColor(rgb),
  } as CSSProperties;
}

export function deriveRelatedColor(color: string, step: number) {
  const hsl = rgbToHsl(hexToRgb(normalizeHexColor(color) ?? DEFAULT_TRACK_COLORS[0]));
  // 分支轨道需要“同属一个父轨”但肉眼明显可分辨：
  // 先大幅错开色相，再交替调整饱和度/明度，避免只靠浅深变化导致合并显示时分不清。
  const hueOffsets = [34, -34, 64, -64, 96, -96, 128, -128, 160, -160, 180];
  const saturationOffsets = [10, 10, 16, 16, 4, 4, 12, 12, -2, -2, 0];
  const lightnessOffsets = [-3, 5, -8, 8, -12, 10, -6, 6, -10, 10, 0];
  const paletteIndex = ((step - 1) % hueOffsets.length + hueOffsets.length) % hueOffsets.length;
  const hue = (hsl.h + hueOffsets[paletteIndex] + 360) % 360;
  const saturation = clamp(hsl.s + saturationOffsets[paletteIndex], 48, 88);
  const lightness = clamp(hsl.l + lightnessOffsets[paletteIndex], 34, 70);
  return rgbToHex(hslToRgb({ h: hue, s: saturation, l: lightness }));
}

function buildQuickTrackColorPalette() {
  const themeColumns = [
    ["#f8fafc", "#e2e8f0", "#cbd5e1", "#94a3b8", "#64748b", "#334155"],
    ["#fee2e2", "#fecaca", "#fca5a5", "#f87171", "#ef4444", "#b91c1c"],
    ["#ffedd5", "#fed7aa", "#fdba74", "#fb923c", "#f97316", "#c2410c"],
    ["#fef3c7", "#fde68a", "#fcd34d", "#f59e0b", "#d97706", "#92400e"],
    ["#fef9c3", "#fef08a", "#fde047", "#eab308", "#a16207", "#713f12"],
    ["#ecfccb", "#d9f99d", "#bef264", "#84cc16", "#4d7c0f", "#365314"],
    ["#dcfce7", "#bbf7d0", "#86efac", "#22c55e", "#15803d", "#14532d"],
    ["#ccfbf1", "#99f6e4", "#5eead4", "#14b8a6", "#0f766e", "#134e4a"],
    ["#cffafe", "#a5f3fc", "#67e8f9", "#06b6d4", "#0e7490", "#164e63"],
    ["#e0f2fe", "#bae6fd", "#7dd3fc", "#0ea5e9", "#0369a1", "#0c4a6e"],
    ["#dbeafe", "#bfdbfe", "#93c5fd", "#3b82f6", "#1d4ed8", "#1e3a8a"],
    ["#e0e7ff", "#c7d2fe", "#a5b4fc", "#6366f1", "#4338ca", "#312e81"],
    ["#ede9fe", "#ddd6fe", "#c4b5fd", "#8b5cf6", "#6d28d9", "#4c1d95"],
    ["#f3e8ff", "#e9d5ff", "#d8b4fe", "#a855f7", "#7e22ce", "#581c87"],
    ["#fae8ff", "#f5d0fe", "#f0abfc", "#d946ef", "#a21caf", "#701a75"],
    ["#fce7f3", "#fbcfe8", "#f9a8d4", "#ec4899", "#be185d", "#831843"],
    ["#ffe4e6", "#fecdd3", "#fda4af", "#f43f5e", "#be123c", "#881337"],
    ["#f5f5f4", "#e7e5e4", "#d6d3d1", "#a8a29e", "#78716c", "#44403c"],
  ];
  // 转成“横向是色相、纵向是明暗”的矩阵，视觉上更接近 Word/Logic 的快速调色板。
  return themeColumns[0].map((_, shadeIndex) => themeColumns.map((column) => column[shadeIndex]));
}

function findBranchLane(lanes: BranchLane[], laneId: string | null): BranchLane | null {
  if (!laneId) {
    return null;
  }
  for (const lane of lanes) {
    if (lane.id === laneId) {
      return lane;
    }
    const childMatch = findBranchLane(lane.children ?? [], laneId);
    if (childMatch) {
      return childMatch;
    }
  }
  return null;
}

function hexToRgb(color: string) {
  const normalized = normalizeHexColor(color) ?? DEFAULT_TRACK_COLORS[0];
  const value = normalized.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  return `#${[r, g, b].map((value) =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0")
  ).join("")}`;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l: lightness * 100 };
  }
  const delta = max - min;
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  const hue = max === red
    ? ((green - blue) / delta + (green < blue ? 6 : 0))
    : max === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return { h: hue * 60, s: saturation * 100, l: lightness * 100 };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }) {
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r1, g1, b1] = h < 60
    ? [c, x, 0]
    : h < 120
      ? [x, c, 0]
      : h < 180
        ? [0, c, x]
        : h < 240
          ? [0, x, c]
          : h < 300
            ? [x, 0, c]
            : [c, 0, x];
  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  };
}

function getReadableTextColor({ r, g, b }: { r: number; g: number; b: number }) {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? "#1f2937" : "#ffffff";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
