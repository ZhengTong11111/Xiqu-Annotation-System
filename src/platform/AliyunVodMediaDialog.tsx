import * as Dialog from "@radix-ui/react-dialog";
import { Cloud, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MediaProviderCapabilities, ResourceEntry } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type Props = {
  client: PlatformClient;
  parentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (resource: ResourceEntry) => void;
};

// 资源管理器与媒体选择器共用同一 VOD 创建命令，避免两套表单逐渐产生不同校验与错误状态。
export function AliyunVodMediaDialog(props: Props) {
  const [capabilities, setCapabilities] = useState<MediaProviderCapabilities | null>(null);
  const [name, setName] = useState("");
  const [videoId, setVideoId] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    // 每次打开都先清除旧能力，避免本轮配置读取失败时沿用上一次的 enabled 状态提交请求。
    setCapabilities(null);
    setName("");
    setVideoId("");
    setError(null);
    setLoadingConfig(true);
    void props.client.getMediaProviderCapabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch((nextError: unknown) => {
        if (active) setError(describeError(nextError));
      })
      .finally(() => {
        if (active) setLoadingConfig(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.open]);

  const provider = capabilities?.aliyunVod ?? null;
  const canSubmit = Boolean(
    props.parentId &&
    provider?.enabled &&
    name.trim() &&
    videoId.trim() &&
    !submitting,
  );

  // 提交只发送资源名称与稳定 vid；供应商验证、ACL 和同名竞争全部由服务端裁决。
  async function submit() {
    if (!canSubmit || !props.parentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const resource = await props.client.createAliyunVodMedia({
        parentId: props.parentId,
        name: name.trim(),
        videoId: videoId.trim(),
      });
      props.onCreated(resource);
      props.onOpenChange(false);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  return <Dialog.Root
    open={props.open}
    onOpenChange={(open) => {
      if (!submitting) props.onOpenChange(open);
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay className="system-diagnostics-backdrop" />
      <Dialog.Content className="aliyun-vod-dialog">
        <header className="system-diagnostics-header">
          <div>
            <Cloud size={20} />
            <div>
              <Dialog.Title>接入阿里云 VOD</Dialog.Title>
              <Dialog.Description>保存稳定媒资身份，播放凭据仅在需要时短暂签发</Dialog.Description>
            </div>
          </div>
          <Dialog.Close asChild>
            <button type="button" title="关闭" disabled={submitting}><X size={17} /></button>
          </Dialog.Close>
        </header>

        <div className="aliyun-vod-dialog-body">
          {error ? <div className="resource-error-banner" role="alert">{error}</div> : null}
          {loadingConfig ? <p className="aliyun-vod-status"><LoaderCircle className="spin" size={16} />正在读取服务配置…</p> : null}
          {!loadingConfig && provider && !provider.enabled ? (
            <div className="aliyun-vod-disabled" role="status">
              服务器尚未启用阿里云 VOD。已有上传媒体和本地媒体不受影响。
            </div>
          ) : null}
          <label>
            <span>资源名称</span>
            <input
              autoFocus
              value={name}
              disabled={!provider?.enabled || submitting}
              placeholder="例如：央视_顾卫英《寻梦》"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>VOD ID</span>
            <input
              value={videoId}
              disabled={!provider?.enabled || submitting}
              placeholder="输入阿里云音视频 ID"
              spellCheck={false}
              onChange={(event) => setVideoId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </label>
          <dl>
            <dt>来源</dt><dd>阿里云视频点播</dd>
            <dt>区域</dt><dd>{provider?.region ?? "未配置"}</dd>
          </dl>
          <p className="aliyun-vod-notice">
            平台不会保存 AccessKey、Secret、playauth、临时播放地址或供应商原始响应。
          </p>
        </div>

        <footer className="annotation-media-actions">
          <Dialog.Close asChild><button type="button" disabled={submitting}>取消</button></Dialog.Close>
          <button
            type="button"
            className="platform-primary-button"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? "正在验证" : "验证并创建"}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "阿里云 VOD 操作失败。";
}
