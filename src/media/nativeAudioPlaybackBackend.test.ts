import assert from "node:assert/strict";
import test from "node:test";
import type { NativeAudioElementPort } from "./nativeAudioPlaybackBackend";
import { createNativeAudioPlaybackBackend } from "./nativeAudioPlaybackBackend";

class FakeAudioElement implements NativeAudioElementPort {
  currentTime = 0;
  duration = 60;
  paused = true;
  ended = false;
  readyState = 1;
  playbackRate = 1;
  volume = 0.5;
  muted = false;
  src = "";
  preload = "none";
  loadCount = 0;
  private listeners = new Map<string, Set<EventListener>>();

  async play() { this.paused = false; this.emit("play"); }
  pause() { this.paused = true; this.emit("pause"); }
  load() { this.loadCount += 1; }
  addEventListener(type: string, listener: EventListener) {
    const values = this.listeners.get(type) ?? new Set<EventListener>();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

test("原生外部音频映射媒体事件并在 dispose 后彻底静默", async () => {
  const media = new FakeAudioElement();
  const ready: number[] = [];
  const playing: boolean[] = [];
  const buffering: boolean[] = [];
  const errors: string[] = [];
  const backend = createNativeAudioPlaybackBackend(
    "/api/files/audio/content",
    {
      onReady: (snapshot) => ready.push(snapshot.duration),
      onTimeUpdate: () => undefined,
      onPlayStateChange: (value) => playing.push(value),
      onBufferingChange: (value) => buffering.push(value),
      onError: (message) => errors.push(message),
    },
    () => media,
  );
  media.emit("loadedmetadata");
  // stalled 只说明下载暂时没有进展；已有缓冲仍可播放时不能暂停主视频。
  media.emit("stalled");
  assert.deepEqual(buffering, []);
  const seeking = backend.seek(12);
  media.emit("waiting");
  assert.deepEqual(buffering, []);
  media.emit("seeked");
  await seeking;
  media.emit("waiting");
  media.emit("canplay");
  await backend.play();
  backend.pause();
  backend.setPlaybackRate(1.5);
  backend.setVolume(0.75);
  backend.setMuted(true);

  assert.deepEqual(ready, [60]);
  assert.deepEqual(buffering, [true, false]);
  assert.deepEqual(playing, [true, false]);
  assert.equal(media.playbackRate, 1.5);
  assert.equal(media.volume, 0.75);
  assert.equal(media.muted, true);
  assert.equal(media.preload, "auto");
  assert.equal(media.loadCount, 1);

  backend.dispose();
  media.emit("error");
  assert.deepEqual(errors, []);
  assert.equal(media.src, "");
  assert.equal(media.loadCount, 2);
});
