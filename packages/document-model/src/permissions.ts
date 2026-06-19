import type {
  PermissionAction,
  PermissionGrant,
  PermissionScope,
  TimeRangeScope,
} from "../../shared/src/index.js";

export type PermissionCheckInput = {
  userId: string;
  action: PermissionAction;
  scope: PermissionScope;
  grants: PermissionGrant[];
};

export function canPerformAction({
  userId,
  action,
  scope,
  grants,
}: PermissionCheckInput) {
  return grants.some((grant) =>
    grant.userId === userId &&
    grant.actions.includes(action) &&
    isGrantActive(grant) &&
    doesScopeContain(grant.scope, scope)
  );
}

function isGrantActive(grant: PermissionGrant) {
  return !grant.expiresAt || Date.parse(grant.expiresAt) > Date.now();
}

function doesScopeContain(grantScope: PermissionScope, requestedScope: PermissionScope) {
  return matchesOptionalId(grantScope.projectId, requestedScope.projectId) &&
    matchesOptionalId(grantScope.documentId, requestedScope.documentId) &&
    containsTimeRange(grantScope.timeRange, requestedScope.timeRange) &&
    containsTrackScope(grantScope.trackScope?.trackIds, requestedScope.trackScope?.trackIds);
}

function matchesOptionalId(grantId: string | undefined, requestedId: string | undefined) {
  return !grantId || !requestedId || grantId === requestedId;
}

function containsTimeRange(
  grantRange: TimeRangeScope | undefined,
  requestedRange: TimeRangeScope | undefined,
) {
  if (!grantRange || !requestedRange) {
    return true;
  }
  return grantRange.startTime <= requestedRange.startTime &&
    grantRange.endTime >= requestedRange.endTime;
}

function containsTrackScope(grantTrackIds: string[] | undefined, requestedTrackIds: string[] | undefined) {
  if (!grantTrackIds?.length || !requestedTrackIds?.length) {
    return true;
  }
  const grantTrackIdSet = new Set(grantTrackIds);
  return requestedTrackIds.every((trackId) => grantTrackIdSet.has(trackId));
}
