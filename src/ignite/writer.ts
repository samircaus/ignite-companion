import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PageRenderer, RenderJob } from "./renderer.js";
import type { IgnitePage } from "./types.js";

/**
 * Writes to the Kindle, always in two steps:
 *
 * 1. `plan()` runs `ignite-import` as a dry run (nothing is sent), renders every page it would
 *    create with the same renderer the vault mirror uses, and returns a plan id plus previews.
 * 2. `apply(planId)` takes a verified ledger backup, then runs the identical command with
 *    `--confirm-write`. A failed backup means nothing is sent.
 *
 * What gets written is exactly what was previewed: a note is copied into the plan at plan time,
 * so later edits to it need a new plan. Plans expire after 30 minutes and apply once.
 * `ignite-import` itself refuses ink or text in Ignite's reserved chrome bands, only ever adds a
 * new notebook, and deletes only through ordinary `DeleteNotebook`/`DeletePage` operations
 * (the Kindle quarantines, never erases).
 *
 * Folders: a new notebook can be filed in a notebook folder (`folder` on a note, or
 * `notebook.folder` in a page spec), and `move-notebook` files existing notebooks in a folder
 * (or back at the top level) with Ignite's own `SetNotebookFolder`; nothing else about them
 * changes. A folder is matched by title, ignoring case; **a folder that does not exist yet is
 * created** by the write (Ignite's `CreateFolder`, as "New folder" on the Kindle does), and the
 * plan summary says so before anything is sent.
 */

export type Paper = "blank" | "lined" | "dot" | "grid";

export type WriteRequest =
  | { kind: "note"; notePath: string; title?: string | undefined; paper?: Paper | undefined; extraPages?: number | undefined; folder?: string | undefined }
  | { kind: "notebook"; spec: unknown }
  /** `folder: null` moves the notebooks back to the top level. */
  | { kind: "move-notebook"; notebooks: string[]; folder: string | null }
  | { kind: "delete-notebook"; notebook: string }
  | { kind: "delete-page"; notebook: string; page: number };

export interface ImportReport {
  ok: boolean;
  error?: string;
  command?: string;
  written?: boolean;
  library?: string | null;
  notebook?: { id?: string; title?: string };
  pages?: number;
  strokes?: number;
  texts?: number;
  envelopes?: number;
  blobs?: number;
  blobBytes?: number;
  warnings?: string[];
  description?: string;
  headServerSeq?: number;
  strokeIds?: string[];
  folder?: ImportFolder | null;
  notebooks?: { id: string; title: string; from: string | null }[];
  unchanged?: { id: string; title: string; from: string | null }[];
}

/** The folder a plan files notebooks in; `created`: this write creates it. */
export interface ImportFolder { id: string | null; title: string; created: boolean }

export interface WritePlan {
  planId: string;
  kind: WriteRequest["kind"];
  createdAt: string;
  expiresAt: string;
  title: string;
  /** One line a person can approve or reject. */
  summary: string;
  pages: number;
  warnings: string[];
  previews: { page: number; path: string }[];
  sourceNote: string | null;
  appliedAt: string | null;
  /** Where the notebook(s) go: a folder, or `null` for the top level. Not set for deletes. */
  folder?: { title: string; created: boolean } | null;
  /** Move plans: the notebooks that change folder, and where each is now (`from`, `null` = top level). */
  notebooks?: { notebookId: string; title: string; from: string | null }[];
}

export interface WriteResult {
  planId: string;
  kind: WriteRequest["kind"];
  notebookId: string | null;
  title: string;
  summary: string;
  backup: string;
  headServerSeq: number | null;
  note: string;
}

export interface WriteRecord {
  at: string;
  planId: string;
  kind: WriteRequest["kind"];
  notebookId: string | null;
  title: string;
  sourceNote: string | null;
  backup: string;
  headServerSeq: number | null;
  strokeIds: string[];
  /** Folder the write filed notebooks in (`null` = top level); absent for deletes and older records. */
  folder?: string | null;
  /** Move plans: every notebook that changed folder. */
  notebookIds?: string[];
}

export type CommandRunner = (binary: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ResolvedNotebook { notebookId: string; title: string; pageCount: number }

export interface IgniteWriterOptions {
  importBinary: string;
  serverUrl: string;
  tokenFile: string;
  libraryId?: string | undefined;
  /** Plans, previews, the importer's replica identity and the write log live here. */
  stateDir: string;
  vaultPath: string;
  /** Vault folder the mirror owns; notes there are not sent back. */
  mirrorFolder: string;
  renderer: PageRenderer;
  /** Runs the ledger backup; must resolve to the backup's path or reject. */
  backup: () => Promise<string>;
  resolveNotebook: (selector: string) => ResolvedNotebook | undefined;
  /** Called (not awaited) after a successful write, e.g. to refresh the vault mirror. */
  afterWrite?: (() => void) | undefined;
  run?: CommandRunner | undefined;
  now?: (() => Date) | undefined;
  previewWidth?: number | undefined;
}

const PLAN_TTL_MS = 30 * 60_000;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_BYTES = 512 * 1024;
const PAPERS: Paper[] = ["blank", "lined", "dot", "grid"];

interface StoredPlan extends WritePlan { args: string[]; dir: string; targets: ResolvedNotebook[] }
const MAX_FOLDER_CHARS = 96;
const MAX_MOVE_NOTEBOOKS = 50;

export class IgniteWriter {
  readonly #plans = new Map<string, StoredPlan>();
  readonly #run: CommandRunner;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();
  #log: WriteRecord[] | undefined;

  constructor(private readonly options: IgniteWriterOptions) {
    this.#run = options.run ?? runCommand;
    this.#now = options.now ?? (() => new Date());
  }

  get #plansDir(): string { return path.join(this.options.stateDir, "plans"); }
  get #replicaDir(): string { return path.join(this.options.stateDir, "replica"); }
  get #logPath(): string { return path.join(this.options.stateDir, "writes.json"); }

  #baseArgs(): string[] {
    return [
      "--server", this.options.serverUrl,
      "--token-file", this.options.tokenFile,
      "--state-dir", this.#replicaDir,
      ...(this.options.libraryId ? ["--library", this.options.libraryId] : []),
      "--json"
    ];
  }

  async plan(request: WriteRequest): Promise<WritePlan> {
    await this.#prune();
    const planId = randomBytes(6).toString("hex");
    const dir = path.join(this.#plansDir, planId);
    await mkdir(dir, { recursive: true });
    try {
      const { args, title, sourceNote, targets } = await this.#commandFor(request, dir);
      const report = await this.#import([...args, ...this.#baseArgs()], 120_000);
      const now = this.#now();
      const stored: StoredPlan = {
        planId, kind: request.kind, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
        title: report.notebook?.title ?? title,
        summary: "", pages: report.pages ?? 0, warnings: report.warnings ?? [], previews: [],
        sourceNote, appliedAt: null, args, dir, targets
      };
      if (request.kind === "note" || request.kind === "notebook") {
        stored.previews = await this.#renderPreviews(dir);
        stored.folder = report.folder ? { title: report.folder.title, created: report.folder.created } : null;
        stored.summary = `Create a new Kindle notebook "${stored.title}" ${where(report.folder ?? null)} with ${plural(stored.pages, "page")}`
          + ` (${plural(report.texts ?? 0, "text block")}, ${plural(report.strokes ?? 0, "ink stroke")}${report.blobs ? `, ${plural(report.blobs, "paper background")}` : ""})`
          + (sourceNote ? ` from ${sourceNote}` : "") + ". Existing notebooks are not touched.";
      } else if (request.kind === "move-notebook") {
        const moved = report.notebooks ?? [];
        if (!moved.length) throw new WriterError(502, "ignite-import planned no notebook to move");
        stored.folder = report.folder ? { title: report.folder.title, created: report.folder.created } : null;
        stored.notebooks = moved.map((n) => ({ notebookId: n.id, title: n.title, from: n.from }));
        stored.title = moved.length === 1 ? moved[0]!.title : `${moved.length} notebooks`;
        const unchanged = report.unchanged ?? [];
        stored.summary = `Move ${plural(moved.length, "Kindle notebook")} ${report.folder ? "into" : "to"} ${where(report.folder ?? null).replace(/^(in|at) /, "")}: `
          + moved.map((n) => `"${n.title}"${n.from ? ` (now in folder "${n.from}")` : ""}`).join(", ") + "."
          + (unchanged.length ? ` Already there: ${unchanged.map((n) => `"${n.title}"`).join(", ")}.` : "")
          + " Only folder membership changes; pages and ink are not touched.";
      } else {
        stored.summary = `Delete ${report.description ?? "the selected item"} from the Kindle library. The Kindle quarantines it on its next sync; it is not erased.`;
      }
      this.#plans.set(planId, stored);
      return publicPlan(stored);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  getPlan(planId: string): WritePlan | undefined {
    const plan = this.#plans.get(planId);
    return plan ? publicPlan(plan) : undefined;
  }

  /** Writes a plan. Serialised: one write at a time. */
  apply(planId: string): Promise<WriteResult> {
    const next = this.#queue.then(() => this.#apply(planId));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #apply(planId: string): Promise<WriteResult> {
    const plan = this.#plans.get(planId);
    if (!plan) throw new WriterError(404, "Unknown or expired plan id; make a new plan first");
    if (plan.appliedAt) throw new WriterError(409, `Plan ${planId} was already written at ${plan.appliedAt}`);
    if (new Date(plan.expiresAt).getTime() < this.#now().getTime()) throw new WriterError(410, "The plan expired; make a new plan and check its preview again");
    for (const target of plan.targets) {
      // The library may have changed since the plan: change only what was shown.
      const current = this.options.resolveNotebook(target.notebookId);
      if (!current) throw new WriterError(409, `Notebook "${target.title}" no longer exists`);
    }
    let backup: string;
    try {
      backup = await this.options.backup();
    } catch (error) {
      throw new WriterError(503, `Ledger backup failed, nothing was sent: ${error instanceof Error ? error.message : String(error)}`);
    }
    const report = await this.#import([...plan.args, ...this.#baseArgs(), "--confirm-write"], 300_000);
    if (!report.written) throw new WriterError(502, "ignite-import did not report a write");
    plan.appliedAt = this.#now().toISOString();
    const record: WriteRecord = {
      at: plan.appliedAt, planId, kind: plan.kind,
      notebookId: report.notebook?.id ?? plan.targets[0]?.notebookId ?? null,
      title: plan.title, sourceNote: plan.sourceNote, backup,
      headServerSeq: report.headServerSeq ?? null, strokeIds: report.strokeIds ?? [],
      ...(plan.folder !== undefined ? { folder: plan.folder?.title ?? null } : {}),
      ...(plan.notebooks ? { notebookIds: plan.notebooks.map((n) => n.notebookId) } : {})
    };
    await this.#append(record);
    this.options.afterWrite?.();
    return {
      planId, kind: plan.kind, notebookId: record.notebookId, title: plan.title, summary: plan.summary, backup,
      headServerSeq: record.headServerSeq,
      note: plan.kind === "note" || plan.kind === "notebook"
        ? "Written to the sync server. The Kindle shows it the next time Ignite syncs (Ignite open, pen idle ~1.5 s)."
        : plan.kind === "move-notebook"
          ? "Folder change written to the sync server. The Kindle applies it the next time Ignite syncs; the vault mirror moves the notes to the matching Kindle/<Folder>/ subfolder."
          : "Deletion written to the sync server. The Kindle applies it the next time Ignite syncs."
    };
  }

  /** Write history (newest last). */
  async writes(): Promise<WriteRecord[]> {
    if (!this.#log) {
      try {
        const parsed = JSON.parse(await readFile(this.#logPath, "utf8")) as { writes?: WriteRecord[] };
        this.#log = Array.isArray(parsed.writes) ? parsed.writes : [];
      } catch {
        this.#log = [];
      }
    }
    return this.#log;
  }

  /** notebook id → vault note it was sent from. */
  async sourceNotes(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const w of await this.writes()) if (w.notebookId && w.sourceNote && w.kind === "note") map.set(w.notebookId, w.sourceNote);
    return map;
  }

  /** Ink this writer drew (checkboxes, rules, labels): not handwriting, so not transcribed. */
  async printedStrokeIds(): Promise<Set<string>> {
    return new Set((await this.writes()).flatMap((w) => w.strokeIds));
  }

  async #append(record: WriteRecord): Promise<void> {
    const log = await this.writes();
    log.push(record);
    await mkdir(this.options.stateDir, { recursive: true });
    const tmp = `${this.#logPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, writes: log }, null, 1), { mode: 0o600 });
    await rename(tmp, this.#logPath);
  }

  async #commandFor(request: WriteRequest, dir: string): Promise<{ args: string[]; title: string; sourceNote: string | null; targets: ResolvedNotebook[] }> {
    switch (request.kind) {
      case "note": {
        const { absolute, relative } = await this.#vaultNote(request.notePath);
        const content = await readFile(absolute);
        if (content.length > MAX_NOTE_BYTES) throw new WriterError(413, `Note is larger than ${MAX_NOTE_BYTES / 1024} KB`);
        // The copy is what gets sent, so the preview stays true even if the note changes.
        const copy = path.join(dir, `${path.basename(absolute)}`);
        await copyFile(absolute, copy);
        const paper = request.paper ?? "blank";
        if (!PAPERS.includes(paper)) throw new WriterError(400, `paper must be one of ${PAPERS.join(", ")}`);
        const extra = request.extraPages ?? 0;
        if (!Number.isInteger(extra) || extra < 0 || extra > 20) throw new WriterError(400, "extraPages must be 0..20");
        const title = request.title?.trim();
        const folder = request.folder === undefined ? undefined : folderName(request.folder);
        return {
          args: ["note", copy, "--paper", paper, "--extra-pages", String(extra), ...(title ? ["--title", title] : []), ...(folder ? ["--folder", folder] : []), "--preview-dir", path.join(dir, "preview")],
          title: title || path.basename(absolute, ".md"),
          sourceNote: relative,
          targets: []
        };
      }
      case "notebook": {
        const json = JSON.stringify(request.spec);
        if (!json || json.length > MAX_SPEC_BYTES) throw new WriterError(413, "Page spec is missing or larger than 2 MB");
        const specPath = path.join(dir, "spec.json");
        await writeFile(specPath, json);
        const notebook = (request.spec as { notebook?: { title?: unknown; folder?: unknown } })?.notebook;
        if (notebook?.folder !== undefined) folderName(notebook.folder);
        const title = notebook?.title;
        return { args: [specPath, "--preview-dir", path.join(dir, "preview")], title: typeof title === "string" ? title : "Notebook", sourceNote: null, targets: [] };
      }
      case "move-notebook": {
        if (!Array.isArray(request.notebooks) || request.notebooks.length === 0) throw new WriterError(400, "notebooks must list at least one notebook");
        if (request.notebooks.length > MAX_MOVE_NOTEBOOKS) throw new WriterError(400, `At most ${MAX_MOVE_NOTEBOOKS} notebooks per move`);
        const targets: ResolvedNotebook[] = [];
        for (const selector of request.notebooks) {
          const target = typeof selector === "string" ? this.options.resolveNotebook(selector) : undefined;
          if (!target) throw new WriterError(404, `No single Kindle notebook matches "${String(selector)}"`);
          if (!targets.some((t) => t.notebookId === target.notebookId)) targets.push(target);
        }
        const folder = request.folder === null ? null : folderName(request.folder);
        return {
          args: ["move-notebook", ...targets.map((t) => t.notebookId), ...(folder === null ? ["--top-level"] : ["--folder", folder])],
          title: targets.length === 1 ? targets[0]!.title : `${targets.length} notebooks`,
          sourceNote: null,
          targets
        };
      }
      case "delete-notebook":
      case "delete-page": {
        const target = this.options.resolveNotebook(request.notebook);
        if (!target) throw new WriterError(404, `No single Kindle notebook matches "${request.notebook}"`);
        if (request.kind === "delete-notebook") return { args: ["delete-notebook", target.notebookId], title: target.title, sourceNote: null, targets: [target] };
        if (!Number.isInteger(request.page) || request.page < 1 || request.page > target.pageCount) {
          throw new WriterError(400, `"${target.title}" has ${plural(target.pageCount, "page")}; page must be 1..${target.pageCount}`);
        }
        return { args: ["delete-page", target.notebookId, "--page", String(request.page)], title: target.title, sourceNote: null, targets: [target] };
      }
    }
  }

  async #vaultNote(notePath: string): Promise<{ absolute: string; relative: string }> {
    if (typeof notePath !== "string" || !notePath.trim()) throw new WriterError(400, "notePath is required");
    const vault = await realpath(this.options.vaultPath);
    const candidate = path.resolve(vault, notePath.endsWith(".md") ? notePath : `${notePath}.md`);
    let absolute: string;
    try {
      absolute = await realpath(candidate);
    } catch {
      throw new WriterError(404, `No note at ${notePath}`);
    }
    if (!absolute.startsWith(vault + path.sep) || !absolute.endsWith(".md")) throw new WriterError(400, "Only Markdown notes inside the vault can be sent");
    const relative = path.relative(vault, absolute).split(path.sep).join("/");
    if (relative.split("/")[0] === this.options.mirrorFolder) throw new WriterError(400, `Notes under ${this.options.mirrorFolder}/ are mirrors of Kindle notebooks and are not sent back`);
    return { absolute, relative };
  }

  async #import(args: string[], timeoutMs: number): Promise<ImportReport> {
    const { code, stdout, stderr } = await this.#run(this.options.importBinary, args, timeoutMs);
    const line = stdout.trim().split("\n").pop() ?? "";
    let report: ImportReport;
    try {
      report = JSON.parse(line) as ImportReport;
    } catch {
      throw new WriterError(502, `ignite-import failed (exit ${code}): ${stderr.trim().slice(0, 300) || "no output"}`);
    }
    if (!report.ok || code !== 0) throw new WriterError(422, report.error ?? `ignite-import exited ${code}`);
    return report;
  }

  async #renderPreviews(dir: string): Promise<{ page: number; path: string }[]> {
    const previewDir = path.join(dir, "preview");
    const preview = JSON.parse(await readFile(path.join(previewDir, "preview.json"), "utf8")) as {
      page_space: { width: number; height: number };
      notebook: { pages: IgnitePage[] };
      backgrounds: Record<string, string>;
    };
    const jobs: RenderJob[] = preview.notebook.pages.map((page, index) => ({
      page,
      pageSpace: preview.page_space,
      backgroundPath: page.background.kind === "blob" ? path.join(previewDir, preview.backgrounds[page.background.sha256] ?? "missing") : undefined,
      png: { path: path.join(dir, `page-${String(index + 1).padStart(2, "0")}.png`), width: this.options.previewWidth ?? 930 }
    }));
    const results = await this.options.renderer.render(jobs);
    const failed = results.findIndex((r) => !r.ok);
    if (failed >= 0) throw new WriterError(500, `Preview of page ${failed + 1} failed: ${results[failed]!.error ?? "unknown"}`);
    return jobs.map((job, index) => ({ page: index + 1, path: job.png!.path }));
  }

  async #prune(): Promise<void> {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (new Date(plan.expiresAt).getTime() + 24 * 3600_000 < now) {
        this.#plans.delete(id);
        await rm(plan.dir, { recursive: true, force: true });
      }
    }
    // Plans from before a restart cannot be applied any more.
    try {
      for (const name of await readdir(this.#plansDir)) {
        if (this.#plans.has(name)) continue;
        const dir = path.join(this.#plansDir, name);
        const info = await stat(dir);
        if (now - info.mtimeMs > 24 * 3600_000) await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // No plans yet.
    }
  }
}

export class WriterError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function publicPlan(plan: StoredPlan): WritePlan {
  const { args: _args, dir: _dir, targets: _targets, ...rest } = plan;
  return { ...rest, previews: [...plan.previews], warnings: [...plan.warnings], ...(plan.notebooks ? { notebooks: plan.notebooks.map((n) => ({ ...n })) } : {}) };
}

/** A folder name as Ignite accepts it: 1..96 characters after trimming, no control characters. */
function folderName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (!name || [...name].length > MAX_FOLDER_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new WriterError(400, `folder must be a name of 1..${MAX_FOLDER_CHARS} characters without control characters`);
  }
  return name;
}

/** `in folder "Review"`, `in a new folder "Review" (created by this write)` or `at the top level (no folder)`. */
function where(folder: ImportFolder | null): string {
  if (!folder) return "at the top level (no folder)";
  if (folder.created) return `in a new folder "${folder.title}" (created by this write)`;
  return `in folder "${folder.title}"`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `backup.zsh DATA BACKUP_ROOT KEEP` from the Ignite service; resolves to the backup directory. */
export function zshBackup(script: string, dataDir: string, backupRoot: string, keep: number, run: CommandRunner = runCommand): () => Promise<string> {
  return async () => {
    const { code, stdout, stderr } = await run(script, [dataDir, backupRoot, String(keep)], 300_000);
    const match = / ok .* -> (.+)$/m.exec(stdout);
    if (code !== 0 || !match) throw new Error(`backup exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
    return match[1]!.trim();
  };
}

export function runCommand(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}
