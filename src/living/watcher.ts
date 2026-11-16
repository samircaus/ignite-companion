import type { IgniteClient } from "../ignite/client.js";
import type { IgniteStroke } from "../ignite/types.js";
import { findMarks, type MarkStroke } from "./marks.js";
import type { AiTurn } from "./service.js";

/**
 * Pen trigger: tails the sync server's operation log (`operations?after=N`, under a millisecond
 * when nothing changed) every few seconds, keeps the strokes the user adds per page, and once a
 * page has been quiet for `quietMs` with something that looks like a circled (?) or (+) in its new
 * ink, hands the page to `check` (which re-reads the page at head, confirms the mark and answers).
 *
 * Ink from the AI's own replicas is ignored. Strokes stay "fresh" for `freshMs` or until a turn
 * consumed them. The cursor survives restarts; on the very first start it begins at the head
 * (old ink never fires).
 */

export interface WatcherDeps {
  client: IgniteClient;
  libraryId: () => Promise<string>;
  /** Replica ids whose ink is never a command (the AI's own writers). */
  ownReplicas: () => Promise<Set<string>>;
  cursor: () => Promise<number | null>;
  setCursor: (seq: number) => Promise<void>;
  consumed: () => Promise<Set<string>>;
  check: (pageId: string, fresh: MarkStroke[]) => Promise<AiTurn[]>;
  intervalMs?: number;
  quietMs?: number;
  freshMs?: number;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

export interface WatcherStatus {
  running: boolean;
  cursor: number | null;
  lastPollAt: string | null;
  pages: { pageId: string; fresh: number; quietForMs: number }[];
  lastError: string | null;
  checks: number;
}

interface PageState { strokes: (MarkStroke & { at: number })[]; lastActivity: number; checkedAt: number }

export class LivingWatcher {
  readonly #pages = new Map<string, PageState>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #cursor: number | null = null;
  #lastPoll: number | null = null;
  #lastError: string | null = null;
  #checks = 0;

  constructor(private readonly deps: WatcherDeps) {}

  get #now(): number { return (this.deps.now ?? Date.now)(); }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 3000);
    this.#timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  status(): WatcherStatus {
    const now = this.#now;
    return {
      running: Boolean(this.#timer),
      cursor: this.#cursor,
      lastPollAt: this.#lastPoll ? new Date(this.#lastPoll).toISOString() : null,
      pages: [...this.#pages].map(([pageId, p]) => ({ pageId, fresh: p.strokes.length, quietForMs: now - p.lastActivity })),
      lastError: this.#lastError,
      checks: this.#checks
    };
  }

  /** One poll (and any due checks). Never runs twice at once. */
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#tick().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #tick(): Promise<void> {
    try {
      await this.#poll();
      await this.#checkDue();
      this.#lastError = null;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
      this.deps.log?.({ event: "living_watcher_error", error: this.#lastError });
    }
  }

  async #poll(): Promise<void> {
    const library = await this.deps.libraryId();
    if (this.#cursor === null) {
      const saved = await this.deps.cursor();
      this.#cursor = saved ?? (await this.deps.client.operations(library, Number.MAX_SAFE_INTEGER - 1, 1)).head_server_seq;
      if (saved === null) await this.deps.setCursor(this.#cursor);
    }
    const ours = await this.deps.ownReplicas();
    const now = this.#now;
    for (let rounds = 0; rounds < 20; rounds += 1) {
      const batch = await this.deps.client.operations(library, this.#cursor, 500);
      this.#lastPoll = now;
      for (const op of batch.operations) {
        const o = op.envelope.operation;
        const pageId = typeof o.page_id === "string" ? o.page_id : null;
        if (!pageId) continue;
        if (o.type === "add_stroke") {
          if (ours.has(op.envelope.replica_id)) continue;
          const stroke = (o as { stroke: IgniteStroke }).stroke;
          const page = this.#page(pageId, now);
          page.strokes.push({ id: stroke.stroke_id, points: stroke.points.map((p) => [p.x, p.y] as const), at: now });
          page.lastActivity = now;
        } else if (o.type === "erase_region" && !ours.has(op.envelope.replica_id) && this.#pages.has(pageId)) {
          // Erasing near fresh ink may cancel a mark; the check re-reads the page at head anyway.
          this.#page(pageId, now).lastActivity = now;
        }
      }
      const next = Math.max(this.#cursor, batch.next_after, ...batch.operations.map((op) => op.server_seq));
      if (next !== this.#cursor) {
        this.#cursor = next;
        await this.deps.setCursor(next);
      }
      if (batch.operations.length < 500) break;
    }
  }

  #page(pageId: string, now: number): PageState {
    let page = this.#pages.get(pageId);
    if (!page) {
      page = { strokes: [], lastActivity: now, checkedAt: -Infinity };
      this.#pages.set(pageId, page);
    }
    return page;
  }

  async #checkDue(): Promise<void> {
    const now = this.#now;
    const quiet = this.deps.quietMs ?? 5000;
    const freshFor = this.deps.freshMs ?? 20 * 60_000;
    const consumed = await this.deps.consumed();
    for (const [pageId, page] of this.#pages) {
      page.strokes = page.strokes.filter((s) => now - s.at <= freshFor && !consumed.has(s.id));
      if (!page.strokes.length) {
        this.#pages.delete(pageId);
        continue;
      }
      if (now - page.lastActivity < quiet || page.checkedAt >= page.lastActivity) continue;
      page.checkedAt = now;
      // Cheap pre-check on the fresh ink alone; the real check reads the page at head.
      if (!findMarks(page.strokes, page.strokes, consumed).length) continue;
      this.#checks += 1;
      const turns = await this.deps.check(pageId, page.strokes);
      if (turns.length) {
        const used = new Set(turns.flatMap((t) => t.markIds));
        // Ink up to the mark is "answered"; keep only strokes that are not part of it.
        page.strokes = page.strokes.filter((s) => !used.has(s.id));
      }
    }
  }
}
