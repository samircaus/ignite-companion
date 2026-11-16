import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IgniteClient } from "../ignite/client.js";
import type { PageRenderer } from "../ignite/renderer.js";
import type { IgnitePage, IgniteSnapshotResponse } from "../ignite/types.js";
import type { Interpretation, Interpreter } from "./interpreter.js";
import type { CommandMark, Point } from "./marks.js";
import { ACK_SVG, ackSpec, PAGE_W } from "./planner.js";
import { LivingService } from "./service.js";

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0: x0 * PAGE_W, y0: y0 * PAGE_W, x1: x1 * PAGE_W, y1: y1 * PAGE_W });
const scribble = (x0: number, y0: number, x1: number, y1: number): { points: Point[] } => ({
  points: Array.from({ length: 60 }, (_, i) => [(x0 + ((x1 - x0) * (i % 10)) / 9) * PAGE_W, (y0 + ((y1 - y0) * Math.floor(i / 10)) / 5) * PAGE_W] as Point)
});

describe("ackSpec", () => {
  it("puts the dots right of the mark when that is free", () => {
    const { spec, box: b } = ackSpec({ strokes: [], texts: [] }, box(0.4, 0.5, 0.45, 0.55), "working");
    expect(b.x).toBeCloseTo(0.465, 3);
    expect(b.y + b.h / 2).toBeCloseTo(0.525, 3);
    expect((spec.drawings as { svg: string }[])[0]!.svg).toBe(ACK_SVG);
    expect(spec.writing).toBeUndefined();
  });

  it("moves left of the mark when there is ink on the right, and stays on the page at the edge", () => {
    const left = ackSpec({ strokes: [scribble(0.46, 0.49, 0.7, 0.56)], texts: [] }, box(0.4, 0.5, 0.45, 0.55), "working");
    expect(left.box.x + left.box.w).toBeLessThanOrEqual(0.4);
    const edge = ackSpec({ strokes: [], texts: [] }, box(0.92, 0.5, 0.97, 0.55), "working");
    expect(edge.box.x + edge.box.w).toBeLessThanOrEqual(0.975);
  });

  it("writes the word failed for a turn that went wrong", () => {
    const { spec } = ackSpec({ strokes: [], texts: [] }, box(0.4, 0.5, 0.45, 0.55), "failed");
    expect((spec.writing as { text: string }[])[0]!.text).toBe("failed");
    expect(spec.drawings).toBeUndefined();
  });
});

describe("pen turn acknowledgement", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "living-ack-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const stroke = (id: string, x0: number, y0: number, x1: number, y1: number) => ({
    stroke_id: id, root_id: id, style: "pen", points: scribble(x0, y0, x1, y1).points.map(([x, y]) => ({ x, y }))
  });
  const page = { page_id: "pg1", background: { kind: "blank" }, render: {}, strokes: [stroke("u1", 0.1, 0.3, 0.35, 0.36), stroke("c1", 0.4, 0.3, 0.45, 0.35)], texts: [] } as unknown as IgnitePage;
  const snapshot: IgniteSnapshotResponse = {
    library_id: "lib", through_server_seq: 1, snapshot_sha256: "x",
    snapshot: { v: 1, library_id: "lib", page_space: { width: PAGE_W, height: 20832 }, notebooks: [{ notebook_id: "nb1", title: "Paper", pages: [page] }] }
  };
  const mark: CommandMark = { glyph: "?", circle: "c1", symbol: [], box: box(0.4, 0.3, 0.45, 0.35), selection: null, ids: ["c1"] };

  function service(interpret: () => Promise<Interpretation>) {
    const calls: { cmd: string; spec?: Record<string, unknown>; ids?: string[] }[] = [];
    let n = 0;
    const run = async (_bin: string, args: string[]) => {
      const cmd = args[0]!;
      if (cmd === "measure") {
        const items = JSON.parse(await readFile(args[1]!, "utf8")) as { text: string; width: number }[];
        return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, sizes: items.map((i) => ({ w: Math.min(i.width, 0.2), h: 0.03 })) }) };
      }
      if (cmd === "annotate") {
        const spec = JSON.parse(await readFile(args[1]!, "utf8")) as Record<string, unknown>;
        n += 1;
        calls.push({ cmd, spec });
        return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, written: true, pageId: "pg1", strokeIds: [`ai${n}a`, `ai${n}b`], textIds: [], headServerSeq: n }) };
      }
      if (cmd === "delete-ink") {
        calls.push({ cmd, ids: args.slice(1, args.indexOf("--server")) });
        return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, strokes: 2 }) };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const interpreter: Interpreter = { name: "fake", interpret };
    const s = new LivingService({
      client: { snapshot: async () => snapshot } as unknown as IgniteClient,
      renderer: { render: async (jobs: unknown[]) => jobs.map(() => ({ ok: true, ocr: { lines: [] } })) } as unknown as PageRenderer,
      importBinary: "/bin/ignite-import", serverUrl: "http://127.0.0.1:8787", tokenFile: "/dev/null", libraryId: "lib",
      stateDir: path.join(dir, "state"), vaultPath: path.join(dir, "vault"), interpreter, run
    });
    return { s, calls };
  }

  it("writes the dots before asking the AI, and removes them right before the answer", async () => {
    let callsWhenAsked = 0;
    const { s, calls } = service(async () => {
      callsWhenAsked = calls.length;
      return { understood: "a question", answer: "forty two", svg: null, needsConfirmation: false, memoryFacts: [], summaryUpdate: null };
    });
    await s.start();
    await s.memory.enable("nb1", "Paper", "General");
    const ref = await s.findPage({ pageId: "pg1" });
    const turn = await s.answerMark(ref, mark, page.strokes.map((st) => ({ id: st.stroke_id, points: st.points.map((p) => [p.x, p.y] as const) })));

    expect(callsWhenAsked).toBe(1);
    expect(calls.map((c) => c.cmd)).toEqual(["annotate", "delete-ink", "annotate"]);
    expect(calls[0]!.spec!.drawings).toBeDefined();
    expect(calls[1]!.ids).toEqual(["ai1a", "ai1b"]);
    expect((calls[2]!.spec!.writing as { text: string }[])[0]!.text).toBe("forty two");
    expect(turn.status).toBe("applied");
    expect(turn.strokeIds).toEqual(["ai2a", "ai2b"]);
    const state = JSON.parse(await readFile(path.join(dir, "state", "state.json"), "utf8")) as { acks: string[] };
    expect(state.acks).toEqual([]);
  });

  it("replaces the dots with \"failed\" when the AI gives no answer, and that note can be undone", async () => {
    const { s, calls } = service(async () => { throw new Error("usage limit"); });
    await s.start();
    await s.memory.enable("nb1", "Paper", "General");
    const ref = await s.findPage({ pageId: "pg1" });
    const turn = await s.answerMark(ref, mark, []);

    expect(calls.map((c) => c.cmd)).toEqual(["annotate", "delete-ink", "annotate"]);
    expect((calls[2]!.spec!.writing as { text: string }[])[0]!.text).toBe("failed");
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("usage limit");
    expect(turn.strokeIds).toEqual(["ai2a", "ai2b"]);
    await s.undo(turn.turnId);
    expect(calls.at(-1)).toEqual({ cmd: "delete-ink", ids: ["ai2a", "ai2b"] });
  });

  it("removes dots a stopped service left behind when it starts again", async () => {
    const first = service(async () => new Promise<Interpretation>(() => undefined));
    await first.s.start();
    await first.s.memory.enable("nb1", "Paper", "General");
    const ref = await first.s.findPage({ pageId: "pg1" });
    void first.s.answerMark(ref, mark, []);
    await new Promise((r) => setTimeout(r, 50));
    expect(first.calls.map((c) => c.cmd)).toEqual(["annotate"]);

    const second = service(async () => { throw new Error("unused"); });
    await second.s.start();
    expect(second.calls).toEqual([{ cmd: "delete-ink", ids: ["ai1a", "ai1b"] }]);
  });
});
