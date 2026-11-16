import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgniteBridge, resolveNotebook } from "./bridge.js";
import type { IgniteClient } from "./client.js";
import { nativeJob, pageContentHash, PageRenderer, strokeRadius } from "./renderer.js";
import type { IgnitePage, IgniteSnapshotResponse } from "./types.js";
import { VaultMirror } from "./vault-mirror.js";

const profile = { profile_version: 2, ink_byte: 0, legacy_fixed_radius: 2, pressure: { q_r1_max: 820, q_r2_max: 2866, q_r3_max: 3685, min_radius: 1, max_radius: 4, missing_fallback_radius: 2 } };

function page(id: string, strokeIds: string[]): IgnitePage {
  return {
    page_id: id,
    background: { kind: "blank" },
    render: profile,
    strokes: strokeIds.map((stroke) => ({ stroke_id: stroke, root_id: stroke, style: "pressure-width-v1", points: [{ x: 100, y: 200, pressure: 0.5 }, { x: 300, y: 400, pressure: 0.95 }] }))
  };
}

function snapshot(seq: number, pages: IgnitePage[]): IgniteSnapshotResponse {
  return {
    library_id: "lib", through_server_seq: seq, snapshot_sha256: "x",
    snapshot: { v: 1, library_id: "lib", page_space: { width: 15624, height: 20832 }, notebooks: [{ notebook_id: "0190aaaa-0000-7000-8000-000000000001", title: "Notebook 1", pages }] }
  };
}

describe("renderer mapping", () => {
  it("follows Ignite's sealed pressure bands", () => {
    expect(strokeRadius(0.1, profile, "pressure-width-v1")).toBe(1);
    expect(strokeRadius(0.5, profile, "pressure-width-v1")).toBe(2);
    expect(strokeRadius(0.85, profile, "pressure-width-v1")).toBe(3);
    expect(strokeRadius(0.95, profile, "pressure-width-v1")).toBe(4);
    expect(strokeRadius(undefined, profile, "pressure-width-v1")).toBe(2);
    expect(strokeRadius(0.95, profile, "legacy-fixed-v1")).toBe(2);
  });

  it("hashes page content by visible stroke identity", () => {
    expect(pageContentHash(page("p", ["s1", "s2"]))).toBe(pageContentHash(page("p", ["s1", "s2"])));
    expect(pageContentHash(page("p", ["s1", "s2"]))).not.toBe(pageContentHash(page("p", ["s1"])));
  });

  it("flattens points into x, y, radius triples", () => {
    const job = nativeJob({ page: page("p", ["s1"]), pageSpace: { width: 15624, height: 20832 } }) as { strokes: { points: number[] }[] };
    expect(job.strokes[0]!.points).toEqual([100, 200, 2, 300, 400, 4]);
  });
});

describe("ignite bridge", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "ignite-bridge-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function setup(state: { seq: number; snap: IgniteSnapshotResponse }, extra: Partial<ConstructorParameters<typeof IgniteBridge>[0]> = {}) {
    let renders = 0;
    const ocrInputs: number[] = [];
    const client = {
      libraries: async () => [{ library_id: "lib", head_server_seq: state.seq, snapshot_sha256: "x", notebook_count: 1, page_count: state.snap.snapshot.notebooks[0]!.pages.length }],
      snapshot: async () => state.snap,
      blob: async () => Buffer.alloc(0)
    } as unknown as IgniteClient;
    const renderer = new PageRenderer(async (input) => {
      const { jobs } = JSON.parse(input) as { jobs: { png: string | null; ocr: unknown; strokes: { ocr?: boolean }[] }[] };
      renders += jobs.length;
      ocrInputs.push(...jobs.filter((job) => job.ocr).map((job) => job.strokes.filter((stroke) => stroke.ocr !== false).length));
      for (const job of jobs) if (job.png) await writeFile(job.png, "png");
      return JSON.stringify({ results: jobs.map((job) => ({ ok: true, png: job.png, ...(job.ocr ? { ocr: { text: `TEXT ${job.strokes.length}`, lines: [] } } : {}) })) });
    });
    const bridge = new IgniteBridge({ client, renderer, mirror: new VaultMirror(path.join(dir, "vault")), stateDir: path.join(dir, "state"), pollMs: 60_000, ...extra });
    return { bridge, renders: () => renders, ocrInputs };
  }

  it("mirrors, waits for a quiet interval, and only re-renders changed pages", async () => {
    const state = { seq: 10, snap: snapshot(10, [page("p1", ["a"]), page("p2", ["b"])]) };
    const { bridge, renders } = setup(state);
    await bridge.sync({ force: true });
    expect(renders()).toBe(2);
    expect(await readFile(path.join(dir, "vault", "Kindle", "Notebook 1.md"), "utf8")).toContain("> TEXT 1");
    expect(bridge.page({ notebook: "notebook 1", number: 2 })?.transcription).toBe("TEXT 1");

    state.seq = 11;
    state.snap = snapshot(11, [page("p1", ["a"]), page("p2", ["b", "c"])]);
    await bridge.sync();
    expect(bridge.status().state).toBe("waiting-for-quiet");
    expect(renders()).toBe(2);
    await bridge.sync();
    expect(renders()).toBe(3);
    expect(bridge.status().exportedSeq).toBe(11);
    expect(bridge.page({ notebook: "0", number: 2 })?.transcription).toBe("TEXT 2");
    await bridge.sync();
    expect(bridge.status().state).toBe("idle");
  });

  it("does not transcribe ink the Mac drew, and links sent notebooks to their source note", async () => {
    const state = { seq: 5, snap: snapshot(5, [page("p1", ["box1", "box2"]), page("p2", ["box3", "hand"])]) };
    const { bridge, ocrInputs } = setup(state, {
      printedStrokes: async () => new Set(["box1", "box2", "box3"]),
      sourceNotes: async () => new Map([["0190aaaa-0000-7000-8000-000000000001", "Work/Plan.md"]])
    });
    await bridge.sync({ force: true });
    expect(ocrInputs).toEqual([1]);
    const note = await readFile(path.join(dir, "vault", "Kindle", "Notebook 1.md"), "utf8");
    expect(note).toContain("Sent to the Kindle from [[Work/Plan]]");
    expect(note).toContain("*No handwriting added yet.*");
    expect(bridge.findNotebook("notebook 1")).toEqual({ notebookId: "0190aaaa-0000-7000-8000-000000000001", title: "Notebook 1", pageCount: 2 });
  });

  it("resolves notebooks by id, title, index or a unique partial title", () => {
    const notebooks = snapshot(1, []).snapshot.notebooks;
    expect(resolveNotebook(notebooks, "0190aaaa-0000-7000-8000-000000000001")).toBe(0);
    expect(resolveNotebook(notebooks, "NOTEBOOK 1")).toBe(0);
    expect(resolveNotebook(notebooks, "0")).toBe(0);
    expect(resolveNotebook(notebooks, "book")).toBe(0);
    expect(resolveNotebook(notebooks, "missing")).toBeUndefined();
  });
});
