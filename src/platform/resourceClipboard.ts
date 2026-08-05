import type { ResourceEntry } from "@xiqu/shared";

export type ResourceCopySuccess = {
  source: ResourceEntry;
  copy: ResourceEntry;
};

export type ResourceCopyFailure = {
  source: ResourceEntry;
  error: unknown;
};

/**
 * 逐个复制多个根资源，并保留每个根的独立结果。
 *
 * 服务端已经保证单个文件夹/项目副本在一个事务内全有或全无；前端不再额外制造“批量原子”假象。
 * 一个根失败时继续处理后续根，最后由资源管理器统一展示部分成功结果。
 */
export async function copyResourcesSequentially(
  sources: ResourceEntry[],
  parentId: string,
  copy: (resourceId: string, parentId: string) => Promise<ResourceEntry>,
) {
  const copied: ResourceCopySuccess[] = [];
  const failed: ResourceCopyFailure[] = [];
  for (const source of sources) {
    try {
      copied.push({ source, copy: await copy(source.id, parentId) });
    } catch (error) {
      failed.push({ source, error });
    }
  }
  return { copied, failed };
}
