import * as Dialog from "@radix-ui/react-dialog";
import type { AliyunVodAudioRendition } from "@xiqu/shared";
import { Cloud, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformClient } from "../api/platformClient";

type Props = {
  client: PlatformClient;
  mediaResourceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (rendition: AliyunVodAudioRendition) => void;
};

/**
 * VOD 转码流不是资源树文件，因此使用独立窄选择器。这里仅展示服务端规范化的稳定事实，
 * 不接收 URL 或用户手填 JobId，避免临时播放信息进入持久音轨关系。
 */
export function AliyunVodAudioRenditionDialog(props: Props) {
  const [renditions, setRenditions] = useState<AliyunVodAudioRendition[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    requestAbortControllerRef.current?.abort();
    const controller = new AbortController();
    requestAbortControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await props.client.listAliyunVodAudioRenditions(
        props.mediaResourceId,
        controller.signal,
      );
      if (requestGenerationRef.current !== generation) return;
      setRenditions(result.renditions);
      setSelectedJobId((current) =>
        current && result.renditions.some(({ jobId }) => jobId === current)
          ? current
          : result.renditions[0]?.jobId ?? null);
    } catch (nextError) {
      if (requestGenerationRef.current === generation) {
        setError(nextError instanceof Error
          ? nextError.message
          : "读取 VOD 音频转码失败。");
        setRenditions([]);
        setSelectedJobId(null);
      }
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
      if (requestAbortControllerRef.current === controller) {
        requestAbortControllerRef.current = null;
      }
    }
  }, [props.client, props.mediaResourceId]);

  useEffect(() => {
    if (!props.open) {
      requestGenerationRef.current += 1;
      requestAbortControllerRef.current?.abort();
      requestAbortControllerRef.current = null;
      setRenditions([]);
      setSelectedJobId(null);
      setError(null);
      return;
    }
    void load();
    return () => {
      requestGenerationRef.current += 1;
      requestAbortControllerRef.current?.abort();
      requestAbortControllerRef.current = null;
    };
  }, [load, props.open]);

  const selected = renditions.find(({ jobId }) => jobId === selectedJobId) ?? null;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop vod-audio-rendition-backdrop" />
        <Dialog.Content className="vod-audio-rendition-dialog">
          <header className="system-diagnostics-header">
            <div>
              <Cloud size={20} />
              <div>
                <Dialog.Title>选择 VOD 音频转码</Dialog.Title>
                <Dialog.Description>选择由 JobId 唯一标识的纯音频流</Dialog.Description>
              </div>
            </div>
            <div className="vod-audio-rendition-heading-actions">
              <button
                type="button"
                title="刷新转码列表"
                aria-label="刷新转码列表"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
              </button>
              <Dialog.Close asChild>
                <button type="button" title="关闭" aria-label="关闭">
                  <X size={17} />
                </button>
              </Dialog.Close>
            </div>
          </header>

          {/* 错误提示与列表共用固定中间区，避免可选提示改变弹窗网格行的归属。 */}
          <div className="vod-audio-rendition-body">
            {error ? <div className="resource-error-banner" role="alert">{error}</div> : null}
            <div
              className="vod-audio-rendition-list"
              aria-busy={loading}
              role="radiogroup"
              aria-label="VOD 音频转码"
            >
              {loading ? (
                <p><LoaderCircle className="spin" size={17} />正在读取阿里云转码…</p>
              ) : renditions.length === 0 ? (
                <div className="vod-audio-rendition-empty">
                  <Cloud size={28} />
                  <strong>当前视频没有可用的 MP3 音频转码</strong>
                  <span>请先在阿里云 VOD 控制台完成纯音频转码，再刷新列表。</span>
                </div>
              ) : renditions.map((rendition) => (
                <button
                  key={rendition.jobId}
                  type="button"
                  role="radio"
                  aria-checked={rendition.jobId === selectedJobId}
                  className={rendition.jobId === selectedJobId ? "active" : ""}
                  onClick={() => setSelectedJobId(rendition.jobId)}
                >
                  <span className="vod-audio-rendition-radio" aria-hidden="true" />
                  <strong>{rendition.definition ?? "音频转码"}</strong>
                  <span>{describeRendition(rendition)}</span>
                </button>
              ))}
            </div>
          </div>

          <footer className="annotation-media-actions">
            <span>{renditions.length > 0 ? `${renditions.length} 条可用转码` : "只显示正常的 HTTPS MP3 音频流"}</span>
            <button
              type="button"
              className="platform-primary-button"
              disabled={!selected || loading}
              onClick={() => {
                if (!selected) return;
                props.onConfirm(selected);
                props.onOpenChange(false);
              }}
            >
              选择音频转码
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function describeRendition(rendition: AliyunVodAudioRendition) {
  const parts = ["MP3"];
  if (rendition.bitrate !== null) parts.push(`${Math.round(rendition.bitrate)} kbps`);
  if (rendition.duration !== null) parts.push(formatDuration(rendition.duration));
  return parts.join(" · ");
}

function formatDuration(seconds: number) {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
