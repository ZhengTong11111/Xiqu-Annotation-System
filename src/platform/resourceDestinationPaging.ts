import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { isResourceContainer } from "./resourceColumnModel";
import { collectResourcePickerItems } from "./resourcePickerPaging";

export type DestinationContainerPage = {
  items: ResourceEntry[];
  breadcrumbs: ResourceListPage["breadcrumbs"];
  nextCursor: string | null;
};

// 目标选择器按有限页数跳过纯文件页面，避免第 201 项后的目录永久不可达，也避免一次抓取全集。
export async function collectDestinationContainers(
  fetchPage: (cursor: string | null) => Promise<ResourceListPage>,
  startCursor: string | null,
  maxScannedPages = 4,
): Promise<DestinationContainerPage> {
  return collectResourcePickerItems(
    fetchPage,
    startCursor,
    isResourceContainer,
    maxScannedPages,
  );
}
