/**
 * Usage mode: `edit` keeps every authoring tool; `read` is the viewer a learner uses
 * when opening someone else's project — browsing, notes and annotations stay visible,
 * but nothing may be written back to the project data.
 */
export type AppMode = 'edit' | 'read';

const MODE_KEY = 'manga-memo.app-mode';

function readStoredMode(): AppMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'read' ? 'read' : 'edit';
  } catch {
    return 'edit';
  }
}

let currentMode: AppMode = readStoredMode();

export function getAppMode(): AppMode {
  return currentMode;
}

export function isReadOnly(): boolean {
  return currentMode === 'read';
}

export function setAppMode(next: AppMode): void {
  currentMode = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* private mode: the choice just lasts for this session */
  }
}
