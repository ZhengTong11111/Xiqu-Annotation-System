import {
  MAX_ANNOTATION_TOOL_ATTEMPT_BATCH_SIZE,
  parseAnnotationToolAttemptBatchRequest,
  type AnnotationToolAttemptState,
} from "@xiqu/shared";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DATABASE_NAME = "xiqu-annotation-tool-attempts";
const STORE_NAME = "attempts";
const USER_INDEX_NAME = "by-user";
const DEFAULT_MAX_RECORDS_PER_USER = 2_000;
const DEFAULT_MAX_RECORDS_TOTAL = 5_000;

export type QueuedAnnotationToolAttempt = {
  key: string;
  userId: string;
  attempt: AnnotationToolAttemptState;
  version: number;
  updatedAt: number;
};

interface AnnotationToolAttemptQueueDatabase extends DBSchema {
  attempts: {
    key: string;
    value: QueuedAnnotationToolAttempt;
    indexes: { "by-user": string };
  };
}

export type AnnotationToolAttemptQueueStore = {
  upsert(userId: string, attempt: AnnotationToolAttemptState): Promise<QueuedAnnotationToolAttempt>;
  listForUser(userId: string, limit?: number): Promise<QueuedAnnotationToolAttempt[]>;
  deleteIfVersion(record: Pick<QueuedAnnotationToolAttempt, "key" | "version">): Promise<boolean>;
  close(): Promise<void>;
};

export class AnnotationToolAttemptQueueCapacityError extends Error {
  constructor() {
    super("浏览器工具尝试队列已达到容量上限。");
  }
}

type QueueLimits = {
  maxRecordsPerUser?: number;
  maxRecordsTotal?: number;
};

/**
 * 行为尝试使用独立的小型 IndexedDB，不进入 ProjectData 草稿、撤销历史或保存状态机。
 * 同一 attempt 的每次写入都是完整状态快照；仓库负责单调合并，防止迟到的 invoked 写入覆盖 terminal 状态。
 */
export function createAnnotationToolAttemptQueueStore(
  databaseName = DATABASE_NAME,
  limits: QueueLimits = {},
): AnnotationToolAttemptQueueStore {
  const maxRecordsPerUser = limits.maxRecordsPerUser ?? DEFAULT_MAX_RECORDS_PER_USER;
  const maxRecordsTotal = limits.maxRecordsTotal ?? DEFAULT_MAX_RECORDS_TOTAL;
  assertPositiveLimit(maxRecordsPerUser, "maxRecordsPerUser");
  assertPositiveLimit(maxRecordsTotal, "maxRecordsTotal");
  if (maxRecordsPerUser > maxRecordsTotal) {
    throw new Error("单账号工具尝试队列上限不能超过全局上限。");
  }

  let databasePromise: Promise<IDBPDatabase<AnnotationToolAttemptQueueDatabase>> | null = null;
  const getDatabase = () => {
    databasePromise ??= openDB<AnnotationToolAttemptQueueDatabase>(databaseName, 1, {
      upgrade(database) {
        if (database.objectStoreNames.contains(STORE_NAME)) return;
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex(USER_INDEX_NAME, "userId");
      },
    });
    return databasePromise;
  };

  return {
    async upsert(userId, attempt) {
      assertUserId(userId);
      const normalizedAttempt = normalizeAttempt(attempt);
      if (!normalizedAttempt) throw new Error("工具尝试状态不符合共享合同。");
      const key = getQueueKey(userId, normalizedAttempt.id);
      const database = await getDatabase();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const rawExisting = await store.get(key) as unknown;
      const existing = normalizeQueueRecord(rawExisting);

      // 浏览器存储若被旧版本或扩展污染，先删除坏行再按当前严格合同重建，绝不把未知对象发给服务端。
      if (rawExisting !== undefined && !existing) await store.delete(key);
      if (!existing) {
        const [userCount, totalCount] = await Promise.all([
          store.index(USER_INDEX_NAME).count(userId),
          store.count(),
        ]);
        if (userCount >= maxRecordsPerUser || totalCount >= maxRecordsTotal) {
          const capacityError = new AnnotationToolAttemptQueueCapacityError();
          transaction.abort();
          // 主动 abort 会让 transaction.done 拒绝；这里消费预期拒绝后再抛业务错误，避免遗留未处理 Promise。
          await transaction.done.catch(() => undefined);
          throw capacityError;
        }
      }

      const mergedAttempt = existing
        ? mergeAnnotationToolAttemptState(existing.attempt, normalizedAttempt)
        : normalizedAttempt;
      if (existing && areAttemptsEqual(existing.attempt, mergedAttempt)) {
        await transaction.done;
        return existing;
      }
      const record: QueuedAnnotationToolAttempt = {
        key,
        userId,
        attempt: mergedAttempt,
        version: (existing?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await store.put(record);
      await transaction.done;
      return record;
    },

    async listForUser(userId, limit = MAX_ANNOTATION_TOOL_ATTEMPT_BATCH_SIZE) {
      assertUserId(userId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ANNOTATION_TOOL_ATTEMPT_BATCH_SIZE) {
        throw new Error("工具尝试队列批量大小不正确。");
      }
      const database = await getDatabase();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const index = transaction.objectStore(STORE_NAME).index(USER_INDEX_NAME);
      const records: QueuedAnnotationToolAttempt[] = [];
      let cursor = await index.openCursor(userId);
      while (cursor && records.length < limit) {
        const normalized = normalizeQueueRecord(cursor.value as unknown);
        if (!normalized || normalized.userId !== userId) {
          // 损坏记录只能从本地队列清除，不能尝试猜测字段或向 API 发送部分数据。
          await cursor.delete();
        } else {
          records.push(normalized);
        }
        cursor = await cursor.continue();
      }
      await transaction.done;
      return records;
    },

    async deleteIfVersion(record) {
      const database = await getDatabase();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const current = normalizeQueueRecord(await store.get(record.key) as unknown);
      if (!current || current.version !== record.version) {
        await transaction.done;
        return false;
      }
      await store.delete(record.key);
      await transaction.done;
      return true;
    },

    async close() {
      if (!databasePromise) return;
      const database = await databasePromise;
      database.close();
      databasePromise = null;
    },
  };
}

/** 旧前缀状态可以迟到，但已经存在的确认、终态和免提示事实不能倒退或被改写。 */
export function mergeAnnotationToolAttemptState(
  existing: AnnotationToolAttemptState,
  incoming: AnnotationToolAttemptState,
): AnnotationToolAttemptState {
  if (
    existing.id !== incoming.id ||
    existing.eventName !== incoming.eventName ||
    existing.annotationFileId !== incoming.annotationFileId ||
    existing.sentenceId !== incoming.sentenceId ||
    existing.entryPoint !== incoming.entryPoint ||
    existing.invokedAt !== incoming.invokedAt ||
    existing.characterCount !== incoming.characterCount ||
    existing.sentenceDurationMs !== incoming.sentenceDurationMs
  ) {
    throw new Error("工具尝试身份字段发生冲突。");
  }
  if (existing.confirmedAt && incoming.confirmedAt && existing.confirmedAt !== incoming.confirmedAt) {
    throw new Error("工具尝试确认时间发生冲突。");
  }
  if (existing.outcome && incoming.outcome && (
    existing.outcome !== incoming.outcome || existing.finishedAt !== incoming.finishedAt
  )) {
    throw new Error("工具尝试终态发生冲突。");
  }
  if (existing.outcome && !existing.confirmedAt && incoming.confirmedAt) {
    throw new Error("工具尝试终态后不能补写确认时间。");
  }
  const existingDetails = existing.details ?? null;
  const incomingDetails = incoming.details ?? null;
  if (existingDetails && incomingDetails && JSON.stringify(existingDetails) !== JSON.stringify(incomingDetails)) {
    throw new Error("工具尝试详情发生冲突。");
  }

  const merged: AnnotationToolAttemptState = {
    ...existing,
    confirmedAt: existing.confirmedAt ?? incoming.confirmedAt ?? null,
    finishedAt: existing.finishedAt ?? incoming.finishedAt ?? null,
    outcome: existing.outcome ?? incoming.outcome ?? null,
    suppressPrompt: existing.suppressPrompt || incoming.suppressPrompt,
    details: existingDetails ?? incomingDetails,
  };
  const normalized = normalizeAttempt(merged);
  if (!normalized) throw new Error("合并后的工具尝试状态不符合共享合同。");
  return normalized;
}

function normalizeQueueRecord(value: unknown): QueuedAnnotationToolAttempt | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["key", "userId", "attempt", "version", "updatedAt"])) {
    return null;
  }
  const userId = value.userId;
  const version = value.version;
  const updatedAt = value.updatedAt;
  const attempt = normalizeAttempt(value.attempt);
  if (
    typeof value.key !== "string" ||
    typeof userId !== "string" || !isValidUserId(userId) ||
    !Number.isSafeInteger(version) || (version as number) < 1 ||
    typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0 ||
    !attempt || value.key !== getQueueKey(userId, attempt.id)
  ) return null;
  return {
    key: value.key,
    userId,
    attempt,
    version: version as number,
    updatedAt,
  };
}

function normalizeAttempt(value: unknown): AnnotationToolAttemptState | null {
  const parsed = parseAnnotationToolAttemptBatchRequest({ attempts: [value] });
  return parsed.success ? parsed.data.attempts[0] : null;
}

function getQueueKey(userId: string, attemptId: string) {
  return `${encodeURIComponent(userId)}|${attemptId}`;
}

function areAttemptsEqual(left: AnnotationToolAttemptState, right: AnnotationToolAttemptState) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertUserId(userId: string) {
  if (!isValidUserId(userId)) throw new Error("工具尝试队列账号标识不正确。");
}

function isValidUserId(value: string) {
  return value.length >= 1 && value.length <= 200 && value.trim() === value;
}

function assertPositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正安全整数。`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export const annotationToolAttemptQueueStore = createAnnotationToolAttemptQueueStore();
