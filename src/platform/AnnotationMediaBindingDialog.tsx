import * as Dialog from "@radix-ui/react-dialog";
import { Film, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationMediaReference, ResourceEntry } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type Props = {
  client: PlatformClient;
  parentId: string;
  current?: AnnotationMediaReference | null;
  open: boolean;
  busy?: boolean;
  allowUnbound?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (mediaResourceId: string | null) => Promise<void> | void;
};

// 导入和 Inspector 共用同一媒体选择器，保证“选择已有、上传新媒体、明确不关联”语义一致。
export function AnnotationMediaBindingDialog(props: Props) {
  const [items, setItems] = useState<ResourceEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(props.current?.resourceId ?? null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await props.client.listResources({
        parentId: props.parentId,
        view: "children",
        type: "media_file",
        sortBy: "name",
        direction: "asc",
        limit: 200,
      });
      setItems(page.items.filter((item) => item.mimeType?.startsWith("video/") || item.mimeType?.startsWith("audio/")));
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, [props.client, props.parentId]);

  useEffect(() => {
    if (!props.open) return;
    setSelectedId(props.current?.resourceId ?? null);
    void load();
  }, [load, props.current?.resourceId, props.open]);

  async function upload(file: File | undefined) {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const resource = await props.client.uploadMedia(props.parentId, file, file.name);
      await load();
      setSelectedId(resource.id);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="system-diagnostics-backdrop" />
      <Dialog.Content className="annotation-media-dialog">
        <header className="system-diagnostics-header">
          <div><Film size={20} /><div><Dialog.Title>关联视频或音频</Dialog.Title><Dialog.Description>媒体关系独立保存，不写入标注正文</Dialog.Description></div></div>
          <div className="system-diagnostics-header-actions">
            <button type="button" title="刷新媒体" onClick={() => void load()}><RefreshCw size={16} /></button>
            <Dialog.Close asChild><button type="button" title="关闭"><X size={17} /></button></Dialog.Close>
          </div>
        </header>
        {error ? <div className="resource-error-banner">{error}</div> : null}
        <div className="annotation-media-list">
          {loading ? <p>正在读取当前目录媒体…</p> : null}
          {props.allowUnbound ? <button type="button" className={selectedId === null ? "active" : ""} onClick={() => setSelectedId(null)}><X size={19} /><strong>暂不关联媒体</strong><span>之后可在标注文件详情中重新设置</span></button> : null}
          {items.map((item) => <button key={item.id} type="button" className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}><Film size={19} /><strong>{item.name}</strong><span>{formatBytes(item.size ?? 0)} · {item.mimeType}</span></button>)}
        </div>
        <footer className="annotation-media-actions">
          <input ref={inputRef} hidden type="file" accept="video/*,audio/*" onChange={(event) => void upload(event.target.files?.[0])} />
          <button type="button" disabled={uploading || props.busy} onClick={() => inputRef.current?.click()}><Upload size={15} />{uploading ? "上传中" : "上传新媒体"}</button>
          <button type="button" className="platform-primary-button" disabled={props.busy || (!props.allowUnbound && !selectedId)} onClick={() => void props.onConfirm(selectedId)}>{props.busy ? "保存中" : "确认关联"}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "读取媒体失败。";
}
