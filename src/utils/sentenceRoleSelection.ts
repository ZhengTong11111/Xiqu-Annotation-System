// 角色选择在这里统一收敛为项目配置顺序，避免 UI 点击顺序制造不同 JSON 和协作前置条件。
export function normalizeSentenceRoleTypes(
  roleOptions: readonly string[],
  selectedRoles: Iterable<string>,
) {
  const selected = new Set(selectedRoles);
  return roleOptions.filter((role) => selected.has(role));
}

export function toggleSentenceRoleType(
  roleOptions: readonly string[],
  currentRoles: readonly string[],
  role: string,
  selected?: boolean,
) {
  const next = new Set(currentRoles);
  const shouldSelect = selected ?? !next.has(role);
  if (shouldSelect) next.add(role);
  else next.delete(role);
  return normalizeSentenceRoleTypes(roleOptions, next);
}

// 角色配置改名或删除时只改目标成员，并保留句子已有的其他角色；替换重复会自然去重。
export function replaceSentenceRoleType(
  roleOptions: readonly string[],
  currentRoles: readonly string[],
  from: string,
  to: string | null,
) {
  return normalizeSentenceRoleTypes(
    roleOptions,
    currentRoles.flatMap((role) => role !== from ? [role] : to ? [to] : []),
  );
}

export function mergeSentenceRoleTypes(
  roleOptions: readonly string[],
  roleGroups: readonly (readonly string[])[],
) {
  return normalizeSentenceRoleTypes(roleOptions, roleGroups.flat());
}
