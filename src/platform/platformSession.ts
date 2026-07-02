import { PlatformClient } from "../api/platformClient";

export type PlatformSessionState = {
  accessToken: string | null;
  userId: string | null;
  accountName: string | null;
  displayName: string | null;
};

export const emptyPlatformSession: PlatformSessionState = {
  accessToken: null,
  userId: null,
  accountName: null,
  displayName: null,
};

export function createPlatformClient(session: PlatformSessionState) {
  return new PlatformClient({
    accessToken: session.accessToken,
  });
}
