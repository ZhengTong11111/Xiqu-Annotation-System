import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PlatformDraftRecord } from "./platformDraft";
import { getPlatformDraftKey } from "./platformDraft";

const PLATFORM_DRAFT_DATABASE_NAME = "xiqu-platform-drafts";
const PLATFORM_DRAFT_STORE_NAME = "drafts";

interface PlatformDraftDatabase extends DBSchema {
  drafts: {
    key: string;
    value: PlatformDraftRecord;
  };
}

export type PlatformDraftStore = {
  get(userId: string, annotationFileId: string): Promise<unknown | null>;
  put(record: PlatformDraftRecord): Promise<void>;
  delete(userId: string, annotationFileId: string): Promise<void>;
  close(): Promise<void>;
};

// IndexedDB 连接由单一仓库延迟创建；可注入数据库名让测试实例彼此隔离而不改生产 schema。
export function createPlatformDraftStore(
  databaseName = PLATFORM_DRAFT_DATABASE_NAME,
): PlatformDraftStore {
  let databasePromise: Promise<IDBPDatabase<PlatformDraftDatabase>> | null = null;

  // 首次访问时建立 version 1 object store，以后 schema 变更只能通过递增版本迁移。
  const getDatabase = () => {
    databasePromise ??= openDB<PlatformDraftDatabase>(databaseName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(PLATFORM_DRAFT_STORE_NAME)) {
          database.createObjectStore(PLATFORM_DRAFT_STORE_NAME, { keyPath: "key" });
        }
      },
    });
    return databasePromise;
  };

  return {
    async get(userId, annotationFileId) {
      const database = await getDatabase();
      return await database.get(
        PLATFORM_DRAFT_STORE_NAME,
        getPlatformDraftKey(userId, annotationFileId),
      ) ?? null;
    },
    async put(record) {
      const database = await getDatabase();
      await database.put(PLATFORM_DRAFT_STORE_NAME, record);
    },
    async delete(userId, annotationFileId) {
      const database = await getDatabase();
      await database.delete(
        PLATFORM_DRAFT_STORE_NAME,
        getPlatformDraftKey(userId, annotationFileId),
      );
    },
    async close() {
      if (!databasePromise) return;
      const database = await databasePromise;
      database.close();
      databasePromise = null;
    },
  };
}

// 生产前端共享一个连接；账号与文件仍由复合 key 严格隔离。
export const platformDraftStore = createPlatformDraftStore();
