import {
  RESOURCE_CAPABILITIES,
  type EffectiveResourcePermission,
  type ResourceCapability,
} from "@xiqu/shared";

export type PermissionGrant = {
  resourceId: string;
  resourceName: string;
  capabilities: ResourceCapability[];
  inheritToChildren: boolean;
  expiresAt?: string | null;
};

export function isPermissionGrantActive(
  grant: Pick<PermissionGrant, "expiresAt">,
  now = Date.now(),
) {
  if (!grant.expiresAt) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function normalizeCapabilities(
  capabilities: readonly ResourceCapability[],
) {
  const selected = new Set(capabilities);
  return RESOURCE_CAPABILITIES.filter((capability) =>
    selected.has(capability));
}

// 权限只做并集合并，没有显式 deny；断开继承由调用者决定是否传入祖先授权。
export function resolveResourcePermission(input: {
  isAdmin?: boolean;
  isOwner?: boolean;
  directGrant?: PermissionGrant | null;
  inheritedGrants?: PermissionGrant[];
  now?: number;
}): EffectiveResourcePermission {
  if (input.isAdmin || input.isOwner) {
    return {
      source: input.isAdmin ? "admin" : "owner",
      capabilities: [...RESOURCE_CAPABILITIES],
      inheritedFrom: [],
      isOwner: Boolean(input.isOwner),
      canManagePermissions: true,
    };
  }
  const now = input.now ?? Date.now();
  const direct = input.directGrant &&
    isPermissionGrantActive(input.directGrant, now)
    ? input.directGrant
    : null;
  const inherited = (input.inheritedGrants ?? []).filter((grant) =>
    grant.inheritToChildren && isPermissionGrantActive(grant, now));
  const capabilities = normalizeCapabilities([
    ...(direct?.capabilities ?? []),
    ...inherited.flatMap((grant) => grant.capabilities),
  ]);
  return {
    source: direct ? "direct" : inherited.length ? "inherited" : "none",
    capabilities,
    inheritedFrom: inherited.map((grant) => ({
      resourceId: grant.resourceId,
      resourceName: grant.resourceName,
      capabilities: normalizeCapabilities(grant.capabilities),
    })),
    isOwner: false,
    canManagePermissions: capabilities.includes("manage_permissions"),
  };
}

export function canGrantCapabilities(
  actor: EffectiveResourcePermission,
  requested: readonly ResourceCapability[],
  isGlobalAdmin = false,
) {
  return isGlobalAdmin || requested.every((capability) =>
    actor.capabilities.includes(capability));
}
