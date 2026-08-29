import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import type { MediaAudioTrackSource, ResourceEntry } from "@xiqu/shared";
import {
  ArrowDown,
  ArrowUp,
  FileAudio,
  Headphones,
  LoaderCircle,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlatformClient } from "../api/platformClient";
import { getAudioTrackKindLabel } from "./platformAudioTrackSelection";
import { AnnotationMediaBindingDialog } from "./AnnotationMediaBindingDialog";
import {
  isAliyunVodAudioRenditionSource,
  isMediaAudioTrackSource,
} from "./mediaAudioTrackSourcePolicy";
import { AliyunVodAudioRenditionDialog } from "./AliyunVodAudioRenditionDialog";
import {
  adjustMediaAudioTrackOffsetDraft,
  describeMediaAudioTrackOffset,
  parseMediaAudioTrackOffsetSeconds,
} from "./mediaAudioTrackOffset";
import {
  type ExternalTrackKind,
  type NewTrackDraft,
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
  const [vodRenditionPickerOpen, setVodRenditionPickerOpen] = useState(false);
  const [vodRenditionSource, setVodRenditionSource] = useState<ResourceEntry | null>(null);
  const [deleteTrackId, setDeleteTrackId] = useState<string | null>(null);
  const deletingTrack = useMemo(
    () => manager.tracks.find(({ id }) => id === deleteTrackId) ?? null,
    [deleteTrackId, manager.tracks],
  );

  useEffect(() => {
    // 文件或主媒体切换时关闭叠加确认层，避免旧媒体身份残留在新会话视图中。
    if (!props.open) {
      setSourcePickerOpen(false);
      setVodRenditionPickerOpen(false);
      setVodRenditionSource(null);
      setDeleteTrackId(null);
    }
  }, [props.open, props.primaryMediaResourceId]);

  return (
    <>
      <Dialog.Root
        open={props.open}
        onOpenChange={(open) => {
          if (
            !manager.interactionBusy &&
            !sourcePickerOpen &&
            !vodRenditionPickerOpen
          ) props.onOpenChange(open);
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
                      title="添加监听音轨"
                      aria-label="添加监听音轨"
                      disabled={manager.interactionBusy}
                      onClick={() => setSourcePickerOpen(true)}
                    >
                      <FileAudio size={15} />
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
                    sourceLabel={describeDraftSource(manager.newTrackDraft.source)}
                    draft={manager.newTrackDraft}
                    disabled={manager.interactionBusy}
                    onChange={manager.updateNewTrackDraft}
                    onOffsetAdjust={manager.adjustNewTrackOffset}
                    onOffsetReset={manager.resetNewTrackOffset}
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
                    sourceLabel={describeTrackSource(manager.selectedTrack.source)}
                    draft={manager.draft}
                    disabled={manager.interactionBusy}
                    onChange={manager.updateDraft}
                    onOffsetAdjust={manager.adjustDraftOffset}
                    onOffsetReset={manager.resetDraftOffset}
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
        title="选择音频来源"
        description="选择纯音频文件或含 MP3 转码的阿里云 VOD，也可上传或接入新媒体"
        onOpenChange={setSourcePickerOpen}
        onConfirm={async (mediaResourceId) => {
          if (!mediaResourceId) return;
          const source = await props.client.getResource(mediaResourceId);
          if (isMediaAudioTrackSource(source)) {
            // 纯音频直接进入关系编辑草稿，不需要额外的供应商转码选择。
            manager.beginCreateMediaResource(source);
            setSourcePickerOpen(false);
            return;
          }
          if (!isAliyunVodAudioRenditionSource(source)) {
            throw new Error("请选择纯音频文件或含 MP3 转码的阿里云 VOD。");
          }
          // VOD 只保存稳定媒资身份；JobId 必须在下一层由服务端权威候选中选择。
          setVodRenditionSource(source);
          setSourcePickerOpen(false);
          setVodRenditionPickerOpen(true);
        }}
      />

      {vodRenditionSource ? (
        <AliyunVodAudioRenditionDialog
          client={props.client}
          mediaResourceId={vodRenditionSource.id}
          open={vodRenditionPickerOpen}
          onOpenChange={(open) => {
            setVodRenditionPickerOpen(open);
            if (!open) setVodRenditionSource(null);
          }}
          onConfirm={(rendition) => {
            manager.beginCreateVodRendition(vodRenditionSource, rendition);
          }}
        />
      ) : null}

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

function describeDraftSource(
  source: NewTrackDraft["source"],
) {
  if (source.type === "media_resource") return source.resource.name;
  return `${source.mediaResourceName} · ${source.rendition.definition ?? "MP3"}`;
}

function describeTrackSource(
  source: MediaAudioTrackSource,
) {
  if (source.type === "embedded_original") return "主媒体内嵌音频";
  if (source.type === "aliyun_vod_rendition") {
    return `VOD 音频转码 · ${source.rendition.definition ?? "MP3"}`;
  }
  return source.sourceType === "uploaded" ? "平台上传音频" : "独立阿里云 VOD 音频";
}

type TrackEditorProps = {
  title: string;
  sourceLabel: string;
  draft: TrackDraft;
  disabled: boolean;
  saveLabel: string;
  onChange: (next: Partial<TrackDraft>) => void;
  onOffsetAdjust: (deltaMilliseconds: number) => void;
  onOffsetReset: () => void;
  onSave: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
};

function TrackEditor(props: TrackEditorProps) {
  const offsetDescription = describeMediaAudioTrackOffset(props.draft.offsetSeconds);
  const parsedOffset = parseMediaAudioTrackOffsetSeconds(props.draft.offsetSeconds);
  const offsetSteps = [-10, -1, 1, 10] as const;

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
      <label className="media-audio-offset-field">
        <span>同步偏移（秒）</span>
        <div className="media-audio-offset-input">
          <input
            type="number"
            min={-86_400}
            max={86_400}
            step="0.001"
            value={props.draft.offsetSeconds}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ offsetSeconds: event.target.value })}
          />
          <span aria-hidden="true">s</span>
        </div>
        <div className="media-audio-offset-stepper" aria-label="毫秒偏移校准">
          {offsetSteps.slice(0, 2).map((delta) => (
            <button
              key={delta}
              type="button"
              disabled={
                props.disabled ||
                adjustMediaAudioTrackOffsetDraft(props.draft.offsetSeconds, delta) === null
              }
              onClick={() => props.onOffsetAdjust(delta)}
            >
              {delta} ms
            </button>
          ))}
          <button
            type="button"
            className="media-audio-offset-reset"
            title="偏移归零"
            aria-label="偏移归零"
            disabled={props.disabled || parsedOffset === 0}
            onClick={props.onOffsetReset}
          >
            <RotateCcw size={13} />
          </button>
          {offsetSteps.slice(2).map((delta) => (
            <button
              key={delta}
              type="button"
              disabled={
                props.disabled ||
                adjustMediaAudioTrackOffsetDraft(props.draft.offsetSeconds, delta) === null
              }
              onClick={() => props.onOffsetAdjust(delta)}
            >
              +{delta} ms
            </button>
          ))}
        </div>
        <small className={offsetDescription ? "" : "is-invalid"}>
          {offsetDescription ?? "请输入正负 86400 秒以内的有效偏移。"}
        </small>
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
