// A journal that cannot be read back is an internal failure (exit 4), never a replay and never silently repaired.
export class JournalCorruptError extends Error {
  constructor(path, reason) {
    super(`journal is unreadable at ${path}: ${reason}`);
    this.name = 'JournalCorruptError';
    this.path = path;
    this.reason = reason;
  }
}
