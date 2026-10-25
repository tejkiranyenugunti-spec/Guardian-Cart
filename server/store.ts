// Lightweight persistence: one JSON file per household, written atomically (temp file + rename).
// The simplest reliable store for a single family; no secrets are ever written here.
import fs from "node:fs";
import path from "node:path";

export interface StateStore<T> {
  load(): T | undefined;
  save(data: T): void;
  flush(): void;
  clear(): void;
}

export class JsonFileStore<T> implements StateStore<T> {
  private pending?: T;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    public readonly file: string,
    private debounceMs = 60,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load(): T | undefined {
    try {
      if (!fs.existsSync(this.file)) return undefined;
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch (e) {
      // A corrupt file must never stop the app: keep a copy for inspection and start clean.
      console.warn(`[store] could not read ${this.file}: ${(e as Error).message}`);
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return undefined;
    }
  }

  save(data: T) {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending === undefined) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.pending));
    fs.renameSync(tmp, this.file);
    this.pending = undefined;
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    if (fs.existsSync(this.file)) fs.rmSync(this.file);
  }
}

/** In-memory store for tests or ephemeral households. */
export class MemoryStore<T> implements StateStore<T> {
  data?: T;
  load() {
    return this.data ? (JSON.parse(JSON.stringify(this.data)) as T) : undefined;
  }
  save(d: T) {
    this.data = JSON.parse(JSON.stringify(d));
  }
  flush() {}
  clear() {
    this.data = undefined;
  }
}
