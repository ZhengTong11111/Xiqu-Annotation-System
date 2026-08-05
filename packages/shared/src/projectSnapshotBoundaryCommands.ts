export const PROJECT_SNAPSHOT_BOUNDARY_COMMAND = "annotation.project.snapshot.boundary" as const;

export const PROJECT_SNAPSHOT_BOUNDARY_KINDS = [
  "import_srt",
  "import_project",
  "merge_project",
  "repair_sentence_character_track",
  "import_gongche",
  "generate_banyan",
  "builtin_track_lifecycle_overflow",
] as const;

export type ProjectSnapshotBoundaryKind = typeof PROJECT_SNAPSHOT_BOUNDARY_KINDS[number];
export type ProjectSnapshotBoundaryDirection = "forward" | "inverse";

export type ProjectSnapshotBoundaryCommand = {
  type: typeof PROJECT_SNAPSHOT_BOUNDARY_COMMAND;
  boundaryId: string;
  kind: ProjectSnapshotBoundaryKind;
  direction: ProjectSnapshotBoundaryDirection;
};

export type ProjectSnapshotBoundaryCommandEnvelope = {
  version: 1;
  command: ProjectSnapshotBoundaryCommand;
};

const KIND_SET = new Set<string>(PROJECT_SNAPSHOT_BOUNDARY_KINDS);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// 快照边界只记录受控意图，不保存完整 ProjectData；权威内容仍由同 revision save 写入。
export function buildProjectSnapshotBoundaryEnvelope(
  boundaryId: string,
  kind: ProjectSnapshotBoundaryKind,
  direction: ProjectSnapshotBoundaryDirection = "forward",
): ProjectSnapshotBoundaryCommandEnvelope | null {
  return parseProjectSnapshotBoundaryEnvelope({
    version: 1,
    command: { type: PROJECT_SNAPSHOT_BOUNDARY_COMMAND, boundaryId, kind, direction },
  });
}

export function parseProjectSnapshotBoundaryEnvelope(
  value: unknown,
): ProjectSnapshotBoundaryCommandEnvelope | null {
  if (!isExactRecord(value, ["version", "command"]) || value.version !== 1 ||
    !isExactRecord(value.command, ["type", "boundaryId", "kind", "direction"]) ||
    value.command.type !== PROJECT_SNAPSHOT_BOUNDARY_COMMAND ||
    typeof value.command.boundaryId !== "string" || !SAFE_ID_PATTERN.test(value.command.boundaryId) ||
    typeof value.command.kind !== "string" || !KIND_SET.has(value.command.kind) ||
    (value.command.direction !== "forward" && value.command.direction !== "inverse")) return null;
  return {
    version: 1,
    command: {
      type: PROJECT_SNAPSHOT_BOUNDARY_COMMAND,
      boundaryId: value.command.boundaryId,
      kind: value.command.kind as ProjectSnapshotBoundaryKind,
      direction: value.command.direction,
    },
  };
}

// 本地历史仍保存完整 before snapshot；inverse 只翻转边界方向，让 undo/redo 继续经过同一租约门禁。
export function invertProjectSnapshotBoundaryEnvelope(
  value: unknown,
): ProjectSnapshotBoundaryCommandEnvelope | null {
  const envelope = parseProjectSnapshotBoundaryEnvelope(value);
  return envelope
    ? buildProjectSnapshotBoundaryEnvelope(
        envelope.command.boundaryId,
        envelope.command.kind,
        envelope.command.direction === "forward" ? "inverse" : "forward",
      )
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
