import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IgniteClient } from "../ignite/client.js";
import type { IgniteOperation } from "../ignite/types.js";
import { buildPrompt, fontSafe, parseInterpretation } from "./interpreter.js";
import type { Point } from "./marks.js";
import { LivingMemory, section, setSection } from "./memory.js";
import { PAGE_W, placeAnswer, SAFE_BOTTOM, SAFE_TOP, svgAspect, type Measure } from "./planner.js";
import { LivingWatcher } from "./watcher.js";

// Rough stand-in for ignite-import measure: 0.55 × size per character, wrapped to the width.
const measure: Measure = async (items) => items.map(({ text, width }) => {
  const perLine = Math.max(1, Math.floor(width / (0.017 * 0.55)));
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return { w: Math.min(width, text.length * 0.017 * 0.55), h: (lines - 1) * 0.0289 + 0.0238 };
});

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0: x0 * PAGE_W, y0: y0 * PAGE_W, x1: x1 * PAGE_W, y1: y1 * PAGE_W });
const scribble = (x0: number, y0: number, x1: number, y1: number): { points: Point[] } => ({
  points: Array.from({ length: 60 }, (_, i) => [(x0 + ((x1 - x0) * (i % 10)) / 9) * PAGE_W, (y0 + ((y1 - y0) * Math.floor(i / 10)) / 5) * PAGE_W] as Point)
});

describe("placeAnswer", () => {
  it("puts a short answer in free space next to the mark, clear of existing ink and the chrome bands", async () => {
    const ink = { strokes: [scribble(0.1, 0.2, 0.6, 0.35), scribble(0.1, 0.5, 0.9, 0.8)], texts: [] };
    const p = await placeAnswer({ ink, anchor: box(0.62, 0.3, 0.66, 0.34), about: box(0.1, 0.2, 0.6, 0.35), answer: { text: "Three short ideas\n1. one\n2. two" }, measure });
    expect(p.where).toBe("page");
    const b = p.box;
    expect(b.y).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(b.y + b.h).toBeLessThanOrEqual(SAFE_BOTTOM);
    // Does not overlap the second block of ink (0.5–0.8).
    expect(b.y + b.h <= 0.5 - 0.01 || b.y >= 0.8).toBe(true);
    // In the gap right below what was circled (0.35–0.5), not somewhere far away.
    expect(b.y).toBeGreaterThan(0.35);
    expect(b.y + b.h).toBeLessThan(0.5);
    expect(p.spec).toMatchObject({ writing: [{ text: "Three short ideas\n1. one\n2. two" }] });
    expect(p.spec).not.toHaveProperty("new_page");
  });

  it("goes to a new page, linked from next to the mark, when the page is full", async () => {
    const full = { strokes: Array.from({ length: 12 }, (_, i) => scribble(0.04, 0.07 + i * 0.1, 0.96, 0.07 + i * 0.1 + 0.09)), texts: [] };
    const p = await placeAnswer({ ink: full, anchor: box(0.5, 0.6, 0.55, 0.65), answer: { text: "An answer", svg: "<svg viewBox='0 0 200 100'><rect x='1' y='1' width='50' height='20'/></svg>" }, measure });
    expect(p.where).toBe("new-page");
    expect(p.spec).toMatchObject({ new_page: { link_from: [0.58, 0.625] } });
    const drawing = (p.spec.drawings as { width: number; y: number }[])[0]!;
    expect(drawing.width).toBeLessThanOrEqual(0.6);
    expect(svgAspect("<svg viewBox='0 0 200 100'>")).toBe(0.5);
  });

  it("refuses an answer that would not fit even a fresh page", async () => {
    await expect(placeAnswer({ ink: { strokes: [], texts: [] }, anchor: box(0.5, 0.5, 0.52, 0.52), answer: { text: Array.from({ length: 60 }, () => "line").join("\n") }, measure, forceNewPage: true })).rejects.toThrow(/too long/);
  });
});

describe("interpreter output", () => {
  it("keeps only characters the handwriting font draws", () => {
    expect(fontSafe("**Idea** – “quoted” → café… 😀 [x]\n# Head")).toBe("Idea - \"quoted\" → cafe... (x)\nHead");
    expect(fontSafe("Größe: 3,50 €")).toBe("Größe: 3,50 €");
  });

  it("parses the model's JSON, cleaning the answer and ignoring a non-SVG drawing", () => {
    const i = parseInterpretation(`Sure!\n{"understood":"expand","answer":"1. A\\n2. B 🚀","svg":"not svg","needs_confirmation":false,"memory_facts":["Hero is Ada",""],"summary_update":null}`);
    expect(i).toEqual({ understood: "expand", answer: "1. A\n2. B", svg: null, needsConfirmation: false, memoryFacts: ["Hero is Ada"], summaryUpdate: null });
  });

  it("tells the model what the mark means and where it is", () => {
    const prompt = buildPrompt({ glyph: "+", notebookTitle: "Ideas", pageNumber: 2, pageCount: 3, pageImage: "/p.png", focusImage: "/f.png", markBox: [0.5, 0.5, 0.55, 0.55], aboutBox: null, nearbyText: "AI on demand", profileName: "Thinking", profileInstructions: "Develop ideas.", notebookInstructions: "", memory: "", summary: "", lineChars: 34 });
    expect(prompt).toContain("EXPAND (+)");
    expect(prompt).toContain("AI on demand");
    expect(prompt).toContain("Develop ideas.");
  });
});

describe("LivingMemory", () => {
  let vault: string;
  beforeEach(async () => { vault = await mkdtemp(path.join(os.tmpdir(), "living-vault-")); });
  afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

  it("enables by note or by folder, picks the profile, and records turns into the note", async () => {
    const m = new LivingMemory(vault, () => new Date("2026-11-15T20:00:00Z"));
    await m.ensureDefaults();
    expect((await m.forNotebook("nb1", "Paper test", null)).enabled).toBe(false);
    const byFolder = await m.forNotebook("nb2", "Ideas", "thinking");
    expect(byFolder).toMatchObject({ enabled: true, profile: { name: "Thinking" } });
    await m.enable("nb1", "Paper test");
    expect(await m.forNotebook("nb1", "Paper test", null)).toMatchObject({ enabled: true, profile: { name: "General" }, notePath: "Living Notebooks/Paper test.md" });
    await m.record({ notebookId: "nb1", title: "Paper test", profile: "General", logLine: "p1 (+) expand the idea", facts: ["The project is called Living Notebooks"], summary: "Testing AI ink." });
    await m.record({ notebookId: "nb1", title: "Paper test", profile: "General", logLine: "p2 (?) what next", facts: ["The project is called Living Notebooks"], summary: null });
    const note = await readFile(path.join(vault, "Living Notebooks", "Paper test.md"), "utf8");
    expect(note).toMatch(/^---\nignite_notebook_id: "nb1"/);
    expect(section(note, "Memory")).toBe("- ★ The project is called Living Notebooks");
    expect(section(note, "Summary")).toBe("Testing AI ink.");
    expect(section(note, "Log").split("\n")).toEqual(["- 2026-11-15 20:00 p1 (+) expand the idea", "- 2026-11-15 20:00 p2 (?) what next"]);
    const mem = await m.forNotebook("nb1", "Renamed", null);
    expect(mem.memory).toContain("Living Notebooks");
  });

  it("never overwrites a profile the user edited", async () => {
    await mkdir(path.join(vault, "Living Notebooks", "_profiles"), { recursive: true });
    await writeFile(path.join(vault, "Living Notebooks", "_profiles", "Thinking.md"), "---\nmatch_folder: \"Ideas\"\n---\nMine.\n");
    const m = new LivingMemory(vault);
    await m.ensureDefaults();
    const profiles = await m.profiles();
    expect(profiles.find((p) => p.name === "Thinking")).toEqual({ name: "Thinking", matchFolder: "Ideas", instructions: "Mine." });
    expect(setSection("## A\n\nx\n\n## B\n\ny\n", "A", "z")).toBe("## A\n\nz\n\n## B\n\ny\n");
  });
});

describe("LivingWatcher", () => {
  const circle = (cx: number, cy: number, r: number): Point[] => Array.from({ length: 60 }, (_, i) => [cx + r * Math.cos((i / 59) * 2 * Math.PI * 0.95), cy + r * Math.sin((i / 59) * 2 * Math.PI * 0.95)] as Point);
  const stroke = (id: string, points: Point[]) => ({ stroke_id: id, root_id: id, style: "pressure-width-v1", points: points.map(([x, y]) => ({ x, y, pressure: 0.5 })) });
  const add = (seq: number, id: string, points: Point[], replica = "kindle"): IgniteOperation => ({ server_seq: seq, envelope: { replica_id: replica, operation: { type: "add_stroke", notebook_id: "nb", page_id: "pg", stroke: stroke(id, points) } } });

  it("fires once per mark after the page has been quiet, and ignores the AI's own ink", async () => {
    let now = 0;
    let ops: IgniteOperation[] = [];
    const client = { operations: async (_lib: string, after: number) => ({ library_id: "lib", head_server_seq: 10, operations: ops.filter((o) => o.server_seq > after), next_after: Math.max(after, ...ops.map((o) => o.server_seq)) }) } as unknown as IgniteClient;
    let cursor: number | null = 0;
    const consumed = new Set<string>();
    const checks: string[][] = [];
    const w = new LivingWatcher({
      client, libraryId: async () => "lib", ownReplicas: async () => new Set(["ai"]),
      cursor: async () => cursor, setCursor: async (s) => { cursor = s; }, consumed: async () => consumed,
      check: async (_page, fresh) => {
        checks.push(fresh.map((s) => s.id));
        fresh.forEach((s) => consumed.add(s.id));
        return [{ markIds: fresh.map((s) => s.id) } as never];
      },
      now: () => now
    });
    // A (+) in a circle, plus an AI stroke that must not count.
    ops = [
      add(1, "v", [[5000, 5000], [5000, 5450]]),
      add(2, "h", [[4780, 5225], [5220, 5225]]),
      add(3, "c", circle(5000, 5225, 480)),
      add(4, "ai", circle(9000, 9000, 480), "ai")
    ];
    await w.tick();
    expect(checks).toHaveLength(0); // not quiet yet
    now = 6000;
    await w.tick();
    expect(checks).toEqual([["v", "h", "c"]]);
    expect(cursor).toBe(4);
    now = 20_000;
    await w.tick();
    expect(checks).toHaveLength(1); // consumed: never twice
  });
});
