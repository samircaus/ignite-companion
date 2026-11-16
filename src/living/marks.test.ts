import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMarks, type MarkStroke, type Point } from "./marks.js";

// Real strokes from the Kindle (Paper test p1): 12 hand-drawn marks (ledger seqs 12031–12066:
// 6 × (?) then 6 × (+)), a big loop with a ? inside (12018–12020), names, smileys and lettering.
const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "paper-test-p1.json"), "utf8")) as {
  strokes: { root: string; seq: number | null; pts: [number, number][] }[];
};
const strokes: (MarkStroke & { seq: number | null })[] = fixture.strokes.map((s) => ({ id: s.root, seq: s.seq, points: s.pts as Point[] }));
const seqOf = new Map(strokes.map((s) => [s.id, s.seq]));
const seqs = (ids: string[]): number[] => ids.map((id) => seqOf.get(id) ?? -1).sort((a, b) => a - b);

describe("findMarks on real Kindle ink", () => {
  it("finds exactly the twelve circled samples and the ? inside the big loop, nothing else", () => {
    const marks = findMarks(strokes, strokes);
    const found = marks.map((m) => ({ glyph: m.glyph, seqs: seqs([m.circle, ...m.symbol]) })).sort((a, b) => a.seqs[0]! - b.seqs[0]!);
    expect(found).toHaveLength(13);
    expect(found[0]).toEqual({ glyph: "?", seqs: [12018, 12019, 12020] });
    const samples = found.slice(1);
    expect(samples.filter((m) => m.glyph === "?")).toHaveLength(6);
    expect(samples.filter((m) => m.glyph === "+")).toHaveLength(6);
    for (const m of samples) {
      expect(m.seqs).toHaveLength(3);
      expect(m.seqs.every((s) => s >= 12031 && s <= 12066)).toBe(true);
    }
    // The big loop with a ? inside is its own selection.
    const inLoop = marks.find((m) => seqOf.get(m.circle) === 12018)!;
    expect(inLoop.selection?.id).toBe(inLoop.circle);
  });

  it("only looks at fresh ink: older strokes never fire", () => {
    const fresh = strokes.filter((s) => (s.seq ?? 0) >= 12061);
    const marks = findMarks(fresh, strokes);
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.glyph === "+")).toBe(true);
  });

  it("skips consumed marks and marks whose symbol is incomplete", () => {
    const first = strokes.filter((s) => s.seq !== null && s.seq >= 12031 && s.seq <= 12033);
    expect(findMarks(first, strokes)).toHaveLength(1);
    expect(findMarks(first, strokes, new Set(findMarks(first, strokes).map((m) => m.circle)))).toHaveLength(0);
    // Without the dot it is not a ? yet.
    const noDot = first.filter((s) => !findMarks(first, strokes)[0]!.symbol.includes(s.id) || s.points.length > 30);
    expect(findMarks(noDot, noDot)).toHaveLength(0);
  });

  it("links a nearby big loop as the selection", () => {
    const mark = strokes.filter((s) => s.seq !== null && s.seq >= 12031 && s.seq <= 12033);
    const box = { x0: Math.min(...mark.flatMap((s) => s.points.map((p) => p[0]))), y0: Math.min(...mark.flatMap((s) => s.points.map((p) => p[1]))) };
    // An ellipse 4000 × 1500 just above-left of the mark.
    const loop: MarkStroke = {
      id: "loop",
      points: Array.from({ length: 80 }, (_, i) => {
        const t = (i / 79) * 2 * Math.PI * 0.95;
        return [box.x0 - 2500 + 2000 * Math.cos(t), box.y0 - 1200 + 750 * Math.sin(t)] as Point;
      })
    };
    const marks = findMarks([...mark, loop], [...strokes, loop]);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.selection?.id).toBe("loop");
  });

  it("reads a small ? whose dot came out as two taps, and not the squares beside it", () => {
    const f = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "paper-test-p4-double-dot.json"), "utf8")) as { strokes: { root: string; pts: [number, number][] }[] };
    const s: MarkStroke[] = f.strokes.map((x) => ({ id: x.root, points: x.pts as Point[] }));
    const marks = findMarks(s, s);
    expect(marks.map((m) => m.glyph)).toEqual(["?"]);
    expect(marks[0]!.symbol).toHaveLength(3);
  });
});
