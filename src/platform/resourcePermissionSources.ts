import type { EffectiveResourcePermission } from "@xiqu/shared";

type PermissionOrigin = EffectiveResourcePermission["inheritedFrom"][number];

/** 把职责组来源与普通祖先 ACL 分开说明，避免用户误以为移除直接授权会同时撤销职责。 */
export function describeSupplementalPermissionSources(
  origins: readonly PermissionOrigin[],
  residual = false,
): string | null {
  const responsibilities = origins
    .filter(({ responsibilityGroup }) => responsibilityGroup)
    .map(({ resourceName, responsibilityGroup }) =>
      `${resourceName}（${responsibilityGroup === "annotation" ? "标注组" : "审核组"}）`);
  const inherited = origins
    .filter(({ responsibilityGroup }) => !responsibilityGroup)
    .map(({ resourceName }) => resourceName);
  const descriptions = [
    responsibilities.length
      ? `${residual ? "职责组仍提供" : "职责组"}：${responsibilities.join("、")}`
      : null,
    inherited.length
      ? `${residual ? "仍继承自" : "继承自"}：${inherited.join("、")}`
      : null,
  ].filter((value): value is string => Boolean(value));
  return descriptions.length ? descriptions.join("；") : null;
}
