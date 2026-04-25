import { useEffect, useMemo, useRef } from "react";
import type {
  PitchFrame,
  SpectrogramData,
  SpectrogramFrequencyScale,
} from "../types";

type SpectrogramCanvasProps = {
  data: SpectrogramData;
  frequencyScale: SpectrogramFrequencyScale;
  minFrequency: number;
  maxFrequency: number;
  visibleStartTime: number;
  visibleEndTime: number;
  activeVisibleStartTime: number;
  activeVisibleEndTime: number;
  left: number;
  width: number;
  height: number;
  showPitchContour: boolean;
  interactionPreview: boolean;
};

type SpectrogramTileQuality = "detail" | "preview";

type SpectrogramTile = {
  id: string;
  left: number;
  width: number;
  startTime: number;
  endTime: number;
  quality: SpectrogramTileQuality;
  cssPixelsPerFrame: number;
};

const TILE_TARGET_CSS_WIDTH = 680;
const MIN_TILE_RENDER_WIDTH = 96;
const MIN_TILE_RENDER_HEIGHT = 48;
const MAX_TILE_RENDER_PIXELS = 1_150_000;
const MAX_DETAIL_DEVICE_PIXEL_RATIO = 2;
const DISCRETE_FRAME_PIXEL_WIDTH = 3;

export function SpectrogramCanvas({
  data,
  frequencyScale,
  minFrequency,
  maxFrequency,
  visibleStartTime,
  visibleEndTime,
  activeVisibleStartTime,
  activeVisibleEndTime,
  left,
  width,
  height,
  showPitchContour,
  interactionPreview,
}: SpectrogramCanvasProps) {
  const safeMinFrequency = Math.max(data.minFrequency, Math.min(minFrequency, data.maxFrequency));
  const safeMaxFrequency = Math.max(
    safeMinFrequency + 1,
    Math.min(maxFrequency, data.maxFrequency),
  );
  const labels = useMemo(
    () => buildAxisLabels(frequencyScale, safeMinFrequency, safeMaxFrequency),
    [frequencyScale, safeMaxFrequency, safeMinFrequency],
  );
  const tiles = useMemo(
    () =>
      buildSpectrogramTiles(
        visibleStartTime,
        visibleEndTime,
        activeVisibleStartTime,
        activeVisibleEndTime,
        width,
        interactionPreview,
        data.hopLength / data.sampleRate,
      ),
    [
      activeVisibleEndTime,
      activeVisibleStartTime,
      interactionPreview,
      data.hopLength,
      data.sampleRate,
      visibleEndTime,
      visibleStartTime,
      width,
    ],
  );

  return (
    <div
      className="spectrogram-render-layer"
      style={{
        left,
        width,
        height,
      }}
    >
      {tiles.map((tile) => (
        <SpectrogramCanvasTile
          key={tile.id}
          data={data}
          frequencyScale={frequencyScale}
          minFrequency={safeMinFrequency}
          maxFrequency={safeMaxFrequency}
          tile={tile}
          height={height}
          showPitchContour={showPitchContour}
          interactionPreview={interactionPreview}
        />
      ))}
      <div className="spectrogram-frequency-label top">{labels.top}</div>
      <div className="spectrogram-frequency-label middle">{labels.middle}</div>
      <div className="spectrogram-frequency-label bottom">{labels.bottom}</div>
    </div>
  );
}

type SpectrogramCanvasTileProps = {
  data: SpectrogramData;
  frequencyScale: SpectrogramFrequencyScale;
  minFrequency: number;
  maxFrequency: number;
  tile: SpectrogramTile;
  height: number;
  showPitchContour: boolean;
  interactionPreview: boolean;
};

function SpectrogramCanvasTile({
  data,
  frequencyScale,
  minFrequency,
  maxFrequency,
  tile,
  height,
  showPitchContour,
  interactionPreview,
}: SpectrogramCanvasTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderScale = getTileRenderScale(
    tile.quality,
    tile.width,
    height,
    tile.cssPixelsPerFrame,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    let cancelled = false;
    let frameId: number | null = null;
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const render = () => {
      if (cancelled) {
        return;
      }
      const renderWidth = Math.max(MIN_TILE_RENDER_WIDTH, Math.ceil(tile.width * renderScale));
      const renderHeight = Math.max(MIN_TILE_RENDER_HEIGHT, Math.ceil(height * renderScale));
      if (canvas.width !== renderWidth) {
        canvas.width = renderWidth;
      }
      if (canvas.height !== renderHeight) {
        canvas.height = renderHeight;
      }

      renderSpectrogramTile(
        context,
        data,
        frequencyScale,
        minFrequency,
        maxFrequency,
        tile.startTime,
        tile.endTime,
        renderWidth,
        renderHeight,
      );

      if (showPitchContour && data.pitchFrames?.length) {
        drawPitchContour(
          context,
          data.pitchFrames,
          tile.startTime,
          tile.endTime,
          renderWidth,
          renderHeight,
          frequencyScale,
          minFrequency,
          maxFrequency,
          renderScale,
        );
      }
    };

    if (interactionPreview || tile.quality === "detail") {
      frameId = requestAnimationFrame(render);
    } else if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(render, { timeout: 280 });
    } else {
      timeoutId = window.setTimeout(render, 80);
    }

    return () => {
      cancelled = true;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      if (idleId !== null) {
        idleWindow.cancelIdleCallback?.(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    data,
    frequencyScale,
    height,
    interactionPreview,
    maxFrequency,
    minFrequency,
    renderScale,
    showPitchContour,
    tile.endTime,
    tile.quality,
    tile.startTime,
    tile.width,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={[
        "spectrogram-canvas",
        tile.quality === "detail" ? "detail" : "preview",
        tile.cssPixelsPerFrame >= DISCRETE_FRAME_PIXEL_WIDTH ? "discrete-frames" : "",
      ].join(" ")}
      style={{
        left: tile.left,
        width: tile.width,
        height,
      }}
    />
  );
}

function buildSpectrogramTiles(
  visibleStartTime: number,
  visibleEndTime: number,
  activeVisibleStartTime: number,
  activeVisibleEndTime: number,
  width: number,
  interactionPreview: boolean,
  frameDuration: number,
) {
  const renderDuration = Math.max(visibleEndTime - visibleStartTime, 0.001);
  const tileCount = Math.max(1, Math.ceil(width / TILE_TARGET_CSS_WIDTH));
  const tileCssWidth = width / tileCount;
  const activeDuration = Math.max(activeVisibleEndTime - activeVisibleStartTime, 0.001);
  const detailStartTime = activeVisibleStartTime - activeDuration * 0.18;
  const detailEndTime = activeVisibleEndTime + activeDuration * 0.18;
  const tiles: SpectrogramTile[] = [];

  for (let index = 0; index < tileCount; index += 1) {
    const tileLeft = index * tileCssWidth;
    const tileRight = index === tileCount - 1 ? width : (index + 1) * tileCssWidth;
    const startTime = visibleStartTime + (tileLeft / Math.max(width, 1)) * renderDuration;
    const endTime = visibleStartTime + (tileRight / Math.max(width, 1)) * renderDuration;
    const isDetailTile = !interactionPreview && endTime >= detailStartTime && startTime <= detailEndTime;
    const tileDuration = Math.max(endTime - startTime, 0.001);
    tiles.push({
      id: [
        "tile",
        index,
        Math.round(startTime * 1000),
        Math.round(endTime * 1000),
        isDetailTile ? "detail" : "preview",
      ].join("-"),
      left: tileLeft,
      width: Math.max(tileRight - tileLeft, 1),
      startTime,
      endTime,
      quality: isDetailTile ? "detail" : "preview",
      cssPixelsPerFrame: ((tileRight - tileLeft) / tileDuration) * frameDuration,
    });
  }

  return tiles;
}

function getTileRenderScale(
  quality: SpectrogramTileQuality,
  cssWidth: number,
  cssHeight: number,
  cssPixelsPerFrame: number,
) {
  const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const detailScale = cssPixelsPerFrame >= DISCRETE_FRAME_PIXEL_WIDTH
    ? Math.max(1.25, Math.min(devicePixelRatio, MAX_DETAIL_DEVICE_PIXEL_RATIO))
    : Math.max(1, Math.min(devicePixelRatio, 1.5));
  const targetScale = quality === "detail"
    ? detailScale
    : Math.min(0.6, Math.max(0.35, devicePixelRatio * 0.3));
  const maxPixelScale = Math.sqrt(
    MAX_TILE_RENDER_PIXELS / Math.max(cssWidth * cssHeight, 1),
  );
  return Math.max(0.35, Math.min(targetScale, maxPixelScale));
}

function renderSpectrogramTile(
  context: CanvasRenderingContext2D,
  data: SpectrogramData,
  frequencyScale: SpectrogramFrequencyScale,
  minFrequency: number,
  maxFrequency: number,
  startTime: number,
  endTime: number,
  width: number,
  height: number,
) {
  const imageData = context.createImageData(width, height);
  const visibleDuration = Math.max(endTime - startTime, 0.001);
  const maxFrameIndex = data.frameCount - 1;
  const frameCenterOffset = data.fftSize / 2 / data.sampleRate;
  const binIndexesByRow = new Uint16Array(height);
  for (let y = 0; y < height; y += 1) {
    const frequency = yToFrequency(
      y,
      height,
      frequencyScale,
      minFrequency,
      maxFrequency,
    );
    binIndexesByRow[y] = findNearestFrequencyBin(data.frequencyBins, frequency);
  }

  let previousFrameIndex = -1;
  for (let x = 0; x < width; x += 1) {
    const time = startTime + (x / Math.max(width - 1, 1)) * visibleDuration;
    const frameIndex = Math.max(
      0,
      Math.min(
        maxFrameIndex,
        Math.round(((time - frameCenterOffset) * data.sampleRate) / data.hopLength),
      ),
    );

    if (frameIndex === previousFrameIndex && x > 0) {
      copyPreviousColumn(imageData.data, width, height, x);
      continue;
    }

    previousFrameIndex = frameIndex;
    for (let y = 0; y < height; y += 1) {
      const binIndex = binIndexesByRow[y];
      const value = data.magnitudes[frameIndex * data.frequencyBinCount + binIndex] ?? 0;
      const [red, green, blue] = heatColor(value / 255);
      const pixelIndex = (y * width + x) * 4;
      imageData.data[pixelIndex] = red;
      imageData.data[pixelIndex + 1] = green;
      imageData.data[pixelIndex + 2] = blue;
      imageData.data[pixelIndex + 3] = 255;
    }
  }
  context.putImageData(imageData, 0, 0);
}

function copyPreviousColumn(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
) {
  for (let y = 0; y < height; y += 1) {
    const pixelIndex = (y * width + x) * 4;
    const previousPixelIndex = pixelIndex - 4;
    pixels[pixelIndex] = pixels[previousPixelIndex] ?? 0;
    pixels[pixelIndex + 1] = pixels[previousPixelIndex + 1] ?? 0;
    pixels[pixelIndex + 2] = pixels[previousPixelIndex + 2] ?? 0;
    pixels[pixelIndex + 3] = pixels[previousPixelIndex + 3] ?? 255;
  }
}

function drawPitchContour(
  context: CanvasRenderingContext2D,
  pitchFrames: PitchFrame[],
  visibleStartTime: number,
  visibleEndTime: number,
  width: number,
  height: number,
  frequencyScale: SpectrogramFrequencyScale,
  minFrequency: number,
  maxFrequency: number,
  renderScale: number,
) {
  context.save();
  context.lineWidth = Math.max(2, renderScale * 1.5);
  context.strokeStyle = "rgba(255, 255, 255, 0.94)";
  context.shadowColor = "rgba(15, 23, 42, 0.9)";
  context.shadowBlur = Math.max(3, renderScale * 2);
  context.beginPath();

  let drawing = false;
  const visibleDuration = Math.max(visibleEndTime - visibleStartTime, 0.001);
  for (const frame of pitchFrames) {
    if (
      !frame.voiced ||
      frame.frequency < minFrequency ||
      frame.frequency > maxFrequency ||
      frame.time < visibleStartTime ||
      frame.time > visibleEndTime
    ) {
      drawing = false;
      continue;
    }
    const x = ((frame.time - visibleStartTime) / visibleDuration) * width;
    const y = frequencyToY(frame.frequency, height, frequencyScale, minFrequency, maxFrequency);
    if (!drawing) {
      context.moveTo(x, y);
      drawing = true;
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
  context.restore();
}

function yToFrequency(
  y: number,
  height: number,
  scale: SpectrogramFrequencyScale,
  minFrequency: number,
  maxFrequency: number,
) {
  const unit = 1 - y / Math.max(height - 1, 1);
  if (scale === "linear") {
    return minFrequency + (maxFrequency - minFrequency) * unit;
  }
  if (scale === "mel") {
    return inverseMel(mel(minFrequency) + (mel(maxFrequency) - mel(minFrequency)) * unit);
  }
  return Math.exp(Math.log(minFrequency) + (Math.log(maxFrequency) - Math.log(minFrequency)) * unit);
}

function frequencyToY(
  frequency: number,
  height: number,
  scale: SpectrogramFrequencyScale,
  minFrequency: number,
  maxFrequency: number,
) {
  const clampedFrequency = Math.max(minFrequency, Math.min(maxFrequency, frequency));
  const unit = (() => {
    if (scale === "linear") {
      return (clampedFrequency - minFrequency) / Math.max(maxFrequency - minFrequency, 1);
    }
    if (scale === "mel") {
      return (mel(clampedFrequency) - mel(minFrequency)) / Math.max(mel(maxFrequency) - mel(minFrequency), 1);
    }
    return (
      (Math.log(clampedFrequency) - Math.log(minFrequency)) /
      Math.max(Math.log(maxFrequency) - Math.log(minFrequency), 1e-6)
    );
  })();
  return (1 - unit) * height;
}

function findNearestFrequencyBin(frequencyBins: Float32Array, frequency: number) {
  let low = 0;
  let high = frequencyBins.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((frequencyBins[mid] ?? 0) < frequency) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  if (low <= 0) {
    return 0;
  }
  const previous = frequencyBins[low - 1] ?? 0;
  const current = frequencyBins[low] ?? 0;
  return Math.abs(previous - frequency) <= Math.abs(current - frequency) ? low - 1 : low;
}

function heatColor(value: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(255 * Math.min(1, Math.max(0, clamped * 2.4 - 0.35)));
  const green = Math.round(255 * Math.min(1, Math.max(0, 1.75 - Math.abs(clamped - 0.68) * 3.1)));
  const blue = Math.round(255 * Math.min(1, Math.max(0, 1.5 - clamped * 2.2)));
  const floor = Math.round(18 + clamped * 34);
  return [
    Math.max(red, floor),
    Math.max(green, floor),
    Math.max(blue, floor),
  ];
}

function buildAxisLabels(
  scale: SpectrogramFrequencyScale,
  minFrequency: number,
  maxFrequency: number,
) {
  const middleFrequency = yToFrequency(0.5, 2, scale, minFrequency, maxFrequency);
  return {
    top: formatFrequency(maxFrequency),
    middle: formatFrequency(middleFrequency),
    bottom: formatFrequency(minFrequency),
  };
}

function formatFrequency(frequency: number) {
  return frequency >= 1000
    ? `${(frequency / 1000).toFixed(frequency >= 2000 ? 0 : 1)}k`
    : `${Math.round(frequency)}`;
}

function mel(frequency: number) {
  return 2595 * Math.log10(1 + frequency / 700);
}

function inverseMel(value: number) {
  return 700 * (10 ** (value / 2595) - 1);
}
