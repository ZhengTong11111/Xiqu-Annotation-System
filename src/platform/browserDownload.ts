// 使用临时锚点触发浏览器原生流式下载；调用方负责确保 URL 已通过服务端权限校验。
export function downloadFromUrl(url: string, fallbackFileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fallbackFileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
