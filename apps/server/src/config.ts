import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 3472;
export const DEFAULT_HOST = "127.0.0.1";

/** Data lives outside Syncthing: SQLite must never be synced file-by-file. */
export function defaultDataDir(): string {
  return process.env.POST_STUDIO_DATA || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "post-studio");
}

export const LIMITS = {
  imageBytes: 20 * 1024 * 1024,
  svgBytes: 2 * 1024 * 1024,
  /** JSON bodies (documents and op batches). */
  jsonBytes: 10 * 1024 * 1024,
  leaseDefaultSeconds: 15 * 60,
  leaseMaxSeconds: 2 * 60 * 60,
  snapshotEvery: 50,
} as const;
