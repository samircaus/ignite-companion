/**
 * Circled command marks on a Kindle page, from stroke geometry alone (no OCR, no model).
 *
 * A mark is a small closed loop (about 0.5–2.2 cm) with exactly one symbol inside it:
 *
 * - `+` (expand): two short, roughly straight strokes, one upright and one level, that cross.
 * - `?` (ask): one curved stroke plus a dot (a very short stroke) below its middle.
 *
 * Optionally a larger closed loop near the mark selects what the command is about. A `?` or `+`
 * drawn *inside* a large loop also counts: selection and command in one.
 *
 * Coordinates are canonical page units (15624 × 20832, about 1000 per cm). Thresholds come from
 * the hand-drawn samples collected in M0 (see `fixtures/paper-test-p1.json` and the Living
 * Notebooks architecture doc §8.1). Recognition does not depend on stroke order.
 */

export type Point = readonly [number, number];
export interface MarkStroke { id: string; points: readonly Point[] }
export interface Box { x0: number; y0: number; x1: number; y1: number }

export type Glyph = "?" | "+";

export interface CommandMark {
  glyph: Glyph;
  /** The circle around the symbol, or the big loop for a symbol drawn inside a selection. */
  circle: string;
  symbol: string[];
  /** Bounding box of the circle and symbol. */
  box: Box;
  /** The selection loop (may be the same stroke as `circle` for the "symbol inside" form). */
  selection: { id: string; box: Box } | null;
  /** Every stroke id that belongs to the mark and its selection loop (never answered about). */
  ids: string[];
}

const SMALL_MIN = 450;
const SMALL_MAX = 2300;
const SMALL_ASPECT = 1.9;
/** A loop must wind at least this share of a full turn around its own centre. */
const CLOSED_TURN = 0.8;
const DOT_PATH = 160;
const DOT_SIZE = 160;
/** A bar of the +: thin (short side ≤ this share of the long side) … */
const BAR_THIN = 0.35;
/** … and not much longer than it is long (a retraced bar still counts). */
const BAR_PATH = 2.0;
/** Selection loops: bigger than this, and within this distance of a small mark. */
const SELECTION_MIN = 2000;
const SELECTION_REACH = 2500;

export function bbox(points: readonly Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export const width = (b: Box): number => b.x1 - b.x0;
export const height = (b: Box): number => b.y1 - b.y0;
const side = (b: Box): number => Math.max(width(b), height(b));
const centre = (b: Box): Point => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];

export function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function grow(b: Box, by: number): Box {
  return { x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by };
}

function pathLength(points: readonly Point[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i += 1) n += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return n;
}

/** Share of a full turn the stroke winds around its bounding-box centre (0 for a line, ~1 for a circle). */
export function turn(points: readonly Point[]): number {
  const [cx, cy] = centre(bbox(points));
  let total = 0;
  let prev: number | undefined;
  for (const [x, y] of points) {
    if (Math.hypot(x - cx, y - cy) < 1e-6) continue;
    const a = Math.atan2(y - cy, x - cx);
    if (prev !== undefined) {
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prev = a;
  }
  return Math.abs(total) / (2 * Math.PI);
}

/** Overlap area of `inner` with `outer`, as a share of `inner`'s area (boxes of zero size count as points). */
export function insideShare(inner: Box, outer: Box): number {
  const w = Math.max(width(inner), 1);
  const h = Math.max(height(inner), 1);
  const ox = Math.max(0, Math.min(inner.x0 + w, outer.x1) - Math.max(inner.x0, outer.x0));
  const oy = Math.max(0, Math.min(inner.y0 + h, outer.y1) - Math.max(inner.y0, outer.y0));
  return (ox * oy) / (w * h);
}

function distance(a: Box, b: Box): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

interface Shape { id: string; points: readonly Point[]; box: Box; length: number; turn: number }

function shape(s: MarkStroke): Shape {
  return { id: s.id, points: s.points, box: bbox(s.points), length: pathLength(s.points), turn: turn(s.points) };
}

const isDot = (s: Shape): boolean => s.length < DOT_PATH && side(s.box) < DOT_SIZE;
const isClosed = (s: Shape): boolean => s.points.length >= 8 && s.turn >= CLOSED_TURN;

function isSmallCircle(s: Shape): boolean {
  const w = width(s.box), h = height(s.box);
  return isClosed(s)
    && Math.min(w, h) >= SMALL_MIN && Math.max(w, h) <= SMALL_MAX
    && Math.max(w, h) / Math.max(1, Math.min(w, h)) <= SMALL_ASPECT
    && s.length >= 2.2 * Math.max(w, h);
}

function straightness(s: Shape): number {
  const a = s.points[0]!, b = s.points[s.points.length - 1]!;
  return s.length / Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
}

/** The symbol formed by exactly these strokes, relative to a symbol size `scale`, or null. */
export function symbolOf(strokes: Shape[], scale: number): Glyph | null {
  const dots = strokes.filter(isDot);
  const rest = strokes.filter((s) => !isDot(s));
  // The dot of a ? often lands as two or three tiny strokes (a double tap): one dot if they sit together.
  if (rest.length === 1 && dots.length >= 1 && dots.length <= 3) {
    const box = dots.map((d) => d.box).reduce(union);
    if (side(box) > 0.3 * scale) return null;
    const dot: Shape = dots.length === 1 ? dots[0]! : { id: dots[0]!.id, points: dots.flatMap((d) => d.points), box, length: dots.reduce((n, d) => n + d.length, 0), turn: 0 };
    const curve = rest[0]!;
    // The hook of the ? is curved (not a straight tick), clearly taller than the dot, and the dot
    // sits below the hook's middle.
    const tall = height(curve.box) >= 0.15 * scale && height(curve.box) >= 1.5 * Math.max(height(dot.box), 40);
    const below = centre(dot.box)[1] > centre(curve.box)[1];
    const curved = straightness(curve) > 1.15 || curve.turn > 0.2;
    const near = distance(dot.box, curve.box) < 0.6 * scale;
    return tall && below && curved && near ? "?" : null;
  }
  if (dots.length > 0 || strokes.length !== 2) return null;
  const bar = (s: Shape): boolean => Math.min(width(s.box), height(s.box)) <= BAR_THIN * side(s.box) && s.length <= BAR_PATH * side(s.box);
  const upright = strokes.find((s) => bar(s) && height(s.box) > width(s.box));
  const level = strokes.find((s) => bar(s) && width(s.box) > height(s.box));
  if (!upright || !level || upright === level) return null;
  if (height(upright.box) < 0.2 * scale || width(level.box) < 0.2 * scale) return null;
  // They cross: the level stroke's y lies within the upright one, and the upright one's x within the level one.
  const [ux] = centre(upright.box);
  const [, ly] = centre(level.box);
  const crosses = ux > level.box.x0 - 0.1 * width(level.box) && ux < level.box.x1 + 0.1 * width(level.box)
    && ly > upright.box.y0 - 0.1 * height(upright.box) && ly < upright.box.y1 + 0.1 * height(upright.box);
  return crosses ? "+" : null;
}

/**
 * Finds command marks among `fresh` strokes (ink added since the page's last turn). `page` is
 * every visible stroke on the page (fresh ones included); it is used to make sure a small circle
 * holds nothing but its symbol. Marks whose circle id is in `consumed` are skipped.
 */
export function findMarks(fresh: readonly MarkStroke[], page: readonly MarkStroke[], consumed: ReadonlySet<string> = new Set()): CommandMark[] {
  const shapes = fresh.map(shape);
  const all = page.map(shape);
  const used = new Set<string>();
  const marks: CommandMark[] = [];

  // 1. Small circle with exactly one symbol inside.
  for (const circle of shapes.filter(isSmallCircle)) {
    if (consumed.has(circle.id) || used.has(circle.id)) continue;
    const area = grow(circle.box, 0.08 * side(circle.box));
    const inside = all.filter((s) => s.id !== circle.id && insideShare(s.box, area) >= 0.8);
    if (inside.some((s) => !shapes.some((f) => f.id === s.id))) continue; // older ink inside: not a mark
    const glyph = symbolOf(inside, side(circle.box));
    if (!glyph) continue;
    const ids = [circle.id, ...inside.map((s) => s.id)];
    ids.forEach((id) => used.add(id));
    marks.push({ glyph, circle: circle.id, symbol: inside.map((s) => s.id), box: circle.box, selection: null, ids });
  }

  const loops = shapes.filter((s) => !used.has(s.id) && isClosed(s) && side(s.box) >= SELECTION_MIN);
  // 2. A symbol drawn inside a big loop (selection and command in one).
  for (const loop of loops) {
    if (used.has(loop.id) || consumed.has(loop.id)) continue;
    const inside = shapes.filter((s) => s.id !== loop.id && !used.has(s.id) && insideShare(s.box, loop.box) >= 0.9 && side(s.box) < 0.5 * side(loop.box));
    // Look for two or three fresh strokes inside the loop that form a symbol on their own
    // (three: a ? whose dot came out as two taps). Only the latest strokes are tried.
    const recent = inside.slice(-12);
    const groups: Shape[][] = [];
    for (let i = 0; i < recent.length; i += 1) {
      for (let j = i + 1; j < recent.length; j += 1) {
        groups.push([recent[i]!, recent[j]!]);
        for (let k = j + 1; k < recent.length; k += 1) groups.push([recent[i]!, recent[j]!, recent[k]!]);
      }
    }
    let found: { glyph: Glyph; pair: Shape[] } | null = null;
    for (const group of groups) {
      const size = side(group.map((g) => g.box).reduce(union));
      if (size < 200 || size > SMALL_MAX) continue;
      const glyph = symbolOf(group, size);
      if (glyph) {
        found = { glyph, pair: group };
        break;
      }
    }
    if (!found) continue;
    const ids = [loop.id, ...found.pair.map((s) => s.id)];
    ids.forEach((id) => used.add(id));
    marks.push({ glyph: found.glyph, circle: loop.id, symbol: found.pair.map((s) => s.id), box: found.pair.map((s) => s.box).reduce(union), selection: { id: loop.id, box: loop.box }, ids });
  }
  // 3. Selection loops: a big fresh closed loop near a small mark.
  for (const mark of marks) {
    const near = loops
      .filter((l) => !used.has(l.id) && side(l.box) >= 2 * side(mark.box))
      .map((l) => ({ l, d: distance(l.box, mark.box) }))
      .filter(({ d }) => d <= SELECTION_REACH)
      .sort((p, q) => p.d - q.d)[0];
    if (near) {
      used.add(near.l.id);
      mark.selection = { id: near.l.id, box: near.l.box };
      mark.ids.push(near.l.id);
    }
  }

  return marks;
}

/**
 * What a mark is about: the selection's box, or else the ink around the mark (within `reach`),
 * leaving out the marks themselves. `null` when there is no ink nearby.
 */
export function contextBox(mark: CommandMark, page: readonly MarkStroke[], markIds: ReadonlySet<string>, reach = 3500): Box | null {
  if (mark.selection) return mark.selection.box;
  const near = page.map(shape).filter((s) => !markIds.has(s.id) && distance(s.box, mark.box) <= reach);
  if (!near.length) return null;
  return near.map((s) => s.box).reduce(union);
}
