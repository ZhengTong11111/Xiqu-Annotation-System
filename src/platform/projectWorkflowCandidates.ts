import type { ProjectWorkflowGroups, UserReference } from "@xiqu/shared";

/** 合并搜索批次并保留已见账号，防止未保存勾选因下一次请求替换数组而丢失。 */
export function mergeProjectWorkflowCandidateBatches(
  current: readonly UserReference[],
  incoming: readonly UserReference[],
): UserReference[] {
  const byId = new Map(current.map((account) => [account.id, account]));
  incoming.forEach((account) => byId.set(account.id, account));
  return [...byId.values()];
}

/** 既有成员只在匹配当前关键词时出现；清空搜索后仍可看见并移出所有成员。 */
export function filterProjectWorkflowCandidates(input: {
  groups: ProjectWorkflowGroups | null;
  knownAccounts: readonly UserReference[];
  query: string;
}): UserReference[] {
  const byId = new Map<string, UserReference>();
  for (const account of [
    ...(input.groups?.annotation ?? []),
    ...(input.groups?.review ?? []),
    ...input.knownAccounts,
  ]) byId.set(account.id, account);
  const query = input.query.trim().toLocaleLowerCase("zh-CN");
  return [...byId.values()]
    .filter((account) =>
      !query ||
      account.displayName.toLocaleLowerCase("zh-CN").includes(query) ||
      account.accountName.toLocaleLowerCase("zh-CN").includes(query))
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-CN") ||
      left.accountName.localeCompare(right.accountName));
}
