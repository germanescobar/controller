import fs from "node:fs/promises";
import { lock } from "proper-lockfile";

/** Claim the shared Controller home before running schedules, wakes, or goals. */
export async function tryAcquireSharedLoopOwner(
  home: string,
  onCompromised: (error: Error) => void
): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(home, { recursive: true });
  try {
    return await lock(home, {
      stale: 30_000,
      update: 5_000,
      onCompromised,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
      return null;
    }
    throw error;
  }
}
