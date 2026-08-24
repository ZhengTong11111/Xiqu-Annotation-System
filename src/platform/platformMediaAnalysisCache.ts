import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DATABASE_NAME = "xiqu-platform-media-analysis-cache";
const ASSET_STORE_NAME = "assets";
const METADATA_STORE_NAME = "metadata";
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ASSETS = 2_000;

export type PlatformMediaAnalysisCacheIdentity = {
  userId: string;
  mediaResourceId: string;
  runId: string;
  assetId: string;
  size: number;
};

type CachedAssetRecord = {
  key: string;
  bytes: ArrayBuffer;
  byteLength: number;
};

type CachedAssetMetadata = {
  key: string;
  byteLength: number;
  touchedAt: number;
};

interface PlatformMediaAnalysisCacheDatabase extends DBSchema {
  assets: {
    key: string;
    value: CachedAssetRecord;
  };
  metadata: {
    key: string;
    value: CachedAssetMetadata;
    indexes: { "by-touched-at": number };
  };
}

export type PlatformMediaAnalysisPersistentCache = {
  get(identity: PlatformMediaAnalysisCacheIdentity): Promise<Uint8Array | undefined>;
  getMany(identities: readonly PlatformMediaAnalysisCacheIdentity[]): Promise<Map<string, Uint8Array>>;
  put(identity: PlatformMediaAnalysisCacheIdentity, bytes: Uint8Array): Promise<void>;
  putMany(entries: readonly {
    identity: PlatformMediaAnalysisCacheIdentity;
    bytes: Uint8Array;
  }[]): Promise<void>;
  close(): Promise<void>;
};

type CacheLimits = {
  maxBytes?: number;
  maxAssets?: number;
};

/**
 * 分析瓦片缓存按账号和不可变 run 隔离。key 不含访问令牌或媒体 URL，run/size 改变时自然失效。
 */
export function getPlatformMediaAnalysisCacheKey(identity: PlatformMediaAnalysisCacheIdentity) {
  return [
    identity.userId,
    identity.mediaResourceId,
    identity.runId,
    identity.assetId,
    String(identity.size),
  ].map(encodeURIComponent).join("|");
}

/**
 * IndexedDB 只承担跨页面的二级缓存；内存 LRU 仍负责当前帧的同步读取。
 * 写入和清理通过同一队列串行，避免并发 put 根据旧容量快照互相漏删。
 */
export function createPlatformMediaAnalysisPersistentCache(
  databaseName = DATABASE_NAME,
  limits: CacheLimits = {},
): PlatformMediaAnalysisPersistentCache {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAssets = limits.maxAssets ?? DEFAULT_MAX_ASSETS;
  assertPositiveLimit(maxBytes, "maxBytes");
  assertPositiveLimit(maxAssets, "maxAssets");

  let databasePromise: Promise<IDBPDatabase<PlatformMediaAnalysisCacheDatabase>> | null = null;
  let writeTail = Promise.resolve();
  const getDatabase = () => {
    databasePromise ??= openDB<PlatformMediaAnalysisCacheDatabase>(databaseName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) {
          database.createObjectStore(ASSET_STORE_NAME, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
          const metadata = database.createObjectStore(METADATA_STORE_NAME, { keyPath: "key" });
          metadata.createIndex("by-touched-at", "touchedAt");
        }
      },
    });
    return databasePromise;
  };
  const enqueueWrite = <T>(task: () => Promise<T>) => {
    const execution = writeTail.catch(() => undefined).then(task);
    writeTail = execution.then(() => undefined, () => undefined);
    return execution;
  };

  // 使用闭包调用批量方法，避免调用方解构 get/getMany 后丢失对象 this。
  const get = async (identity: PlatformMediaAnalysisCacheIdentity) =>
    (await getMany([identity])).get(identity.assetId);
  const getMany = async (identities: readonly PlatformMediaAnalysisCacheIdentity[]) => {
    if (identities.length === 0) return new Map();
    const database = await getDatabase();
    const keyed = identities.map((identity) => ({
      identity,
      key: getPlatformMediaAnalysisCacheKey(identity),
    }));
    // 批量读取二进制，命中后只更新轻量元数据；不把分析内容复制进日志或其他持久状态。
    const records = await Promise.all(keyed.map(({ key }) =>
      database.get(ASSET_STORE_NAME, key)));
    const hits = new Map<string, Uint8Array>();
    const invalidKeys: string[] = [];
    const touched: CachedAssetMetadata[] = [];
    records.forEach((record, index) => {
      if (!record) return;
      const { identity, key } = keyed[index];
      // 旧记录或浏览器存储损坏必须删除，不能把错误字节送入时间轴解码器。
      if (record.byteLength !== identity.size || record.bytes.byteLength !== identity.size) {
        invalidKeys.push(key);
        return;
      }
      hits.set(identity.assetId, new Uint8Array(record.bytes.slice(0)));
      touched.push({ key, byteLength: record.byteLength, touchedAt: Date.now() });
    });
    await enqueueWrite(async () => {
      const transaction = database.transaction(
        [ASSET_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      for (const key of invalidKeys) {
        void transaction.objectStore(ASSET_STORE_NAME).delete(key);
        void transaction.objectStore(METADATA_STORE_NAME).delete(key);
      }
      for (const metadata of touched) {
        void transaction.objectStore(METADATA_STORE_NAME).put(metadata);
      }
      await transaction.done;
    });
    return hits;
  };
  const putMany = async (entries: readonly {
    identity: PlatformMediaAnalysisCacheIdentity;
    bytes: Uint8Array;
  }[]) => {
    if (entries.length === 0) return;
    const records = entries.map(({ identity, bytes }) => {
      if (bytes.byteLength !== identity.size) {
        throw new Error("分析瓦片缓存写入大小与资产清单不一致。");
      }
      return {
        key: getPlatformMediaAnalysisCacheKey(identity),
        bytes: bytes.slice().buffer,
        byteLength: bytes.byteLength,
        touchedAt: Date.now(),
      };
    });
    await enqueueWrite(async () => {
      const database = await getDatabase();
      const transaction = database.transaction(
        [ASSET_STORE_NAME, METADATA_STORE_NAME],
        "readwrite",
      );
      for (const record of records) {
        void transaction.objectStore(ASSET_STORE_NAME).put({
          key: record.key,
          bytes: record.bytes,
          byteLength: record.byteLength,
        });
        void transaction.objectStore(METADATA_STORE_NAME).put({
          key: record.key,
          byteLength: record.byteLength,
          touchedAt: record.touchedAt,
        });
      }
      await transaction.done;
      await pruneCache(database, maxBytes, maxAssets);
    });
  };
  const put = async (identity: PlatformMediaAnalysisCacheIdentity, bytes: Uint8Array) => {
    await putMany([{ identity, bytes }]);
  };
  const close = async () => {
    await writeTail.catch(() => undefined);
    if (!databasePromise) return;
    const database = await databasePromise;
    database.close();
    databasePromise = null;
  };

  return {
    get,
    getMany,
    put,
    putMany,
    close,
  };
}

/** 元数据不包含二进制内容，可安全一次读取后按 LRU 删除超限资产。 */
async function pruneCache(
  database: IDBPDatabase<PlatformMediaAnalysisCacheDatabase>,
  maxBytes: number,
  maxAssets: number,
) {
  const metadata = await database.getAllFromIndex(METADATA_STORE_NAME, "by-touched-at");
  let totalBytes = metadata.reduce((sum, entry) => sum + entry.byteLength, 0);
  let totalAssets = metadata.length;
  const deleteKeys: string[] = [];
  for (const entry of metadata) {
    if (totalBytes <= maxBytes && totalAssets <= maxAssets) break;
    totalBytes -= entry.byteLength;
    totalAssets -= 1;
    deleteKeys.push(entry.key);
  }
  if (deleteKeys.length === 0) return;
  const transaction = database.transaction(
    [ASSET_STORE_NAME, METADATA_STORE_NAME],
    "readwrite",
  );
  for (const key of deleteKeys) {
    void transaction.objectStore(ASSET_STORE_NAME).delete(key);
    void transaction.objectStore(METADATA_STORE_NAME).delete(key);
  }
  await transaction.done;
}

function assertPositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正安全整数。`);
  }
}

export const platformMediaAnalysisPersistentCache =
  createPlatformMediaAnalysisPersistentCache();
