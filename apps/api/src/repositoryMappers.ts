import type { PlatformUser, StoredFileObject } from "@xiqu/shared";

export function toPublicUser(user: {
  id: string;
  accountName: string;
  displayName: string;
  roles: Array<{ role: string }>;
}): PlatformUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: user.roles.map((entry) => entry.role) as PlatformUser["roles"],
  };
}

export function toFile(file: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum: string | null;
  createdAt: Date;
}): StoredFileObject {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    storageKey: file.storageKey,
    checksum: file.checksum,
    createdAt: file.createdAt.toISOString(),
  };
}
