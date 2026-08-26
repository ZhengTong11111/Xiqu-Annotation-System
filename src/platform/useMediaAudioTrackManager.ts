import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AliyunVodAudioRendition,
  MediaAudioTrackKind,
  MediaAudioTrackRecord,
  ResourceEntry,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  adjustMediaAudioTrackOffsetDraft,
  formatMediaAudioTrackOffsetDraft,
  parseMediaAudioTrackOffsetSeconds,
} from "./mediaAudioTrackOffset";

export type ExternalTrackKind = Exclude<MediaAudioTrackKind, "original">;

export type TrackDraft = {
  name: string;
  kind: ExternalTrackKind;
  offsetSeconds: string;
  enabled: boolean;
};

export type NewTrackDraft = TrackDraft & {
  source:
    | { type: "media_resource"; resource: ResourceEntry }
    | {
        type: "aliyun_vod_rendition";
        mediaResourceId: string;
        rendition: AliyunVodAudioRendition;
      };
};

type Options = {
  client: PlatformClient;
  primaryMediaResourceId: string;
  open: boolean;
  onChanged: () => Promise<void> | void;
};

/**
 * 管理器会话集中处理列表重读、单飞 mutation 和迟到响应隔离。React 视图只消费这里的状态，
 * 不自行拼接一套 CRUD 顺序，从而保证每次写入后都回到服务端权威列表。
 */
export function useMediaAudioTrackManager(options: Options) {
  const [tracks, setTracks] = useState<MediaAudioTrackRecord[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrackDraft | null>(null);
  const [newTrackDraft, setNewTrackDraft] = useState<NewTrackDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutationName, setMutationName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const selectedTrack = useMemo(
    () => tracks.find(({ id }) => id === selectedTrackId) ?? null,
    [selectedTrackId, tracks],
  );
  const interactionBusy = loading || mutationName !== null;

  const loadTracks = useCallback(async (
    generation: number,
    preferredTrackId: string | null = null,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const result = await options.client.listMediaAudioTracks(
        options.primaryMediaResourceId,
      );
      if (sessionGenerationRef.current !== generation) return;
      if (result.primaryMediaResourceId !== options.primaryMediaResourceId) {
        throw new Error("服务器音轨列表与当前主媒体不匹配。");
      }
      const nextSelection = preferredTrackId &&
        result.tracks.some(({ id }) => id === preferredTrackId)
        ? preferredTrackId
        : result.tracks.find(({ kind }) => kind === "original")?.id ??
          result.tracks[0]?.id ?? null;
      setTracks(result.tracks);
      setSelectedTrackId(nextSelection);
    } catch (nextError) {
      if (sessionGenerationRef.current === generation) {
        setError(describeError(nextError, "读取音轨列表失败。"));
      }
    } finally {
      if (sessionGenerationRef.current === generation) setLoading(false);
    }
  }, [options.client, options.primaryMediaResourceId]);

  useEffect(() => {
    const generation = ++sessionGenerationRef.current;
    if (!options.open) {
      setTracks([]);
      setSelectedTrackId(null);
      setDraft(null);
      setNewTrackDraft(null);
      setError(null);
      return;
    }
    void loadTracks(generation);
    return () => {
      sessionGenerationRef.current += 1;
    };
  }, [loadTracks, options.open]);

  useEffect(() => {
    if (!selectedTrack || selectedTrack.kind === "original") {
      setDraft(null);
      return;
    }
    // 选中另一条音轨时从服务器记录重建表单，不携带上一条未提交的字段。
    setDraft({
      name: selectedTrack.name,
      kind: selectedTrack.kind,
      offsetSeconds: formatMediaAudioTrackOffsetDraft(selectedTrack.offsetSeconds),
      enabled: selectedTrack.enabled,
    });
  }, [selectedTrack]);

  async function runMutation<T>(input: {
    name: string;
    execute: () => Promise<T>;
    preferredTrackId: (result: T) => string | null;
  }) {
    // state 负责按钮反馈，ref 同步挡住同一事件循环内的双击，避免发出两条并发排序或新增请求。
    if (interactionBusy || mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    const generation = sessionGenerationRef.current;
    setMutationName(input.name);
    setError(null);
    try {
      const result = await input.execute();
      if (sessionGenerationRef.current !== generation) return false;
      await loadTracks(generation, input.preferredTrackId(result));
      if (sessionGenerationRef.current !== generation) return false;
      try {
        await options.onChanged();
      } catch {
        // 服务端写入已经提交，外围试听列表刷新失败不能反向伪装成“保存失败”并诱导用户重复提交。
        setError("音轨已保存，但编辑器试听列表刷新失败，请关闭窗口后手动刷新。");
      }
      return true;
    } catch (nextError) {
      if (sessionGenerationRef.current === generation) {
        setError(describeError(nextError, `${input.name}失败。`));
      }
      return false;
    } finally {
      mutationInFlightRef.current = false;
      if (sessionGenerationRef.current === generation) setMutationName(null);
    }
  }

  async function createTrack() {
    if (!newTrackDraft) return false;
    const offsetSeconds = parseMediaAudioTrackOffsetSeconds(newTrackDraft.offsetSeconds);
    if (!newTrackDraft.name.trim() || offsetSeconds === null) {
      setError("请填写音轨名称和有效的时间偏移。");
      return false;
    }
    const created = await runMutation({
      name: "新增音轨",
      execute: () => options.client.createMediaAudioTrack(
        options.primaryMediaResourceId,
        {
          source: newTrackDraft.source.type === "media_resource"
            ? {
                type: "media_resource",
                mediaResourceId: newTrackDraft.source.resource.id,
              }
            : {
                type: "aliyun_vod_rendition",
                mediaResourceId: newTrackDraft.source.mediaResourceId,
                jobId: newTrackDraft.source.rendition.jobId,
              },
          name: newTrackDraft.name.trim(),
          kind: newTrackDraft.kind,
          offsetSeconds,
        },
      ),
      preferredTrackId: (result) => result.id,
    });
    if (created) setNewTrackDraft(null);
    return created;
  }

  async function saveSelectedTrack() {
    if (!selectedTrack || selectedTrack.kind === "original" || !draft) return false;
    const offsetSeconds = parseMediaAudioTrackOffsetSeconds(draft.offsetSeconds);
    if (!draft.name.trim() || offsetSeconds === null) {
      setError("请填写音轨名称和有效的时间偏移。");
      return false;
    }
    return runMutation({
      name: "保存音轨",
      execute: () => options.client.updateMediaAudioTrack(
        options.primaryMediaResourceId,
        selectedTrack.id,
        {
          name: draft.name.trim(),
          kind: draft.kind,
          offsetSeconds,
          enabled: draft.enabled,
        },
      ),
      preferredTrackId: (result) => result.id,
    });
  }

  async function moveSelectedTrack(direction: -1 | 1) {
    if (!selectedTrack) return false;
    const index = tracks.findIndex(({ id }) => id === selectedTrack.id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= tracks.length) return false;
    const orderedIds = tracks.map(({ id }) => id);
    [orderedIds[index], orderedIds[targetIndex]] = [
      orderedIds[targetIndex]!,
      orderedIds[index]!,
    ];
    return runMutation({
      name: "调整音轨顺序",
      execute: () => options.client.reorderMediaAudioTracks(
        options.primaryMediaResourceId,
        { trackIds: orderedIds },
      ),
      preferredTrackId: () => selectedTrack.id,
    });
  }

  async function deleteTrack(trackId: string) {
    const track = tracks.find(({ id }) => id === trackId);
    if (!track || track.kind === "original") return false;
    const originalTrackId = tracks.find(({ kind }) => kind === "original")?.id ?? null;
    return runMutation({
      name: "删除音轨",
      execute: () => options.client.deleteMediaAudioTrack(
        options.primaryMediaResourceId,
        track.id,
      ),
      preferredTrackId: () => originalTrackId,
    });
  }

  return {
    tracks,
    selectedTrackId,
    selectedTrack,
    draft,
    newTrackDraft,
    loading,
    mutationName,
    error,
    interactionBusy,
    selectTrack: (trackId: string) => {
      setError(null);
      setNewTrackDraft(null);
      setSelectedTrackId(trackId);
    },
    beginCreateMediaResource: (source: ResourceEntry) => {
      setError(null);
      setNewTrackDraft({
        source: { type: "media_resource", resource: source },
        name: source.name,
        kind: "custom",
        offsetSeconds: "0",
        enabled: true,
      });
      setSelectedTrackId(null);
    },
    beginCreateVodRendition: (
      mediaResourceId: string,
      rendition: AliyunVodAudioRendition,
    ) => {
      setError(null);
      const quality = rendition.definition ?? "音频";
      setNewTrackDraft({
        source: {
          type: "aliyun_vod_rendition",
          mediaResourceId,
          rendition,
        },
        name: `VOD ${quality}音轨`,
        kind: "custom",
        offsetSeconds: "0",
        enabled: true,
      });
      setSelectedTrackId(null);
    },
    cancelCreate: () => setNewTrackDraft(null),
    updateDraft: (next: Partial<TrackDraft>) => {
      setDraft((current) => current ? { ...current, ...next } : current);
    },
    updateNewTrackDraft: (next: Partial<TrackDraft>) => {
      setNewTrackDraft((current) => current ? { ...current, ...next } : current);
    },
    adjustDraftOffset: (deltaMilliseconds: number) => {
      setDraft((current) => adjustTrackDraftOffset(current, deltaMilliseconds));
    },
    adjustNewTrackOffset: (deltaMilliseconds: number) => {
      setNewTrackDraft((current) => adjustTrackDraftOffset(current, deltaMilliseconds));
    },
    resetDraftOffset: () => {
      setDraft((current) => current ? { ...current, offsetSeconds: "0" } : current);
    },
    resetNewTrackOffset: () => {
      setNewTrackDraft((current) => current ? { ...current, offsetSeconds: "0" } : current);
    },
    createTrack,
    saveSelectedTrack,
    moveSelectedTrack,
    deleteTrack,
  };
}

function adjustTrackDraftOffset<T extends TrackDraft>(
  current: T | null,
  deltaMilliseconds: number,
) {
  if (!current) return current;
  const nextOffset = adjustMediaAudioTrackOffsetDraft(
    current.offsetSeconds,
    deltaMilliseconds,
  );
  // 非法草稿和越界步进保持原值，不能把用户输入静默重置为零。
  return nextOffset === null ? current : { ...current, offsetSeconds: nextOffset };
}

function describeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
