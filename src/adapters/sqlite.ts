// Shared helper for adapters that read someone else's SQLite database.
// Strategy: open read-only; if the engine refuses (live WAL db, unsupported
// option), fall back to copying the file (+ wal/shm) into a temp dir and
// opening the copy. With `copy: true` the copy is always used. We never
// write to the original file, never hold locks.

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface ReadonlyDb {
  db: DatabaseSync;
  cleanup: () => void;
  note: string | null;
}

function openCopy(dbPath: string): ReadonlyDb {
  const dir = mkdtempSync(join(tmpdir(), "fleetdeck-db-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const copy = join(dir, basename(dbPath));
    copyFileSync(dbPath, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ext)) {
        try {
          copyFileSync(dbPath + ext, copy + ext);
        } catch {
          // best effort
        }
      }
    }
    return { db: new DatabaseSync(copy), cleanup, note: null };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export function openSqliteReadonly(dbPath: string, opts: { copy?: boolean } = {}): ReadonlyDb {
  if (opts.copy) return openCopy(dbPath);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return { db, cleanup: () => {}, note: null };
  } catch (err) {
    // Fallback: work on a scratch copy so the live file stays untouched.
    const copied = openCopy(dbPath);
    return {
      ...copied,
      note: `read-only open failed (${String(err)}); queried a temporary copy`,
    };
  }
}
