export const TIMELINE_DRAG_ACTIVATION_PX = 4;

// 松手位置重新回到激活阈值内时，本次手势应当取消而不是提交先前产生的预览。
// 这一规则独立于轨道类型，保证逐字、动作、自定义块和批量拖动使用同一收尾语义。
export function isTimelineDragActivated(
  originClientX: number,
  finalClientX: number,
  activationPx = TIMELINE_DRAG_ACTIVATION_PX,
): boolean {
  return Math.abs(finalClientX - originClientX) >= activationPx;
}
