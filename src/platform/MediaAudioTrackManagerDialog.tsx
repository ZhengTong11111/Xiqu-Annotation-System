import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowUp,
  Headphones,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlatformClient } from "../api/platformClient";
import { getAudioTrackKindLabel } from "./platformAudioTrackSelection";
import { AnnotationMediaBindingDialog } from "./AnnotationMediaBindingDialog";
import { isMediaAudioTrackSource } from "./mediaAudioTrackSourcePolicy";
import {
  type ExternalTrackKind,
  type TrackDraft,
  useMediaAudioTrackManager,
} from "./useMediaAudioTrackManager";

type Props = {
  client: PlatformClient;
  primaryMediaResourceId: string;
  parentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void> | void;
};

const EXTERNAL_TRACK_KINDS: readonly ExternalTrackKind[] = [
  "vocal",
  "accompaniment",
  "denoised",
  "reference",
  "custom",
];

/**
 * 音轨关系是主媒体级平台数据，不属于标注 ProjectData。管理器每次写入后重新读取完整列表，
 * 让并发排序、删除和默认音轨清理都以服务端事务结果为准。
 */
export function MediaAudioTrackManagerDialog(props: Props) {
  const manager = useMediaAudioTrackManager({
    client: props.client,
    primaryMediaResourceId: props.primaryMediaResourceId,
    open: props.open,
    onChanged: props.onChanged,
  });
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [deleteTrackId, setDeleteTrackId] = useState<string | null>(null);
  const deletingTrack = useMemo(
    () => manager.tracks.find(({ id }) => id === deleteTrackId) ?? null,
    [deleteTrackId, manager.tracks],
  );

  useEffect(() => {
    // 文件或主媒体切换时关闭叠加确认层，避免旧媒体身份残留在新会话视图中。
    if (!props.open) {
      setSourcePickerOpen(false);
      setDeleteTrackId(null);
    }
  }, [props.open, props.primaryMediaResourceId]);

  return (
    <>
      <Dialog.Root
        open={props.open}
        onOpenChange={(open) => {
          if (!manager.interactionBusy && !sourcePickerOpen) props.onOpenChange(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="system-diagnostics-backdrop" />
          <Dialog.Content className="media-audio-track-manager-dialog">
            <header className="system-diagnostics-header">
              <div>
                <Headphones size={20} />
                <div>
                  <Dialog.Title>管理监听音轨</Dialog.Title>
                  <Dialog.Description>关联音频、调整同步偏移与共享展示顺序</Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button type="button" title="关闭" disabled={manager.interactionBusy}>
                  <X size={17} />
                </button>
              </Dialog.Close>
            </header>

            {manager.error ? <div className="resource-error-banner" role="alert">{manager.error}</div> : null}
            <div className="media-audio-track-manager-body" aria-busy={manager.interactionBusy}>
              <aside className="media-audio-track-list-pane">
                <div className="media-audio-track-list-toolbar">
                  <strong>音轨</strong>
                  <div>
                    <button
                      type="button"
                      title="上移音轨"
                      aria-label="上移音轨"
                      disabled={manager.interactionBusy || !manager.selectedTrack || manager.selectedTrack.sortOrder === 0}
                      onClick={() => void manager.moveSelectedTrack(-1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      title="下移音轨"
                      aria-label="下移音轨"
                      disabled={manager.interactionBusy || !manager.selectedTrack || manager.selectedTrack.sortOrder >= manager.tracks.length - 1}
                      onClick={() => void manager.moveSelectedTrack(1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      title="新增外部音轨"
                      aria-label="新增外部音轨"
                      disabled={manager.interactionBusy}
                      onClick={() => setSourcePickerOpen(true)}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                <div className="media-audio-track-list">
                  {manager.loading ? (
                    <p><LoaderCircle className="spin" size={16} />正在读取音轨…</p>
                  ) : manager.tracks.map((track) => (
                    <button
                      key={track.id}
                      type="button"
                      className={track.id === manager.selectedTrackId ? "active" : ""}
                      disabled={manager.interactionBusy}
                      onClick={() => manager.selectTrack(track.id)}
                    >
                      <strong>{track.name}</strong>
                      <span>
                        {getAudioTrackKindLabel(track.kind)}
                        {!track.enabled ? " · 已停用" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>

              <section className="media-audio-track-editor-pane">
                {manager.newTrackDraft ? (
                  <TrackEditor
                    title="新增外部音轨"
                    sourceLabel={manager.newTrackDraft.source.name}
                    draft={manager.newTrackDraft}
                    disabled={manager.interactionBusy}
                    onChange={manager.updateNewTrackDraft}
                    onCancel={manager.cancelCreate}
                    onSave={() => void manager.createTrack()}
                    saveLabel="新增音轨"
                  />
                ) : manager.selectedTrack?.kind === "original" ? (
                  <div className="media-audio-track-readonly">
                    <Headphones size={26} />
                    <h3>{manager.selectedTrack.name}</h3>
                    <p>系统原声始终引用当前主媒体，不能改名、停用或删除。</p>
                    <dl>
                      <dt>来源</dt><dd>主媒体内嵌音频</dd>
                      <dt>偏移</dt><dd>0 秒</dd>
                    </dl>
                  </div>
                ) : manager.selectedTrack && manager.draft ? (
                  <TrackEditor
                    title={manager.selectedTrack.name}
                    sourceLabel={manager.selectedTrack.source.type === "media_resource"
                      ? manager.selectedTrack.source.sourceType === "uploaded"
                        ? "平台上传音频"
                        : "阿里云 VOD 音频"
                      : "主媒体内嵌音频"}
                    draft={manager.draft}
                    disabled={manager.interactionBusy}
                    onChange={manager.updateDraft}
                    onDelete={() => setDeleteTrackId(manager.selectedTrack!.id)}
                    onSave={() => void manager.saveSelectedTrack()}
                    saveLabel="保存修改"
                  />
                ) : (
                  <div className="media-audio-track-readonly">
                    <Headphones size={26} />
                    <p>选择一条音轨查看设置，或新增外部音频。</p>
                  </div>
                )}
              </section>
            </div>

            <footer className="annotation-media-actions">
              <span>{manager.mutationName ?? `${manager.tracks.length} 条音轨`}</span>
              <Dialog.Close asChild>
                <button type="button" disabled={manager.interactionBusy}>完成</button>
              </Dialog.Close>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AnnotationMediaBindingDialog
        client={props.client}
        parentId={props.parentId}
        open={sourcePickerOpen}
        pickerMode="audio-track-source"
        title="选择外部音频"
        description="选择已有纯音频，或上传/接入新的音频资源"
        onOpenChange={setSourcePickerOpen}
        onConfirm={async (mediaResourceId) => {
          if (!mediaResourceId) return;
          const source = await props.client.getResource(mediaResourceId);
          if (!isMediaAudioTrackSource(source)) {
            throw new Error("外部音轨必须选择纯音频资源。");
          }
          // 选择资源后才进入编辑表单，尚未点击“新增音轨”前不会写入任何平台关系。
          manager.beginCreate(source);
          setSourcePickerOpen(false);
        }}
      />

      <AlertDialog.Root
        open={Boolean(deleteTrackId)}
        onOpenChange={(open) => {
          if (!open && !manager.interactionBusy) setDeleteTrackId(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="resource-alert-backdrop" />
          <AlertDialog.Content className="platform-confirm-dialog media-audio-track-delete-dialog">
            <AlertDialog.Title>删除音轨关联？</AlertDialog.Title>
            <AlertDialog.Description>
              将移除“{deletingTrack?.name ?? "当前音轨"}”与主媒体的关联，但不会删除真实音频文件。
            </AlertDialog.Description>
            <div className="media-audio-track-delete-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" disabled={manager.interactionBusy}>取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="danger"
                  disabled={manager.interactionBusy}
                  onClick={(event) => {
                    event.preventDefault();
                    void manager.deleteTrack(deletingTrack!.id).then((deleted) => {
                      if (deleted) setDeleteTrackId(null);
                    });
                  }}
                >
                  <Trash2 size={15} />删除关联
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

type TrackEditorProps = {
  title: string;
  sourceLabel: string;
  draft: TrackDraft;
  disabled: boolean;
  saveLabel: string;
  onChange: (next: Partial<TrackDraft>) => void;
  onSave: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
};

function TrackEditor(props: TrackEditorProps) {
  return (
    <div className="media-audio-track-form">
      <div className="media-audio-track-form-heading">
        <div><h3>{props.title}</h3><span>{props.sourceLabel}</span></div>
        {props.onDelete ? (
          <button
            type="button"
            className="danger"
            title="删除音轨关联"
            aria-label="删除音轨关联"
            disabled={props.disabled}
            onClick={props.onDelete}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
      <label>
        <span>音轨名称</span>
        <input
          value={props.draft.name}
          disabled={props.disabled}
          maxLength={120}
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
      </label>
      <label>
        <span>音轨类型</span>
        <select
          value={props.draft.kind}
          disabled={props.disabled}
          onChange={(event) => props.onChange({
            kind: event.target.value as ExternalTrackKind,
          })}
        >
          {EXTERNAL_TRACK_KINDS.map((kind) => (
            <option key={kind} value={kind}>{getAudioTrackKindLabel(kind)}</option>
          ))}
        </select>
      </label>
      <label>
        <span>同步偏移（秒）</span>
        <input
          type="number"
          min={-86_400}
          max={86_400}
          step="0.01"
          value={props.draft.offsetSeconds}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ offsetSeconds: event.target.value })}
        />
        <small>正值表示音频相对视频延后，负值表示提前。</small>
      </label>
      <label className="media-audio-track-enabled-field">
        <input
          type="checkbox"
          checked={props.draft.enabled}
          disabled={props.disabled || Boolean(props.onCancel)}
          onChange={(event) => props.onChange({ enabled: event.target.checked })}
        />
        <span>允许在编辑器中选择</span>
      </label>
      <div className="media-audio-track-form-actions">
        {props.onCancel ? (
          <button type="button" disabled={props.disabled} onClick={props.onCancel}>取消新增</button>
        ) : null}
        <button
          type="button"
          className="platform-primary-button"
          disabled={props.disabled}
          onClick={props.onSave}
        >
          <Save size={15} />{props.saveLabel}
        </button>
      </div>
    </div>
  );
}
