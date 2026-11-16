import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IgniteClient } from "../ignite/client.js";
import type { PageRenderer, RenderJob } from "../ignite/renderer.js";
import type { IgniteNotebook, IgnitePage, IgniteSnapshotResponse, IgniteStroke, IgniteText } from "../ignite/types.js";
import { runCommand, type CommandRunner } from "../ignite/writer.js";
import { fontSafe, type Interpretation, type Interpreter } from "./interpreter.js";
import { bbox, contextBox, findMarks, grow, union, type Box, type CommandMark, type Glyph, type MarkStroke } from "./marks.js";
import { LivingMemory } from "./memory.js";
import { PAGE_W, placeAnswer, toUnits, WRITING_SIZE, type Measure, type Placement } from "./planner.js";

/**
 * Living Notebooks: AI answers written into Kindle pages as ink.
 *
 * Two ways in, one write path:
 *
 * - **Pen** (M3): the watcher finds a circled (?) or (+) on a page of an enabled notebook and calls
 *   `answerMark`: render the page, ask the interpreter (Codex), place the answer in free space
 *   next to the mark (or on a new page after it), write it with `ignite-import annotate`.
 * - **Claude / MCP** (M2): `propose` plans a page edit with given text and drawing and returns a
 *   preview; `apply` writes it once the user said yes.
 *
 * Every write is an AI turn in `turns` (stroke ids, page, what was asked) and undoable with
 * `undo`, which removes only ink this replica wrote (`ignite-import delete-ink` refuses anything
 * else). AI ink is append-only: nothing the user wrote is ever changed. Small appends take no
 * ledger backup (the nightly backup plus undo cover them, see the architecture doc §7).
 */

export interface AiTurn {
  turnId: string;
  at: string;
  source: "pen" | "mcp";
  status: "applied" | "undone" | "failed";
  notebookId: string;
  notebookTitle: string;
  pageId: string;
  pageNumber: number;
  glyph: Glyph | null;
  markIds: string[];
  understood: string;
  answer: string;
  hasDrawing: boolean;
  question: boolean;
  placement: Placement["where"] | null;
  strokeIds: string[];
  textIds: string[];
  createdPageId: string | null;
  linkIds: string[];
  headServerSeq: number | null;
  model: string | null;
  durationMs: number | null;
  notePath: string | null;
  error: string | null;
}

export interface PageEditPlan {
  planId: string;
  createdAt: string;
  expiresAt: string;
  notebookId: string;
  notebookTitle: string;
  pageNumber: number;
  pageId: string;
  summary: string;
  placement: Placement["where"];
  box: Placement["box"];
  warnings: string[];
  preview: string;
  appliedAt: string | null;
}

interface StoredPlan extends PageEditPlan { specPath: string; dir: string; text: string; hasDrawing: boolean }

interface State { v: 1; cursor: number | null; consumed: string[]; turns: AiTurn[] }

export interface LivingStatus {
  enabled: true;
  interpreter: string;
  busy: string | null;
  lastError: string | null;
  turns: number;
  recent: Pick<AiTurn, "turnId" | "at" | "source" | "status" | "notebookTitle" | "pageNumber" | "glyph" | "understood" | "placement" | "durationMs" | "error">[];
}

export interface LivingOptions {
  client: IgniteClient;
  renderer: PageRenderer;
  importBinary: string;
  serverUrl: string;
  tokenFile: string;
  libraryId?: string | undefined;
  /** Turns, plans and the AI replica (`replica/`, its own ignite-import identity and ink journal). */
  stateDir: string;
  vaultPath: string;
  interpreter: Interpreter;
  ocrLanguages?: string[];
  run?: CommandRunner;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const PLAN_TTL_MS = 30 * 60_000;
const MAX_TURNS = 500;
const MAX_CONSUMED = 5000;

interface ImportReport {
  ok: boolean;
  error?: string;
  written?: boolean;
  pageId?: string;
  createdPageId?: string | null;
  strokeIds?: string[];
  textIds?: string[];
  linkIds?: string[];
  headServerSeq?: number;
  warnings?: string[];
  description?: string;
  sizes?: { w: number; h: number }[];
  strokes?: number;
  texts?: number;
  alreadyGone?: number;
}

export interface PageRef { notebook: IgniteNotebook; notebookIndex: number; page: IgnitePage; index: number; folder: string | null }

export class LivingService {
  readonly memory: LivingMemory;
  readonly #run: CommandRunner;
  readonly #now: () => Date;
  readonly #plans = new Map<string, StoredPlan>();
  #state: State | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #snap: { at: number; response: IgniteSnapshotResponse } | undefined;
  #busy: string | null = null;
  #lastError: string | null = null;

  constructor(private readonly options: LivingOptions) {
    this.#run = options.run ?? runCommand;
    this.#now = options.now ?? (() => new Date());
    this.memory = new LivingMemory(options.vaultPath, this.#now);
  }

  get replicaDir(): string { return path.join(this.options.stateDir, "replica"); }
  get #statePath(): string { return path.join(this.options.stateDir, "state.json"); }

  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true });
    await this.memory.ensureDefaults();
    await this.#load();
  }

  // ------------------------------------------------------------------ state

  async #load(): Promise<State> {
    if (this.#state) return this.#state;
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as State;
      this.#state = { v: 1, cursor: parsed.cursor ?? null, consumed: parsed.consumed ?? [], turns: parsed.turns ?? [] };
    } catch {
      this.#state = { v: 1, cursor: null, consumed: [], turns: [] };
    }
    return this.#state;
  }

  async #save(): Promise<void> {
    const state = await this.#load();
    state.turns = state.turns.slice(-MAX_TURNS);
    state.consumed = state.consumed.slice(-MAX_CONSUMED);
    await mkdir(this.options.stateDir, { recursive: true });
    const tmp = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    await rename(tmp, this.#statePath);
  }

  async cursor(): Promise<number | null> { return (await this.#load()).cursor; }
  async setCursor(seq: number): Promise<void> {
    const state = await this.#load();
    if (state.cursor === seq) return;
    state.cursor = seq;
    await this.#save();
  }

  async consumed(): Promise<Set<string>> { return new Set((await this.#load()).consumed); }

  async turns(limit = 20): Promise<AiTurn[]> { return (await this.#load()).turns.slice(-limit).reverse(); }

  /** Stroke ids of every AI turn still on the page (for transcription exclusion and the watcher). */
  async aiStrokeIds(): Promise<Set<string>> {
    return new Set((await this.#load()).turns.filter((t) => t.status === "applied").flatMap((t) => t.strokeIds));
  }

  async replicaId(): Promise<string | null> {
    try {
      return (JSON.parse(await readFile(path.join(this.replicaDir, "ignite-import-replica.json"), "utf8")) as { replica_id?: string }).replica_id ?? null;
    } catch {
      return null;
    }
  }

  async status(): Promise<LivingStatus> {
    const turns = await this.turns(8);
    return {
      enabled: true,
      interpreter: this.options.interpreter.name,
      busy: this.#busy,
      lastError: this.#lastError,
      turns: (await this.#load()).turns.length,
      recent: turns.map(({ turnId, at, source, status, notebookTitle, pageNumber, glyph, understood, placement, durationMs, error }) => ({ turnId, at, source, status, notebookTitle, pageNumber, glyph, understood, placement, durationMs, error }))
    };
  }

  // ------------------------------------------------------------------ snapshot

  async libraryId(): Promise<string> {
    if (this.options.libraryId) return this.options.libraryId;
    const libraries = await this.options.client.libraries();
    if (libraries.length !== 1) throw new Error(libraries.length ? "Several Ignite libraries; set COMPANION_IGNITE_LIBRARY_ID" : "Ignite server has no library");
    return libraries[0]!.library_id;
  }

  /** The library at head (cached for a moment: a 40 MB fetch). */
  async snapshot(maxAgeMs = 1500): Promise<IgniteSnapshotResponse> {
    const now = Date.now();
    if (this.#snap && now - this.#snap.at <= maxAgeMs) return this.#snap.response;
    const response = await this.options.client.snapshot(await this.libraryId());
    this.#snap = { at: now, response };
    return response;
  }

  async findPage(selector: { pageId?: string; notebook?: string; page?: number }, maxAgeMs = 1500): Promise<PageRef> {
    const snap = (await this.snapshot(maxAgeMs)).snapshot;
    const folderOf = (nb: IgniteNotebook): string | null => snap.folders?.find((f) => f.folder_id === nb.folder_id)?.title ?? null;
    if (selector.pageId) {
      for (const [notebookIndex, notebook] of snap.notebooks.entries()) {
        const index = notebook.pages.findIndex((p) => p.page_id === selector.pageId);
        if (index >= 0) return { notebook, notebookIndex, page: notebook.pages[index]!, index, folder: folderOf(notebook) };
      }
      throw new LivingError(404, "That page no longer exists");
    }
    const key = (selector.notebook ?? "").trim();
    const lower = key.toLowerCase();
    let matches = snap.notebooks.map((nb, i) => ({ nb, i })).filter(({ nb, i }) => nb.notebook_id === key || String(i) === key || nb.title.toLowerCase() === lower);
    if (!matches.length) matches = snap.notebooks.map((nb, i) => ({ nb, i })).filter(({ nb }) => nb.title.toLowerCase().includes(lower));
    if (matches.length !== 1) throw new LivingError(404, matches.length ? `"${key}" matches ${matches.length} notebooks; be more specific` : `No Kindle notebook matches "${key}"`);
    const { nb, i } = matches[0]!;
    const index = (selector.page ?? 1) - 1;
    const page = nb.pages[index];
    if (!page) throw new LivingError(400, `"${nb.title}" has ${nb.pages.length} pages; page must be 1..${nb.pages.length}`);
    return { notebook: nb, notebookIndex: i, page, index, folder: folderOf(nb) };
  }

  // ------------------------------------------------------------------ ignite-import

  #base(): string[] {
    return ["--server", this.options.serverUrl, "--token-file", this.options.tokenFile, "--state-dir", this.replicaDir, ...(this.options.libraryId ? ["--library", this.options.libraryId] : []), "--json"];
  }

  async #import(args: string[], timeoutMs = 120_000): Promise<ImportReport> {
    const { code, stdout, stderr } = await this.#run(this.options.importBinary, args, timeoutMs);
    const line = stdout.trim().split("\n").pop() ?? "";
    let report: ImportReport;
    try {
      report = JSON.parse(line) as ImportReport;
    } catch {
      throw new LivingError(502, `ignite-import failed (exit ${code}): ${stderr.trim().slice(0, 300) || "no output"}`);
    }
    if (!report.ok || code !== 0) throw new LivingError(422, report.error ?? `ignite-import exited ${code}`);
    return report;
  }

  readonly measure: Measure = async (items) => {
    const dir = path.join(this.options.stateDir, "tmp");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `measure-${randomBytes(4).toString("hex")}.json`);
    await writeFile(file, JSON.stringify(items.map((i) => ({ text: i.text, size: WRITING_SIZE, width: i.width }))));
    try {
      const report = await this.#import(["measure", file, "--json"], 30_000);
      if (!report.sizes || report.sizes.length !== items.length) throw new LivingError(502, "ignite-import measure returned no sizes");
      return report.sizes;
    } finally {
      await rm(file, { force: true });
    }
  };

  async #annotate(ref: PageRef, spec: Record<string, unknown>, dir: string, write: boolean): Promise<ImportReport> {
    const specPath = path.join(dir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec));
    return await this.#import([
      "annotate", specPath, "--notebook", ref.notebook.notebook_id, "--page", String(ref.index + 1),
      "--preview-dir", path.join(dir, "preview"), ...this.#base(), ...(write ? ["--confirm-write"] : [])
    ], write ? 300_000 : 120_000);
  }

  // ------------------------------------------------------------------ rendering

  /** PNG of the page as it is, optionally with planned additions (`preview/additions.json`). */
  async #renderPage(page: IgnitePage, png: string, width: number, extra?: { strokes: IgniteStroke[]; texts: IgniteText[] }, ocr = false): Promise<{ lines: { text: string; x: number; y: number; w: number; h: number }[] }> {
    const pageSpace = (await this.snapshot(60_000)).snapshot.page_space;
    const job: RenderJob = {
      page: { ...page, background: { kind: "blank" }, strokes: [...page.strokes, ...(extra?.strokes ?? [])], texts: [...(page.texts ?? []), ...(extra?.texts ?? [])] },
      pageSpace,
      png: { path: png, width },
      ...(ocr ? { ocr: { width: 1860, languages: this.options.ocrLanguages ?? ["en-US"] }, printed: await this.aiStrokeIds() } : {})
    };
    const [result] = await this.options.renderer.render([job]);
    if (!result?.ok) throw new LivingError(500, `Rendering the page failed: ${result?.error ?? "unknown"}`);
    return { lines: result.ocr?.lines ?? [] };
  }

  /** Close-up of `region` (canonical units): the strokes there, moved to the origin. */
  async #renderFocus(page: IgnitePage, region: Box, png: string): Promise<void> {
    const strokes = page.strokes
      .filter((s) => { const b = bbox(s.points.map((p) => [p.x, p.y] as const)); return b.x1 >= region.x0 && b.x0 <= region.x1 && b.y1 >= region.y0 && b.y0 <= region.y1; })
      .map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: Math.min(Math.max(p.x - region.x0, 0), region.x1 - region.x0), y: Math.min(Math.max(p.y - region.y0, 0), region.y1 - region.y0) })) }));
    const job: RenderJob = {
      page: { ...page, background: { kind: "blank" }, strokes, texts: [] },
      pageSpace: { width: region.x1 - region.x0, height: region.y1 - region.y0 },
      png: { path: png, width: 1200 }
    };
    const [result] = await this.options.renderer.render([job]);
    if (!result?.ok) throw new LivingError(500, `Rendering the close-up failed: ${result?.error ?? "unknown"}`);
  }

  // ------------------------------------------------------------------ M2: page edits from Claude

  /**
   * Plans writing `text` (handwriting) and an optional `svg` drawing onto a page: free space near
   * `near` (page-width units, default the page's last ink), or a new page after it. Dry run with
   * a rendered preview; `apply` writes it.
   */
  async propose(input: { notebook: string; page: number; text: string; svg?: string | null; near?: { x: number; y: number } | null; newPage?: boolean }): Promise<PageEditPlan> {
    const ref = await this.findPage({ notebook: input.notebook, page: input.page });
    const text = fontSafe(input.text ?? "");
    if (!text && !input.svg) throw new LivingError(400, "Give text, svg or both");
    const anchor = input.near
      ? (() => { const x = input.near.x * PAGE_W, y = input.near.y * PAGE_W; return { x0: x, y0: y, x1: x + 1, y1: y + 1 }; })()
      : lastInkBox(ref.page) ?? { x0: 0.08 * PAGE_W, y0: 0.1 * PAGE_W, x1: 0.08 * PAGE_W + 1, y1: 0.1 * PAGE_W + 1 };
    const placement = await placeAnswer({ ink: { strokes: pts(ref.page), texts: ref.page.texts ?? [] }, anchor, answer: { text, svg: input.svg ?? null }, measure: this.measure, forceNewPage: input.newPage === true });
    const planId = randomBytes(6).toString("hex");
    const dir = path.join(this.options.stateDir, "plans", planId);
    await mkdir(dir, { recursive: true });
    try {
      const report = await this.#annotate(ref, placement.spec, dir, false);
      const additions = JSON.parse(await readFile(path.join(dir, "preview", "additions.json"), "utf8")) as { strokes: IgniteStroke[]; texts: IgniteText[] };
      const preview = path.join(dir, "preview.png");
      await this.#renderPage(placement.where === "page" ? ref.page : { ...ref.page, strokes: [], texts: [] }, preview, 930, additions);
      const now = this.#now();
      const plan: StoredPlan = {
        planId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
        notebookId: ref.notebook.notebook_id, notebookTitle: ref.notebook.title, pageNumber: ref.index + 1, pageId: ref.page.page_id,
        summary: placement.where === "page"
          ? `Write ${describe(text, Boolean(input.svg))} onto page ${ref.index + 1} of "${ref.notebook.title}" (free space at x ${placement.box.x.toFixed(2)}, y ${placement.box.y.toFixed(2)}). Only adds ink; nothing there is changed.`
          : `Add a new page after page ${ref.index + 1} of "${ref.notebook.title}" with ${describe(text, Boolean(input.svg))}, linked both ways. Only adds; nothing existing is changed.`,
        placement: placement.where, box: placement.box, warnings: report.warnings ?? [], preview, appliedAt: null,
        specPath: path.join(dir, "spec.json"), dir, text, hasDrawing: Boolean(input.svg)
      };
      this.#plans.set(planId, plan);
      return publicPlan(plan);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  hasPlan(planId: string): boolean { return this.#plans.has(planId); }
  getPlan(planId: string): PageEditPlan | undefined { const p = this.#plans.get(planId); return p ? publicPlan(p) : undefined; }

  apply(planId: string): Promise<AiTurn> {
    return this.#serial(async () => {
      const plan = this.#plans.get(planId);
      if (!plan) throw new LivingError(404, "Unknown or expired plan id; make a new plan first");
      if (plan.appliedAt) throw new LivingError(409, `Plan ${planId} was already written at ${plan.appliedAt}`);
      if (new Date(plan.expiresAt).getTime() < this.#now().getTime()) throw new LivingError(410, "The plan expired; make a new one and check its preview again");
      const ref = await this.findPage({ pageId: plan.pageId }, 0);
      const spec = JSON.parse(await readFile(plan.specPath, "utf8")) as Record<string, unknown>;
      if (plan.placement === "page" && !(await this.#stillFree(ref, plan.box))) throw new LivingError(409, "Someone wrote into that spot since the plan; make a new plan");
      const report = await this.#annotate(ref, spec, plan.dir, true);
      plan.appliedAt = this.#now().toISOString();
      const turn = this.#turn({ source: "mcp", ref, report, placement: plan.placement, answer: plan.text, hasDrawing: plan.hasDrawing });
      await this.#record(turn);
      return turn;
    });
  }

  async #stillFree(ref: PageRef, box: Placement["box"]): Promise<boolean> {
    const x0 = box.x * PAGE_W, y0 = box.y * PAGE_W, x1 = (box.x + box.w) * PAGE_W, y1 = (box.y + box.h) * PAGE_W;
    return !ref.page.strokes.some((s) => s.points.some((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1));
  }

  /** Removes the ink of one AI turn (only ink this replica wrote; your own is never touched). */
  undo(turnId: string): Promise<AiTurn> {
    return this.#serial(async () => {
      const state = await this.#load();
      const turn = state.turns.find((t) => t.turnId === turnId);
      if (!turn) throw new LivingError(404, `No AI turn ${turnId}`);
      if (turn.status !== "applied") throw new LivingError(409, `Turn ${turnId} is ${turn.status}; nothing to undo`);
      const ids = [...turn.strokeIds, ...turn.textIds];
      if (ids.length) await this.#import(["delete-ink", ...ids, ...this.#base(), "--confirm-write"], 300_000);
      turn.status = "undone";
      await this.#save();
      return turn;
    });
  }

  /**
   * Ink the user added since `afterSeq` (default: the watcher's cursor minus a window), per page,
   * with any circled marks found in it. Read-only.
   */
  async recentChanges(afterSeq?: number): Promise<{ headSeq: number; afterSeq: number; pages: { notebookTitle: string; pageNumber: number; pageId: string; strokes: number; erasures: number; marks: { glyph: Glyph; at: [number, number]; consumed: boolean }[] }[] }> {
    const library = await this.libraryId();
    const ours = new Set([await this.replicaId()].filter((r): r is string => Boolean(r)));
    const head = (await this.options.client.operations(library, Number.MAX_SAFE_INTEGER - 1, 1)).head_server_seq;
    const after = Math.max(0, afterSeq ?? head - 2000);
    const perPage = new Map<string, { strokes: MarkStroke[]; erasures: number }>();
    for (let cursor = after; cursor < head;) {
      const batch = await this.options.client.operations(library, cursor, 500);
      if (!batch.operations.length) break;
      for (const op of batch.operations) {
        const o = op.envelope.operation;
        if (!("page_id" in o) || typeof o.page_id !== "string" || ours.has(op.envelope.replica_id)) continue;
        const entry = perPage.get(o.page_id) ?? { strokes: [], erasures: 0 };
        if (o.type === "add_stroke") entry.strokes.push(toMarkStroke((o as { stroke: IgniteStroke }).stroke));
        else if (o.type === "erase_region") entry.erasures += 1;
        else continue;
        perPage.set(o.page_id, entry);
      }
      cursor = batch.next_after;
    }
    const consumed = await this.consumed();
    const pages = [];
    for (const [pageId, entry] of perPage) {
      let ref: PageRef;
      try {
        ref = await this.findPage({ pageId }, 30_000);
      } catch {
        continue;
      }
      const marks = findMarks(entry.strokes, [...entry.strokes, ...ref.page.strokes.map(toMarkStroke).filter((s) => !entry.strokes.some((e) => e.id === s.id))]).map((m) => ({
        glyph: m.glyph, at: [round2(m.box.x0 / PAGE_W), round2(m.box.y0 / PAGE_W)] as [number, number], consumed: consumed.has(m.circle)
      }));
      pages.push({ notebookTitle: ref.notebook.title, pageNumber: ref.index + 1, pageId, strokes: entry.strokes.length, erasures: entry.erasures, marks });
    }
    return { headSeq: head, afterSeq: after, pages };
  }

  // ------------------------------------------------------------------ M3: pen marks

  /**
   * Checks `fresh` strokes (ink added since the page's last turn) against the page at head and
   * answers each circled mark found in an enabled notebook. Returns the turns made.
   */
  async checkPage(pageId: string, fresh: MarkStroke[]): Promise<AiTurn[]> {
    const ref = await this.findPage({ pageId }, 0);
    const memory = await this.memory.forNotebook(ref.notebook.notebook_id, ref.notebook.title, ref.folder);
    if (!memory.enabled) return [];
    // Use the strokes as they are now: erased or split ones no longer count as fresh.
    const current = new Map(ref.page.strokes.map((s) => [s.stroke_id, s]));
    const still = fresh.filter((s) => current.has(s.id)).map((s) => toMarkStroke(current.get(s.id)!));
    const page = ref.page.strokes.map(toMarkStroke);
    const marks = findMarks(still, page, await this.consumed());
    const turns: AiTurn[] = [];
    for (const mark of marks) turns.push(await this.answerMark(ref, mark, page));
    return turns;
  }

  answerMark(ref: PageRef, mark: CommandMark, page: MarkStroke[]): Promise<AiTurn> {
    return this.#serial(async () => {
      const started = Date.now();
      const state = await this.#load();
      state.consumed.push(...mark.ids);
      await this.#save();
      this.#busy = `${mark.glyph} on page ${ref.index + 1} of "${ref.notebook.title}"`;
      const memory = await this.memory.forNotebook(ref.notebook.notebook_id, ref.notebook.title, ref.folder);
      const dir = path.join(this.options.stateDir, "turns", `${this.#now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
      await mkdir(dir, { recursive: true });
      let interpretation: Interpretation | undefined;
      try {
        const markIds = new Set(mark.ids);
        const about = contextBox(mark, page, markIds);
        const pagePng = path.join(dir, "page.png");
        const { lines } = await this.#renderPage(ref.page, pagePng, 1240, undefined, true);
        const region = grow(about ? union(about, mark.box) : mark.box, 1200);
        const focusPng = path.join(dir, "focus.png");
        await this.#renderFocus(ref.page, clampBox(region), focusPng);
        const near = grow(region, 1500);
        const nearbyText = lines.filter((l) => l.x + l.w >= near.x0 && l.x <= near.x1 && l.y + l.h >= near.y0 && l.y <= near.y1).map((l) => l.text).join("\n");
        const u = (b: Box): [number, number, number, number] => { const t = toUnits(b); return [t.x0, t.y0, t.x1, t.y1]; };
        interpretation = await this.options.interpreter.interpret({
          glyph: mark.glyph, notebookTitle: ref.notebook.title, pageNumber: ref.index + 1, pageCount: ref.notebook.pages.length,
          pageImage: pagePng, focusImage: focusPng, markBox: u(mark.box), aboutBox: about ? u(about) : null, nearbyText,
          profileName: memory.profile.name, profileInstructions: memory.profile.instructions, notebookInstructions: memory.instructions,
          memory: memory.memory, summary: memory.summary, lineChars: 34
        });
        const text = interpretation.needsConfirmation ? `? ${interpretation.answer}` : interpretation.answer;
        // Place against the page as it is now (the user may have kept writing).
        const now = await this.findPage({ pageId: ref.page.page_id }, 0);
        const ink = { strokes: pts(now.page), texts: now.page.texts ?? [] };
        let report: ImportReport;
        let placement: Placement;
        let svg = interpretation.needsConfirmation ? null : interpretation.svg;
        try {
          placement = await placeAnswer({ ink, anchor: mark.box, about, answer: { text, svg }, measure: this.measure });
          report = await this.#annotate(now, placement.spec, dir, true);
        } catch (error) {
          if (!svg) throw error;
          // A drawing the importer cannot use: write the text alone.
          this.options.log?.({ event: "living_drawing_dropped", error: error instanceof Error ? error.message : String(error) });
          svg = null;
          placement = await placeAnswer({ ink, anchor: mark.box, about, answer: { text, svg }, measure: this.measure });
          report = await this.#annotate(now, placement.spec, dir, true);
        }
        const turn = this.#turn({ source: "pen", ref: now, report, placement: placement.where, answer: text, hasDrawing: Boolean(svg), glyph: mark.glyph, markIds: mark.ids, understood: interpretation.understood, question: interpretation.needsConfirmation, durationMs: Date.now() - started, model: interpretation.model });
        turn.notePath = await this.memory.record({
          notebookId: ref.notebook.notebook_id, title: ref.notebook.title, profile: memory.profile.name,
          logLine: `p${ref.index + 1} (${mark.glyph}) ${interpretation.understood || "(no summary)"}${placement.where === "new-page" ? " → new page" : ""}`,
          facts: interpretation.memoryFacts, summary: interpretation.summaryUpdate
        }).catch((error: unknown) => { this.options.log?.({ event: "living_memory_failed", error: String(error) }); return null; });
        await this.#record(turn);
        this.#lastError = null;
        return turn;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#lastError = message.slice(0, 300);
        const turn = this.#turn({ source: "pen", ref, report: null, placement: null, answer: interpretation?.answer ?? "", hasDrawing: false, glyph: mark.glyph, markIds: mark.ids, understood: interpretation?.understood ?? "", question: false, durationMs: Date.now() - started, error: message.slice(0, 500) });
        await this.#record(turn);
        this.options.log?.({ event: "living_turn_failed", page: ref.page.page_id, error: message.slice(0, 300) });
        return turn;
      } finally {
        this.#busy = null;
      }
    });
  }

  // ------------------------------------------------------------------ helpers

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #turn(input: { source: AiTurn["source"]; ref: PageRef; report: ImportReport | null; placement: AiTurn["placement"]; answer: string; hasDrawing: boolean; glyph?: Glyph; markIds?: string[]; understood?: string; question?: boolean; durationMs?: number; error?: string; model?: string | undefined }): AiTurn {
    return {
      turnId: randomBytes(5).toString("hex"),
      at: this.#now().toISOString(),
      source: input.source,
      status: input.error ? "failed" : "applied",
      notebookId: input.ref.notebook.notebook_id,
      notebookTitle: input.ref.notebook.title,
      pageId: input.ref.page.page_id,
      pageNumber: input.ref.index + 1,
      glyph: input.glyph ?? null,
      markIds: input.markIds ?? [],
      understood: input.understood ?? "",
      answer: input.answer,
      hasDrawing: input.hasDrawing,
      question: input.question ?? false,
      placement: input.placement,
      strokeIds: input.report?.strokeIds ?? [],
      textIds: input.report?.textIds ?? [],
      createdPageId: input.report?.createdPageId ?? null,
      linkIds: input.report?.linkIds ?? [],
      headServerSeq: input.report?.headServerSeq ?? null,
      model: input.source === "pen" ? input.model ?? this.options.interpreter.name : null,
      durationMs: input.durationMs ?? null,
      notePath: null,
      error: input.error ?? null
    };
  }

  async #record(turn: AiTurn): Promise<void> {
    (await this.#load()).turns.push(turn);
    await this.#save();
    this.options.log?.({ event: "living_turn", turnId: turn.turnId, status: turn.status, page: turn.pageNumber, notebook: turn.notebookTitle, strokes: turn.strokeIds.length, ms: turn.durationMs });
  }
}

export class LivingError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function publicPlan(plan: StoredPlan): PageEditPlan {
  const { specPath: _s, dir: _d, text: _t, hasDrawing: _h, ...rest } = plan;
  return { ...rest, warnings: [...plan.warnings] };
}

function describe(text: string, drawing: boolean): string {
  const words = text.split(/\s+/).filter(Boolean).length;
  return [words ? `${words} word${words === 1 ? "" : "s"} of handwriting` : "", drawing ? "a drawing" : ""].filter(Boolean).join(" and ");
}

export function toMarkStroke(s: IgniteStroke): MarkStroke {
  return { id: s.stroke_id, points: s.points.map((p) => [p.x, p.y] as const) };
}

function pts(page: IgnitePage): { points: [number, number][] }[] {
  return page.strokes.map((s) => ({ points: s.points.map((p) => [p.x, p.y] as [number, number]) }));
}

function lastInkBox(page: IgnitePage): Box | null {
  const last = page.strokes.at(-1);
  return last ? bbox(last.points.map((p) => [p.x, p.y] as const)) : null;
}

function clampBox(b: Box): Box {
  return { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(PAGE_W, b.x1), y1: Math.min(20832, b.y1) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
