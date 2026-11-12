export const APP_NAME = 'notes-app'

/** Returns the human-readable name and version reported by the server. */
export function appInfo(version = '0.0.0'): { name: string; version: string } {
  return { name: APP_NAME, version }
}
