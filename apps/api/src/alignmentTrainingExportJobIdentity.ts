import { createHash } from "node:crypto";
import {
  ALIGNMENT_TRAINING_PACKAGE_AUDIO_PROFILE,
  ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
  ALIGNMENT_TRAINING_PACKAGE_FORMAT,
  ALIGNMENT_TRAINING_PACKAGE_VERSION,
  canonicalAlignmentTrainingJson,
} from "@xiqu/document-model";

export type AlignmentTrainingExportJobIdentity = {
  exportId: string;
  provenanceManifestChecksum: string;
  inputManifestChecksum: string;
};

/** 执行 identity 只绑定不可变 export 与包合同，不混入账号、显示名、对象路径或临时媒体地址。 */
export function createAlignmentTrainingExportJobDeduplicationKey(
  identity: AlignmentTrainingExportJobIdentity,
) {
  const digest = sha256(canonicalAlignmentTrainingJson({
    version: 1,
    type: "alignment_training_export",
    exportId: identity.exportId,
    provenanceManifestChecksum: identity.provenanceManifestChecksum,
    inputManifestChecksum: identity.inputManifestChecksum,
    package: {
      format: ALIGNMENT_TRAINING_PACKAGE_FORMAT,
      version: ALIGNMENT_TRAINING_PACKAGE_VERSION,
      container: ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
      audioProfile: ALIGNMENT_TRAINING_PACKAGE_AUDIO_PROFILE,
    },
  }));
  return `alignment-training-export:v1:${digest}`;
}

/** 浏览器动作指纹绑定当前 export 的完整执行 identity，防止同 UUID 被改绑。 */
export function createAlignmentTrainingExportRequestFingerprint(input: {
  exportId: string;
  deduplicationKey: string;
}) {
  return sha256(canonicalAlignmentTrainingJson({
    version: 1,
    type: "alignment_training_export_request",
    exportId: input.exportId,
    deduplicationKey: input.deduplicationKey,
  }));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
