import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeMediaPlaybackBackend,
  type NativeMediaElementPort,
} from "./nativeMediaPlaybackBackend";

class FakeNativeMedia implements NativeMediaElementPort {
  currentTime = 0;
  duration = 30;
  paused = true;
  ended = false;
  readyState = 1;
  playbackRate = 1;
  playCount = 0;
  pauseCount = 0;
  private listeners = new Map<string, Set<EventListener>>();

  async play() { this.playCount += 1; this.paused = false; }
  pause() { this.pauseCount += 1; this.paused = true; }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

test("原生后端以 seeked 作为跳转完成事实", async () => {
  const media = new FakeNativeMedia();
  const backend = new NativeMediaPlaybackBackend(media);
  const pending = backend.seek(7.5);

  assert.equal(media.currentTime, 7.5);
  media.emit("seeked");
  await pending;
  assert.equal(backend.getSnapshot().currentTime, 7.5);
});

test("原生后端在媒体错误和销毁时确定拒绝等待中的 seek", async () => {
  const media = new FakeNativeMedia();
  const backend = new NativeMediaPlaybackBackend(media);
  const failed = backend.seek(4);
  media.emit("error");
  await assert.rejects(failed, /无法完成时间跳转/);

  const disposed = backend.seek(8);
  backend.dispose();
  await assert.rejects(disposed, /已切换/);
});

test("原生后端统一校验倍率并转发播放控制", async () => {
  const media = new FakeNativeMedia();
  const backend = new NativeMediaPlaybackBackend(media);
  backend.setPlaybackRate(1.5);
  await backend.play();
  backend.pause();

  assert.equal(media.playbackRate, 1.5);
  assert.equal(media.playCount, 1);
  assert.equal(media.pauseCount, 1);
  assert.throws(() => backend.setPlaybackRate(0), /必须是正数/);
});
