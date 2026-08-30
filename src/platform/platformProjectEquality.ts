import { areProjectValuesEqual } from "@xiqu/document-model";
import type { ProjectData } from "../types";
import { getPersistableProjectData } from "../utils/projectFile";
import { prepareProjectForServer } from "./platformProjectPayload";

// 平台一致性判断只比较可持久化正文；受保护媒体 URL 等会话字段不能制造假的基线冲突。
export function arePlatformProjectPayloadsEqual(left: ProjectData, right: ProjectData): boolean {
  return areProjectValuesEqual(
    prepareProjectForServer(getPersistableProjectData(left)),
    prepareProjectForServer(getPersistableProjectData(right)),
  );
}
