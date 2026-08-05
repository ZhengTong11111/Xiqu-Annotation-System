import type { AnnotationMediaReference } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import type { ProjectData } from "../types";
import { normalizeImportedProjectFile } from "../utils/projectFile";

const PLATFORM_FILE_PATH_PREFIX = "platform-file:";

// 平台文件进入编辑器时统一恢复受权限保护的媒体 URL，避免各打开入口各自迁移项目格式。
export function hydrateProjectForClient(
  payload: unknown,
  client: PlatformClient,
  media?: AnnotationMediaReference | null,
): ProjectData {
  const project = normalizeImportedProjectFile(payload).project;
  if (media?.sourceType === "uploaded") {
    return {
      ...project,
      video: {
        ...project.video,
        name: media.name,
        url: client.getFileContentUrl(media.fileId),
        source: "url",
        filePath: `${PLATFORM_FILE_PATH_PREFIX}${media.fileId}`,
        requiresManualImport: false,
      },
    };
  }
  if (media?.sourceType === "aliyun_vod") {
    return {
      ...project,
      video: {
        ...project.video,
        name: media.name,
        // R3h3 将通过短时会话和统一播放器注入运行时控制器；这里不能制造假 URL 触发完整 fetch。
        url: "",
        source: "url",
        filePath: null,
        requiresManualImport: false,
      },
    };
  }
  const fileId = getPlatformFileId(project.video.filePath);
  // 新平台响应中的显式 null 是权威“未绑定”状态；不能让旧 payload 内残留的迁移路径重新关联媒体。
  if (media === null && fileId) {
    return {
      ...project,
      video: {
        ...project.video,
        url: "",
        filePath: null,
        requiresManualImport: true,
      },
    };
  }
  if (!fileId) return project;
  return {
    ...project,
    video: {
      ...project.video,
      url: client.getFileContentUrl(fileId),
      source: "url",
      filePath: `${PLATFORM_FILE_PATH_PREFIX}${fileId}`,
    },
  };
}

// 平台项目写入服务器或浏览器草稿前统一移除带会话凭据的媒体 URL，只持久化稳定资源标识。
export function prepareProjectForServer(project: ProjectData): ProjectData {
  const fileId = getPlatformFileId(project.video.filePath);
  return {
    ...project,
    video: fileId
      ? {
          ...project.video,
          url: "",
          source: "url",
          filePath: `${PLATFORM_FILE_PATH_PREFIX}${fileId}`,
        }
      : project.video,
  };
}

// 稳定前缀只承载平台资源 id，绝不能把 API token 或临时 content URL 当成文件身份。
function getPlatformFileId(filePath: string | null | undefined) {
  return filePath?.startsWith(PLATFORM_FILE_PATH_PREFIX)
    ? filePath.slice(PLATFORM_FILE_PATH_PREFIX.length)
    : null;
}
