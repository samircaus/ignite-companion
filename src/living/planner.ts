/**
 * Page-edit planner: where an AI answer goes on a Kindle page, and the `ignite-import annotate`
 * spec that writes it.
 *
 * The page is rasterised into an occupancy grid (cells of 1 % of the page width) from every
 * stroke and typed text, padded so answers keep a little air around existing ink. For a few
 * candidate widths the answer's size is measured with the handwriting font's own metrics
 * (`ignite-import measure`), and the free spot nearest to the mark wins, preferring right of it
 * or below what was asked about, and wider blocks. When nothing fits close enough, the answer
 * goes on a new page right after this one, with page links both ways.
 *
 * All coordinates here are page-width units (x 0..1, y 0..1.333), like `ignite-import` specs.
 */

import { bbox, type Box, type Point } from "./marks.js";

export const PAGE_W = 15624;
export const PAGE_H = 20832;
const ASPECT = PAGE_H / PAGE_W;
/** Ignite's chrome bands: ink only between panel rows 140 and 2340 (plus pen margin). */
export const SAFE_TOP = ((140 + 4) * 8.4) / PAGE_W;
export const SAFE_BOTTOM = ((2340 - 4) * 8.4) / PAGE_W;
const MARGIN_X = 0.05;
const CELL = 0.01;
const PAD = 0.012;
const GAP = 0.02;
/** Thin pen, capital height chosen on the Kindle (ignite-import's default). */
export const WRITING_SIZE = 0.017;
const WIDTHS = [0.86, 0.72, 0.6, 0.5, 0.42, 0.34];
const DRAWING_MAX_W = 0.6;
const DRAWING_GAP = 0.025;
/** Farther than this from the mark (page widths), a new page reads better than a far-away answer. */
const MAX_REACH = 0.6;
/** Answers taller than this go on their own page. */
const MAX_INLINE_H = 0.55;

export interface PageInk {
  strokes: { points: readonly Point[] }[];
  texts: { x: number; y: number; width: number; font_size: number; content: string }[];
}

export interface Answer { text: string; svg?: string | null }

export type Measure = (items: { text: string; width: number }[]) => Promise<{ w: number; h: number }[]>;

export interface Placement {
  where: "page" | "new-page";
  /** Answer block in page-width units. */
  box: { x: number; y: number; w: number; h: number };
  spec: Record<string, unknown>;
}

/** Canonical box → page-width units. */
export function toUnits(b: Box): Box {
  return { x0: b.x0 / PAGE_W, y0: b.y0 / PAGE_W, x1: b.x1 / PAGE_W, y1: b.y1 / PAGE_W };
}

/** The drawing's aspect (height / width) from its viewBox or width/height, or null. */
export function svgAspect(svg: string): number | null {
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/.exec(svg);
  if (vb) {
    const w = Number(vb[3]), h = Number(vb[4]);
    if (w > 0 && h > 0) return h / w;
  }
  const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/.exec(svg), h = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/.exec(svg);
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return Number(h[1]) / Number(w[1]);
  return null;
}

class Grid {
  readonly cols = Math.ceil(1 / CELL);
  readonly rows = Math.ceil(ASPECT / CELL);
  readonly cells: Uint8Array;
  #sum: Int32Array | undefined;

  constructor() {
    this.cells = new Uint8Array(this.cols * this.rows);
  }

  fill(x0: number, y0: number, x1: number, y1: number): void {
    const c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(this.cols - 1, Math.floor(x1 / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL)), r1 = Math.min(this.rows - 1, Math.floor(y1 / CELL));
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) this.cells[r * this.cols + c] = 1;
    this.#sum = undefined;
  }

  /** Whether the rectangle (page-width units) touches no filled cell. */
  free(x: number, y: number, w: number, h: number): boolean {
    const sum = this.#prefix();
    const c0 = Math.floor(x / CELL), c1 = Math.ceil((x + w) / CELL);
    const r0 = Math.floor(y / CELL), r1 = Math.ceil((y + h) / CELL);
    if (c0 < 0 || r0 < 0 || c1 > this.cols || r1 > this.rows) return false;
    const W = this.cols + 1;
    return sum[r1 * W + c1]! - sum[r0 * W + c1]! - sum[r1 * W + c0]! + sum[r0 * W + c0]! === 0;
  }

  #prefix(): Int32Array {
    if (this.#sum) return this.#sum;
    const W = this.cols + 1;
    const sum = new Int32Array(W * (this.rows + 1));
    for (let r = 0; r < this.rows; r += 1) {
      let row = 0;
      for (let c = 0; c < this.cols; c += 1) {
        row += this.cells[r * this.cols + c]!;
        sum[(r + 1) * W + c + 1] = sum[r * W + c + 1]! + row;
      }
    }
    this.#sum = sum;
    return sum;
  }
}

/** Occupancy of the page's ink and typed text, padded by `PAD`. */
export function occupancy(ink: PageInk): Grid {
  const grid = new Grid();
  for (const stroke of ink.strokes) {
    for (const [x, y] of stroke.points) grid.fill(x / PAGE_W - PAD, y / PAGE_W - PAD, x / PAGE_W + PAD, y / PAGE_W + PAD);
  }
  for (const t of ink.texts) {
    // Typed text: about 0.55 em per character, 1.4 em per line.
    const em = t.font_size / PAGE_W;
    const w = t.width / PAGE_W;
    const lines = Math.max(1, Math.ceil((t.content.length * 0.55 * em) / Math.max(w, em))) + (t.content.match(/\n/g)?.length ?? 0);
    grid.fill(t.x / PAGE_W - PAD, t.y / PAGE_W - PAD, t.x / PAGE_W + w + PAD, t.y / PAGE_W + lines * 1.4 * em + PAD);
  }
  return grid;
}

interface Block { w: number; textH: number; drawingW: number; drawingH: number; h: number }

async function blocks(answer: Answer, measure: Measure): Promise<Block[]> {
  const sizes = await measure(WIDTHS.map((width) => ({ text: answer.text, width })));
  const aspect = answer.svg ? svgAspect(answer.svg) ?? 0.6 : null;
  return WIDTHS.map((w, i) => {
    const textH = answer.text.trim() ? sizes[i]!.h : 0;
    const drawingW = aspect === null ? 0 : Math.min(w, DRAWING_MAX_W);
    const drawingH = aspect === null ? 0 : drawingW * aspect;
    const h = textH + (aspect === null ? 0 : (textH ? DRAWING_GAP : 0) + drawingH);
    return { w, textH, drawingW, drawingH, h };
  });
}

function spec(answer: Answer, block: Block, x: number, y: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (answer.text.trim()) out.writing = [{ text: answer.text, x: round(x), y: round(y), width: round(block.w) }];
  if (answer.svg && block.drawingW > 0) {
    out.drawings = [{ svg: answer.svg, x: round(x), y: round(y + block.textH + (block.textH ? DRAWING_GAP : 0)), width: round(block.drawingW) }];
  }
  return out;
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Plan where `answer` goes. `anchor`: the mark (canonical units); `about`: what it refers to
 * (selection or nearby ink, canonical), if known. `forceNewPage` skips the search.
 */
export async function placeAnswer(input: {
  ink: PageInk;
  anchor: Box;
  about?: Box | null;
  answer: Answer;
  measure: Measure;
  forceNewPage?: boolean;
}): Promise<Placement> {
  const options = await blocks(input.answer, input.measure);
  const mark = toUnits(input.anchor);
  const about = input.about ? toUnits(input.about) : null;
  if (!input.forceNewPage) {
    const grid = occupancy(input.ink);
    // Preferred spots: right of the mark, and below the mark / what it is about.
    const prefer: [number, number][] = [
      [mark.x1 + GAP, mark.y0],
      [Math.min(about?.x0 ?? mark.x0, mark.x0), Math.max(about?.y1 ?? mark.y1, mark.y1) + GAP],
      [mark.x0, mark.y1 + GAP]
    ];
    let best: { score: number; x: number; y: number; block: Block } | undefined;
    for (const block of options) {
      if (block.h > MAX_INLINE_H) continue;
      const slant = 0.012; // handwriting leans right a little beyond its measured width
      for (let y = SAFE_TOP; y + block.h <= SAFE_BOTTOM; y += CELL) {
        for (let x = MARGIN_X; x + block.w + slant <= 1 - MARGIN_X; x += CELL) {
          if (!grid.free(x, y, block.w + slant, block.h)) continue;
          const dist = Math.min(...prefer.map(([px, py]) => Math.hypot(x - px, (y - py) * 1.2)));
          const score = dist + (WIDTHS[0]! - block.w) * 0.25;
          if (!best || score < best.score) best = { score, x, y, block };
        }
      }
    }
    if (best && best.score - (WIDTHS[0]! - best.block.w) * 0.25 <= MAX_REACH) {
      return { where: "page", box: { x: best.x, y: best.y, w: best.block.w, h: best.block.h }, spec: spec(input.answer, best.block, best.x, best.y) };
    }
  }
  // A new page right after this one: answer at the top (below the link back, top right), and a
  // link icon next to the mark on this page.
  const block = options[0]!;
  const x = 0.08, y = SAFE_TOP + 0.05;
  if (y + block.h > SAFE_BOTTOM) throw new Error(`The answer is too long for one page (${Math.round((block.h / (SAFE_BOTTOM - y)) * 100)} % of it)`);
  const linkX = Math.min(0.97, mark.x1 + 0.03);
  const linkY = Math.min(SAFE_BOTTOM - 0.02, Math.max(SAFE_TOP + 0.02, (mark.y0 + mark.y1) / 2));
  return {
    where: "new-page",
    box: { x, y, w: block.w, h: block.h },
    spec: { ...spec(input.answer, block, x, y), new_page: { link_from: [round(linkX), round(linkY)] } }
  };
}

/** Three small dots (two rings each, so they read as dots with the thin pen): "seen, working on it". */
export const ACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 12">${[6, 30, 54].map((cx) => `<circle cx="${cx}" cy="6" r="4" fill="none" stroke="black"/><circle cx="${cx}" cy="6" r="1.8" fill="none" stroke="black"/>`).join("")}</svg>`;
const ACK_W = 0.06;
const ACK_H = ACK_W * (12 / 60);
const FAILED_W = 0.13;
const FAILED_H = WRITING_SIZE * 1.6;
const ACK_GAP = 0.015;

/**
 * Where the quick acknowledgement goes, as an `ignite-import annotate` spec: `working` is three
 * dots, `failed` is the word "failed". Beside the mark (right, then left, below, above), in the
 * first spot with no ink; right of the mark when none is free. Small and temporary, so it does
 * not take part in placing the answer.
 */
export function ackSpec(ink: PageInk, anchor: Box, kind: "working" | "failed"): { spec: Record<string, unknown>; box: Placement["box"] } {
  const m = toUnits(anchor);
  const [w, h] = kind === "working" ? [ACK_W, ACK_H] : [FAILED_W, FAILED_H];
  const midY = (m.y0 + m.y1) / 2 - h / 2;
  const candidates: [number, number][] = [
    [m.x1 + ACK_GAP, midY],
    [m.x0 - ACK_GAP - w, midY],
    [m.x0, m.y1 + ACK_GAP],
    [m.x0, m.y0 - ACK_GAP - h]
  ];
  const fits = ([x, y]: [number, number]) => x >= MARGIN_X / 2 && x + w <= 1 - MARGIN_X / 2 && y >= SAFE_TOP && y + h <= SAFE_BOTTOM;
  const grid = occupancy(ink);
  const clamp = ([x, y]: [number, number]): [number, number] => [Math.min(Math.max(x, MARGIN_X / 2), 1 - MARGIN_X / 2 - w), Math.min(Math.max(y, SAFE_TOP), SAFE_BOTTOM - h)];
  const [x, y] = candidates.find((c) => fits(c) && grid.free(c[0], c[1], w, h)) ?? clamp(candidates.find(fits) ?? candidates[0]!);
  const spec = kind === "working"
    ? { drawings: [{ svg: ACK_SVG, x: round(x), y: round(y), width: ACK_W }] }
    : { writing: [{ text: "failed", x: round(x), y: round(y), width: FAILED_W }] };
  return { spec, box: { x, y, w, h } };
}

/** Bounding box (canonical) of a set of strokes, or null. */
export function inkBox(strokes: { points: readonly Point[] }[]): Box | null {
  const boxes = strokes.filter((s) => s.points.length).map((s) => bbox(s.points));
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
}
