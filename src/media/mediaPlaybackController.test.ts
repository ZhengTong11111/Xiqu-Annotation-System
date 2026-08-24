import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestMediaPlaybackCommand,
  type MediaPlaybackBackend,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";

const READY_SNAPSHOT: MediaPlaybackSnapshot = {
  ready: true,
  currentTime: 0,
  duration: 20,
  paused: true,
  ended: false,
};

class DeferredPlaybackBackend implements MediaPlaybackBackend {
  snapshot = { ...READY_SNAPSHOT };
  playCount = 0;
  pauseCount = 0;
  seekResolvers: Array<() => void> = [];
  playResolvers: Array<() => void> = [];

  getSnapshot() { return this.snapshot; }
  seek() { return new Promise<void>((resolve) => this.seekResolvers.push(resolve)); }
  play() {
    this.playCount += 1;
    return new Promise<void>((resolve) => this.playResolvers.push(resolve));
  }
  pause() { this.pauseCount += 1; }
  setPlaybackRate() {}
  setVolume() {}
  setMuted() {}
  dispose() {}
}

test("后发 pause 会阻止旧 seek 完成后恢复播放", async () => {
  const backend = new DeferredPlaybackBackend();
  const command = new LatestMediaPlaybackCommand(() => backend);
  const seek = command.seek(5, { playAfterSeek: true });

  command.pause();
  backend.seekResolvers[0]?.();
  await seek;

  assert.equal(backend.playCount, 0);
  assert.equal(backend.pauseCount, 1);
});

test("异步 play 晚于 pause 完成时仍由 pause 最终占优", async () => {
  const backend = new DeferredPlaybackBackend();
  const command = new LatestMediaPlaybackCommand(() => backend);
  const play = command.play();

  command.pause();
  backend.playResolvers[0]?.();
  await play;

  assert.equal(backend.playCount, 1);
  assert.equal(backend.pauseCount, 2);
});
