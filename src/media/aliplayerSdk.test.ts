import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAliplayerSdk,
  resetAliplayerLoaderForTests,
  type AliplayerConstructor,
} from "./aliplayerSdk";

class FakeScriptElement extends EventTarget {
  dataset: Record<string, string> = {};
  src = "";
  async = false;
  removed = false;
  remove() { this.removed = true; }
}

class FakeLinkElement {
  dataset: Record<string, string> = {};
  rel = "";
  href = "";
}

class FakeDocument {
  scripts: FakeScriptElement[] = [];
  links: FakeLinkElement[] = [];
  onScriptAppend: (script: FakeScriptElement) => void = () => undefined;
  head = {
    appendChild: (node: FakeScriptElement | FakeLinkElement) => {
      if (node instanceof FakeScriptElement) {
        this.scripts.push(node);
        this.onScriptAppend(node);
      } else {
        this.links.push(node);
      }
      return node;
    },
  };

  querySelector<T>(selector: string): T | null {
    if (selector.startsWith("script")) {
      return (this.scripts.find((script) => !script.removed) ?? null) as T | null;
    }
    if (selector.startsWith("link")) return (this.links[0] ?? null) as T | null;
    return null;
  }

  createElement(tag: string) {
    return tag === "script" ? new FakeScriptElement() : new FakeLinkElement();
  }
}

const FAKE_CONSTRUCTOR = class {} as unknown as AliplayerConstructor;

/**
 * 每个用例安装独立 window/document，防止模块级 loader Promise 和 DOM 标记相互污染。
 * fake 只覆盖加载器实际使用的窄能力，不模拟播放器本身。
 */
async function withFakeDom(
  run: (context: { document: FakeDocument; window: { Aliplayer?: AliplayerConstructor } }) => Promise<void>,
) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  const fakeWindow = {
    Aliplayer: undefined as AliplayerConstructor | undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  resetAliplayerLoaderForTests();
  try {
    await run({ document: fakeDocument, window: fakeWindow });
  } finally {
    resetAliplayerLoaderForTests();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
}

test("已有 Aliplayer 全局时不重复注入脚本", async () => {
  await withFakeDom(async ({ document, window }) => {
    window.Aliplayer = FAKE_CONSTRUCTOR;
    assert.equal(await loadAliplayerSdk(), FAKE_CONSTRUCTOR);
    assert.equal(document.scripts.length, 0);
  });
});

test("并发 SDK 请求复用同一 Promise 和同一固定脚本", async () => {
  await withFakeDom(async ({ document, window }) => {
    document.onScriptAppend = (script) => queueMicrotask(() => {
      window.Aliplayer = FAKE_CONSTRUCTOR;
      script.dispatchEvent(new Event("load"));
    });
    const first = loadAliplayerSdk();
    const second = loadAliplayerSdk();
    assert.equal(first, second);
    assert.equal(await first, FAKE_CONSTRUCTOR);
    assert.equal(document.scripts.length, 1);
    assert.match(document.scripts[0]?.src ?? "", /2\.38\.3\/aliplayer-min\.js$/);
    assert.equal(document.links.length, 1);
  });
});

test("SDK 加载失败会清理 script 并允许显式重试", async () => {
  await withFakeDom(async ({ document, window }) => {
    document.onScriptAppend = (script) => queueMicrotask(() => script.dispatchEvent(new Event("error")));
    await assert.rejects(loadAliplayerSdk(), /加载失败/);
    assert.equal(document.scripts[0]?.removed, true);

    document.onScriptAppend = (script) => queueMicrotask(() => {
      window.Aliplayer = FAKE_CONSTRUCTOR;
      script.dispatchEvent(new Event("load"));
    });
    assert.equal(await loadAliplayerSdk(), FAKE_CONSTRUCTOR);
    assert.equal(document.scripts.length, 2);
  });
});
