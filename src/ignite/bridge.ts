import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IgniteClient } from "./client.js";
import { pageContentHash, type PageRenderer, type RenderJob } from "./renderer.js";
import type { IgniteNotebook, IgnitePage, IgniteSnapshotResponse, PageTranscription } from "./types.js";
import type { MirrorNotebook, MirrorResult, VaultMirror } from "./vault-mirror.js";
import { imageVaultPath } from "./vault-mirror.js";

export interface IgniteBridgeOptions {
  client: IgniteClient;
  renderer: PageRenderer;
  mirror: VaultMirror;
  stateDir: string;
  libraryId?: string | undefined;
  pollMs?: number;
  ocrLanguages?: string[];
  pngWidth?: number;
  ocrWidth?: number;
  batchSize?: number;
  /** Ink the Mac wrote (from the writer's log): drawn in page images, not transcribed. */
  printedStrokes?: (() => Promise<Set<string>>) | undefined;
  /** Notebook id → vault note it was sent from (writer's log). */
  sourceNotes?: (() => Promise<Map<string, string>>) | undefined;
}

export interface IgniteBridgeStatus {
  enabled: true;
  state: "starting" | "idle" | "waiting-for-quiet" | "syncing" | "error";
  serverReachable: boolean;
  libraryId: string | null;
  headSeq: number | null;
  exportedSeq: number | null;
  notebooks: number;
  pages: number;
  vaultFolder: string;
  lastCheckAt: string | null;
  lastSyncAt: string | null;
  lastChange: Pick<MirrorResult, "written" | "renamed" | "deleted"> | null;
  conflicts: MirrorResult["conflicts"];
  failedPages: number;
  lastError: string | null;
}

interface PersistedState {
  v: 1;
  libraryId: string | null;
  exportedSeq: number | null;
  /** page content hash → recognised handwriting */
  transcriptions: Record<string, PageTranscription>;
}

export interface IgnitePageView {
  notebookId: string;
  notebookTitle: string;
  notebookIndex: number;
  number: number;
  pageCount: number;
  pageId: string;
  strokeCount: number;
  typedText: string[];
  transcription: string | null;
  notePath: string | null;
  imagePath: string | null;
}

/**
 * Keeps the vault mirror of the Kindle library current. Polls the Ignite server's head sequence
 * (cheap), waits until it is quiet for one interval (you stopped writing), then renders and
 * transcribes only pages whose content changed and updates the vault notes.
 */
export class IgniteBridge {
  readonly #pollMs: number;
  readonly #languages: string[];
  readonly #pngWidth: number;
  readonly #ocrWidth: number;
  readonly #batch: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #pendingSeq: number | null = null;
  #snapshot: IgniteSnapshotResponse | undefined;
  #state: PersistedState = { v: 1, libraryId: null, exportedSeq: null, transcriptions: {} };
  #failed = new Set<string>();
  #status: IgniteBridgeStatus;

  constructor(private readonly options: IgniteBridgeOptions) {
    this.#pollMs = options.pollMs ?? 30_000;
    this.#languages = options.ocrLanguages ?? ["en-US"];
    this.#pngWidth = options.pngWidth ?? 1240;
    this.#ocrWidth = options.ocrWidth ?? 1860;
    this.#batch = options.batchSize ?? 6;
    this.#status = {
      enabled: true, state: "starting", serverReachable: false, libraryId: null, headSeq: null, exportedSeq: null,
      notebooks: 0, pages: 0, vaultFolder: options.mirror.folder, lastCheckAt: null, lastSyncAt: null, lastChange: null,
      conflicts: [], failedPages: 0, lastError: null
    };
  }

  status(): IgniteBridgeStatus { return { ...this.#status }; }

  async start(): Promise<void> {
    await this.#loadState();
    void this.sync({ force: true });
    this.#timer = setInterval(() => void this.sync(), this.#pollMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** One poll. `force` skips the quiet-period wait and re-applies the vault mirror. */
  sync(input: { force?: boolean } = {}): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#sync(input.force ?? false).finally(() => { this.#running = undefined; });
    return this.#running;
  }

  notebooks(): { notebooks: { index: number; notebookId: string; title: string; folder: string | null; pageCount: number; notePath: string | null; pages: { number: number; pageId: string; strokeCount: number; hasTypedText: boolean; preview: string | null }[] }[]; throughSeq: number | null } {
    const snapshot = this.#snapshot;
    if (!snapshot) return { notebooks: [], throughSeq: null };
    return {
      throughSeq: snapshot.through_server_seq,
      notebooks: snapshot.snapshot.notebooks.map((notebook, index) => ({
        index,
        notebookId: notebook.notebook_id,
        title: notebook.title,
        folder: this.#folderTitle(notebook) ?? null,
        pageCount: notebook.pages.length,
        notePath: this.#notePaths.get(notebook.notebook_id) ?? null,
        pages: notebook.pages.map((page, pageIndex) => {
          const text = this.#state.transcriptions[pageContentHash(page)]?.text ?? null;
          return { number: pageIndex + 1, pageId: page.page_id, strokeCount: page.strokes.length, hasTypedText: (page.texts?.length ?? 0) > 0, preview: text ? text.replace(/\s+/g, " ").slice(0, 160) : null };
        })
      }))
    };
  }

  /** Resolve a page by page id, or by notebook (id, exact title, or 0-based index) + 1-based page number. */
  page(selector: { pageId?: string; notebook?: string; number?: number }): IgnitePageView | null {
    const notebooks = this.#snapshot?.snapshot.notebooks ?? [];
    let found: { notebook: IgniteNotebook; notebookIndex: number; page: IgnitePage; index: number } | undefined;
    if (selector.pageId) {
      notebooks.some((notebook, notebookIndex) => notebook.pages.some((page, index) => {
        if (page.page_id !== selector.pageId) return false;
        found = { notebook, notebookIndex, page, index };
        return true;
      }));
    } else if (selector.notebook !== undefined) {
      const notebookIndex = resolveNotebook(notebooks, selector.notebook);
      const notebook = notebookIndex === undefined ? undefined : notebooks[notebookIndex];
      const index = (selector.number ?? 1) - 1;
      const page = notebook?.pages[index];
      if (notebook && page && notebookIndex !== undefined) found = { notebook, notebookIndex, page, index };
    }
    if (!found) return null;
    const hash = pageContentHash(found.page);
    return {
      notebookId: found.notebook.notebook_id,
      notebookTitle: found.notebook.title,
      notebookIndex: found.notebookIndex,
      number: found.index + 1,
      pageCount: found.notebook.pages.length,
      pageId: found.page.page_id,
      strokeCount: found.page.strokes.length,
      typedText: (found.page.texts ?? []).map((text) => text.content),
      transcription: this.#state.transcriptions[hash]?.text ?? null,
      notePath: this.#notePaths.get(found.notebook.notebook_id) ?? null,
      imagePath: this.#pngPath(hash)
    };
  }

  #notePaths = new Map<string, string>();

  /** Resolve a notebook (id, exact or unique partial title, or index) in the last synced snapshot. */
  findNotebook(selector: string): { notebookId: string; title: string; pageCount: number } | undefined {
    const notebooks = this.#snapshot?.snapshot.notebooks ?? [];
    const index = resolveNotebook(notebooks, selector);
    const notebook = index === undefined ? undefined : notebooks[index];
    return notebook ? { notebookId: notebook.notebook_id, title: notebook.title, pageCount: notebook.pages.length } : undefined;
  }

  async #sync(force: boolean): Promise<void> {
    const now = new Date();
    this.#status.lastCheckAt = now.toISOString();
    try {
      const libraries = await this.options.client.libraries();
      this.#status.serverReachable = true;
      const library = this.options.libraryId ? libraries.find((item) => item.library_id === this.options.libraryId) : libraries.length === 1 ? libraries[0] : undefined;
      if (!library) throw new Error(libraries.length === 0 ? "Ignite server has no library yet" : "Ignite server has several libraries; set COMPANION_IGNITE_LIBRARY_ID");
      this.#status.libraryId = library.library_id;
      this.#status.headSeq = library.head_server_seq;
      this.#status.notebooks = library.notebook_count;
      this.#status.pages = library.page_count;
      const changed = library.head_server_seq !== this.#state.exportedSeq || library.library_id !== this.#state.libraryId;
      if (!changed && !force && this.#failed.size === 0) {
        this.#status.state = "idle";
        this.#status.lastError = null;
        return;
      }
      if (changed && !force && this.#pendingSeq !== library.head_server_seq) {
        // Writing in progress: let the sequence settle for one interval before rendering.
        this.#pendingSeq = library.head_server_seq;
        this.#status.state = "waiting-for-quiet";
        return;
      }
      this.#status.state = "syncing";
      const snapshot = await this.options.client.snapshot(library.library_id);
      await this.#export(snapshot, now);
      this.#snapshot = snapshot;
      this.#pendingSeq = null;
      this.#state.libraryId = snapshot.library_id;
      this.#state.exportedSeq = snapshot.through_server_seq;
      await this.#saveState(snapshot);
      this.#status.exportedSeq = snapshot.through_server_seq;
      this.#status.lastSyncAt = new Date().toISOString();
      this.#status.state = "idle";
      this.#status.lastError = null;
    } catch (error) {
      this.#status.state = "error";
      this.#status.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
      if (/fetch failed|ECONNREFUSED|abort|timeout/i.test(this.#status.lastError)) this.#status.serverReachable = false;
      console.error(JSON.stringify({ event: "ignite_bridge_error", error: this.#status.lastError }));
    }
  }

  async #export(response: IgniteSnapshotResponse, now: Date): Promise<void> {
    const snapshot = response.snapshot;
    const pages = snapshot.notebooks.flatMap((notebook) => notebook.pages);
    const jobs: { hash: string; job: RenderJob }[] = [];
    const queued = new Set<string>();
    const printed = (await this.options.printedStrokes?.()) ?? new Set<string>();
    const sourceNotes = (await this.options.sourceNotes?.()) ?? new Map<string, string>();
    const handwriting = (page: IgnitePage) => page.strokes.filter((stroke) => !printed.has(stroke.stroke_id)).length;
    for (const page of pages) {
      const hash = pageContentHash(page);
      if (queued.has(hash)) continue;
      const needsPng = !(await exists(this.#pngPath(hash)));
      const needsOcr = handwriting(page) > 0 && !this.#state.transcriptions[hash];
      if (!needsPng && !needsOcr) continue;
      queued.add(hash);
      const backgroundPath = needsPng && page.background.kind === "blob" ? await this.#blob(page.background.sha256) : undefined;
      jobs.push({ hash, job: {
        page, pageSpace: snapshot.page_space, backgroundPath,
        png: needsPng ? { path: this.#pngPath(hash), width: this.#pngWidth } : undefined,
        ocr: needsOcr ? { width: this.#ocrWidth, languages: this.#languages } : undefined,
        printed
      } });
    }
    this.#failed.clear();
    await mkdir(path.join(this.options.stateDir, "pages"), { recursive: true });
    for (let offset = 0; offset < jobs.length; offset += this.#batch) {
      const batch = jobs.slice(offset, offset + this.#batch);
      const results = await this.options.renderer.render(batch.map((item) => item.job));
      results.forEach((result, index) => {
        const { hash } = batch[index]!;
        if (!result.ok) {
          this.#failed.add(hash);
          console.error(JSON.stringify({ event: "ignite_page_render_failed", page: hash.slice(0, 12), error: result.error }));
          return;
        }
        if (result.ocr) this.#state.transcriptions[hash] = result.ocr;
      });
    }
    this.#status.failedPages = this.#failed.size;

    const mirrorNotebooks: MirrorNotebook[] = [];
    for (const notebook of snapshot.notebooks) {
      const mirrorPages = [];
      for (const [index, page] of notebook.pages.entries()) {
        const hash = pageContentHash(page);
        const pngPath = this.#pngPath(hash);
        const hasPng = await exists(pngPath);
        mirrorPages.push({
          number: index + 1,
          pageId: page.page_id,
          contentHash: hash,
          strokeCount: handwriting(page),
          image: hasPng ? { vaultPath: imageVaultPath(this.options.mirror.folder, notebook.notebook_id, { number: index + 1, contentHash: hash }), sourcePath: pngPath } : undefined,
          transcription: handwriting(page) === 0 ? "" : this.#state.transcriptions[hash]?.text,
          typedText: (page.texts ?? []).map((text) => text.content)
        });
      }
      mirrorNotebooks.push({ notebookId: notebook.notebook_id, title: notebook.title, folderTitle: this.#folderTitle(notebook, snapshot), sourceNote: sourceNotes.get(notebook.notebook_id), pages: mirrorPages });
    }
    const result = await this.options.mirror.apply(mirrorNotebooks, now);
    for (const notebook of snapshot.notebooks) {
      const notePath = await this.options.mirror.notePath(notebook.notebook_id);
      if (notePath) this.#notePaths.set(notebook.notebook_id, notePath);
    }
    this.#status.conflicts = result.conflicts;
    if (result.written.length || result.renamed.length || result.deleted.length) {
      this.#status.lastChange = { written: result.written, renamed: result.renamed, deleted: result.deleted };
      console.log(JSON.stringify({ event: "ignite_vault_updated", seq: response.through_server_seq, written: result.written.length, renamed: result.renamed.length, deleted: result.deleted.length, rendered: jobs.length }));
    }
  }

  #folderTitle(notebook: IgniteNotebook, snapshot = this.#snapshot?.snapshot): string | undefined {
    if (!notebook.folder_id) return undefined;
    return snapshot?.folders?.find((folder) => folder.folder_id === notebook.folder_id)?.title;
  }

  #pngPath(hash: string): string {
    return path.join(this.options.stateDir, "pages", `${hash}.png`);
  }

  async #blob(sha256: string): Promise<string> {
    const filename = path.join(this.options.stateDir, "blobs", `${sha256}.gray8`);
    if (await exists(filename)) return filename;
    const bytes = await this.options.client.blob(sha256);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`background blob ${sha256.slice(0, 12)} failed its hash check`);
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, filename);
    return filename;
  }

  async #loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.options.stateDir, "state.json"), "utf8")) as PersistedState;
      if (parsed.v === 1) this.#state = { ...parsed, transcriptions: parsed.transcriptions ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(JSON.stringify({ event: "ignite_state_unreadable", error: String(error) }));
    }
    this.#status.exportedSeq = this.#state.exportedSeq;
  }

  async #saveState(snapshot: IgniteSnapshotResponse): Promise<void> {
    // Keep transcriptions only for page versions that still exist.
    const live = new Set(snapshot.snapshot.notebooks.flatMap((notebook) => notebook.pages.map(pageContentHash)));
    this.#state.transcriptions = Object.fromEntries(Object.entries(this.#state.transcriptions).filter(([hash]) => live.has(hash)));
    await mkdir(this.options.stateDir, { recursive: true });
    const filename = path.join(this.options.stateDir, "state.json");
    await writeFile(`${filename}.tmp`, JSON.stringify(this.#state));
    await rename(`${filename}.tmp`, filename);
  }
}

export function resolveNotebook(notebooks: IgniteNotebook[], selector: string): number | undefined {
  const trimmed = selector.trim();
  const byId = notebooks.findIndex((notebook) => notebook.notebook_id === trimmed);
  if (byId >= 0) return byId;
  const byTitle = notebooks.findIndex((notebook) => notebook.title.toLowerCase() === trimmed.toLowerCase());
  if (byTitle >= 0) return byTitle;
  if (/^\d+$/.test(trimmed) && Number(trimmed) < notebooks.length) return Number(trimmed);
  const partial = notebooks.map((notebook, index) => ({ notebook, index })).filter(({ notebook }) => notebook.title.toLowerCase().includes(trimmed.toLowerCase()));
  return partial.length === 1 ? partial[0]!.index : undefined;
}

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true; } catch { return false; }
}
