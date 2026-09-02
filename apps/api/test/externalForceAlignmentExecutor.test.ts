import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ExternalForceAlignmentExecutor } from "../src/externalForceAlignmentExecutor.js";

test("外部执行器通过受控文件协议读取投影和音频并返回 JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-executor-test-"));
  const executable = path.join(root, "aligner.mjs");
  try {
    await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const request = JSON.parse(await readFile(args.get("--request"), "utf8"));
await readFile(args.get("--audio"));
const sentences = request.projection.sentences.map((sentence) => ({
  sentenceId: sentence.sentenceId,
  startMicros: sentence.startMicros,
  endMicros: sentence.endMicros,
  confidence: 1,
  characters: sentence.characters.map((character, index) => ({
    characterId: character.characterId,
    startMicros: sentence.startMicros + index,
    endMicros: index === sentence.characters.length - 1 ? sentence.endMicros : sentence.startMicros + index + 1,
    confidence: 1,
    candidates: [],
  })),
}));
await writeFile(args.get("--output"), JSON.stringify({ version: 1, sentences }));
`);
    await chmod(executable, 0o700);
    const executor = new ExternalForceAlignmentExecutor(executable);
    await executor.checkReadiness();
    const output = await executor.execute({
      projection: {
        version: 1,
        sentences: [{
          sentenceId: "line-1",
          text: "梦",
          startMicros: 1_000_000,
          endMicros: 2_000_000,
          deliveryMode: "sung",
          roleTypes: [],
          characters: [{ characterId: "char-1", text: "梦" }],
        }],
      },
      audioOffsetMicros: 0,
      audio: { kind: "uploaded", stream: Readable.from([Buffer.from("audio")]) },
      model: {
        name: "test",
        version: "1",
        dictionaryVersion: "1",
        codeVersion: "1",
        config: {},
      },
    }, new AbortController().signal) as { sentences?: unknown[] };
    assert.equal(output.sentences?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("外部执行器拒绝相对路径并在启动前检查可执行权限", async () => {
  assert.throws(() => new ExternalForceAlignmentExecutor("relative/aligner"), /绝对路径/);
  const executor = new ExternalForceAlignmentExecutor("/definitely/missing/xiqu-aligner");
  await assert.rejects(executor.checkReadiness());
});
