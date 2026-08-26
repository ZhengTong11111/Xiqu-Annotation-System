import assert from "node:assert/strict";
import test from "node:test";
import { subscribeToMediaPlaybackRecovery } from "./mediaPlaybackLifecycle";

class FakeEventTarget {
  visibilityState = "hidden";
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(new Event(type));
    }
  }
}

test("online、pageshow 和重新可见唤醒同一恢复入口", () => {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  let recoverCount = 0;
  const unsubscribe = subscribeToMediaPlaybackRecovery({
    windowTarget,
    documentTarget,
    onRecover: () => {
      recoverCount += 1;
    },
  });

  windowTarget.emit("online");
  windowTarget.emit("pageshow");
  documentTarget.emit("visibilitychange");
  assert.equal(recoverCount, 2);
  documentTarget.visibilityState = "visible";
  documentTarget.emit("visibilitychange");
  assert.equal(recoverCount, 3);

  unsubscribe();
  windowTarget.emit("online");
  documentTarget.emit("visibilitychange");
  assert.equal(recoverCount, 3);
});
