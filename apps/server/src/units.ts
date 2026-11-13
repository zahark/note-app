// Time and size units, so every duration and byte limit in the server is spelled the same way.
// `_MS` values are milliseconds (rate-limit windows, timers), `_SEC` values are seconds (database
// timestamps, cookie lifetimes).

export const SECOND_MS = 1000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS

export const HOUR_SEC = 60 * 60
export const DAY_SEC = 24 * HOUR_SEC
export const DAY_MS = DAY_SEC * SECOND_MS

/** One kibibyte. */
export const KIB = 1024

/** One mebibyte. */
export const MIB = 1024 * 1024
