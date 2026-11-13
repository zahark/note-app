// Restoring an off-site backup happens in two phases that share the layout below, all inside DATA_DIR (on
// Fly that is the volume, the only place that survives a restart):
//   1. `npm run restore:offsite -- <name>` (app still running) downloads and verifies a backup into
//      `restore-staging/`, writes `READY` last and renames the directory to `restore/`;
//   2. the next start swaps `restore/` into place before the database opens, keeping the previous data in
//      `restore-previous/` until the swap is complete.

/** A complete, verified stage waiting for the next start. */
export const RESTORE_DIR = 'restore'
/** Where the CLI assembles a stage; never read by the server (a leftover is removed by the next CLI run). */
export const RESTORE_STAGING_DIR = 'restore-staging'
/** The live data moved aside during a swap. */
export const RESTORE_PREVIOUS_DIR = 'restore-previous'
/** Written last into the stage: its presence means "every staged file is verified and on disk". */
export const RESTORE_READY_FILE = 'READY'

/** The JSON content of `READY`. */
export interface RestoreReady {
  /** Backup name (`notes-backup-YYYYMMDD-HHMMSS`). */
  name: string
  /** Size of the staged `notes.db`, checked again before a swap starts. */
  notesDbSize: number
  /** Number of files staged in `uploads/`. */
  uploadsCount: number
}
