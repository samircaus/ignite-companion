import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageRenderer } from "./renderer.js";
import { IgniteWriter, WriterError, zshBackup, type CommandRunner, type ResolvedNotebook } from "./writer.js";

let root: string;
let vault: string;
let calls: string[][];
let renderInputs: unknown[];
let notebooks: ResolvedNotebook[];
let backupFails: boolean;
let now: Date;

const page = {
  page_id: "p1", background: { kind: "blank" }, render: { profile_version: 2, ink_byte: 0, legacy_fixed_radius: 2 },
  strokes: [{ stroke_id: "s1", root_id: "s1", style: "legacy-fixed-v1", points: [{ x: 10, y: 20, pressure: null }] }],
  texts: [{ text_id: "t1", x: 1, y: 2, width: 3, font_size: 4, face: "default-sans-v1", content: "Hi" }]
};

const run: CommandRunner = async (binary, args) => {
  calls.push([binary, ...args]);
  const write = args.includes("--confirm-write");
  const previewDir = args[args.indexOf("--preview-dir") + 1];
  if (args.includes("--preview-dir") && previewDir && !write) {
    await mkdir(previewDir, { recursive: true });
    await writeFile(path.join(previewDir, "preview.json"), JSON.stringify({ page_space: { width: 15624, height: 20832 }, notebook: { pages: [page, page] }, backgrounds: {} }));
  }
  if (args[0] === "move-notebook") {
    const folder = args.includes("--folder") ? args[args.indexOf("--folder") + 1]! : null;
    const ids = args.slice(1, args.findIndex((a) => a.startsWith("--")));
    const known = notebooks.filter((n) => ids.includes(n.notebookId));
    return { code: 0, stderr: "", stdout: JSON.stringify({
      ok: true, written: write, command: "move-notebook", notebook: { id: ids[0] },
      folder: folder === null ? null : { id: "fd-1", title: folder === "review" ? "Review" : folder, created: folder !== "review" },
      notebooks: known.filter((n) => n.notebookId !== "nb-in-review").map((n) => ({ id: n.notebookId, title: n.title, from: n.notebookId === "nb-weekly" ? "Weekly" : null })),
      unchanged: known.filter((n) => n.notebookId === "nb-in-review").map((n) => ({ id: n.notebookId, title: n.title, from: "Review" })),
      envelopes: 3, ...(write ? { headServerSeq: 2002 } : {})
    }) };
  }
  if (args[0] === "delete-notebook") {
    return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, written: write, description: `notebook "Old" (2 pages)`, ...(write ? { headServerSeq: 7 } : {}) }) };
  }
  const folder = args.includes("--folder") ? args[args.indexOf("--folder") + 1]! : null;
  return { code: 0, stderr: "", stdout: `${JSON.stringify({
    ok: true, written: write, notebook: { title: "Tasks", ...(write ? { id: "nb-new" } : {}) }, pages: 2, texts: 5, strokes: 3, blobs: 0, warnings: ["w"],
    folder: folder === null ? null : { id: folder === "Weekly" ? "fd-weekly" : "fd-new", title: folder, created: folder !== "Weekly" },
    ...(write ? { headServerSeq: 1001, strokeIds: ["s1", "s2"] } : {})
  })}\n` };
};

function writer(): IgniteWriter {
  return new IgniteWriter({
    importBinary: "/bin/ignite-import", serverUrl: "http://127.0.0.1:8787", tokenFile: "/secret/token.txt",
    stateDir: path.join(root, "state"), vaultPath: vault, mirrorFolder: "Kindle",
    renderer: new PageRenderer(async (input) => {
      renderInputs.push(JSON.parse(input));
      const jobs = (JSON.parse(input) as { jobs: unknown[] }).jobs;
      return JSON.stringify({ results: jobs.map(() => ({ ok: true })) });
    }),
    backup: async () => {
      calls.push(["backup"]);
      if (backupFails) throw new Error("disk full");
      return "/backups/pre-write/20261105-120000";
    },
    resolveNotebook: (selector) => notebooks.find((n) => n.notebookId === selector || n.title === selector),
    run,
    now: () => now
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ignite-writer-"));
  vault = path.join(root, "vault");
  await mkdir(path.join(vault, "Kindle"), { recursive: true });
  await writeFile(path.join(vault, "Tasks.md"), "# Tasks\n- [ ] one\n");
  await writeFile(path.join(vault, "Kindle", "Mirror.md"), "mirror");
  calls = [];
  renderInputs = [];
  notebooks = [{ notebookId: "nb-old", title: "Old", pageCount: 2 }];
  backupFails = false;
  now = new Date("2026-11-05T12:00:00Z");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ignite writer", () => {
  it("plans a note as a dry run with rendered previews, then writes it once after a backup", async () => {
    const w = writer();
    const plan = await w.plan({ kind: "note", notePath: "Tasks", paper: "lined", extraPages: 1 });
    expect(calls).toHaveLength(1);
    const dry = calls[0]!;
    expect(dry).not.toContain("--confirm-write");
    expect(dry.slice(1, 3)).toEqual(["note", expect.stringContaining(path.join("plans", plan.planId, "Tasks.md"))]);
    expect(dry).toEqual(expect.arrayContaining(["--paper", "lined", "--extra-pages", "1", "--token-file", "/secret/token.txt", "--json"]));
    expect(plan.summary).toBe(`Create a new Kindle notebook "Tasks" at the top level (no folder) with 2 pages (5 text blocks, 3 ink strokes) from Tasks.md. Existing notebooks are not touched.`);
    expect(plan.folder).toBeNull();
    expect(dry).not.toContain("--folder");
    expect(plan.previews.map((p) => path.basename(p.path))).toEqual(["page-01.png", "page-02.png"]);
    expect(plan.warnings).toEqual(["w"]);
    expect((renderInputs[0] as { jobs: { strokes: unknown[] }[] }).jobs).toHaveLength(2);

    // Editing the note after planning does not change what is sent.
    await writeFile(path.join(vault, "Tasks.md"), "# Changed\n");
    const result = await w.apply(plan.planId);
    expect(calls.slice(1).map((c) => c[0])).toEqual(["backup", "/bin/ignite-import"]);
    expect(calls[2]).toEqual([...dry, "--confirm-write"]);
    expect(await readFile(dry[2]!, "utf8")).toBe("# Tasks\n- [ ] one\n");
    expect(result).toMatchObject({ notebookId: "nb-new", backup: "/backups/pre-write/20261105-120000", headServerSeq: 1001 });

    await expect(w.apply(plan.planId)).rejects.toMatchObject({ status: 409 });
    expect([...(await w.sourceNotes())]).toEqual([["nb-new", "Tasks.md"]]);
    expect([...(await w.printedStrokeIds())]).toEqual(["s1", "s2"]);
    // The log survives a restart.
    expect((await writer().writes()).map((r) => r.notebookId)).toEqual(["nb-new"]);
  });

  it("files a new notebook in a folder and names the folder in the summary", async () => {
    const w = writer();
    const existing = await w.plan({ kind: "note", notePath: "Tasks.md", folder: " Weekly " });
    expect(calls[0]).toEqual(expect.arrayContaining(["--folder", "Weekly"]));
    expect(existing.summary).toContain(`"Tasks" in folder "Weekly" with 2 pages`);
    expect(existing.folder).toEqual({ title: "Weekly", created: false });
    const created = await w.plan({ kind: "note", notePath: "Tasks.md", folder: "Review" });
    expect(created.summary).toContain(`in a new folder "Review" (created by this write)`);
    expect(created.folder).toEqual({ title: "Review", created: true });
    await w.apply(created.planId);
    expect((await w.writes()).at(-1)).toMatchObject({ kind: "note", notebookId: "nb-new", folder: "Review" });
    await expect(w.plan({ kind: "note", notePath: "Tasks.md", folder: "  " })).rejects.toMatchObject({ status: 400 });
    await expect(w.plan({ kind: "note", notePath: "Tasks.md", folder: "x".repeat(97) })).rejects.toMatchObject({ status: 400 });
    await expect(w.plan({ kind: "notebook", spec: { notebook: { title: "S", folder: 7 }, pages: [{}] } })).rejects.toMatchObject({ status: 400 });
  });

  it("moves notebooks into a folder: plan, backup, apply once, only what was resolved", async () => {
    notebooks = [
      { notebookId: "nb-a", title: "Project Review", pageCount: 9 },
      { notebookId: "nb-weekly", title: "Week 12", pageCount: 6 },
      { notebookId: "nb-in-review", title: "Quarterly Check-in", pageCount: 6 }
    ];
    const w = writer();
    const plan = await w.plan({ kind: "move-notebook", notebooks: ["Project Review", "Week 12", "nb-a", "Quarterly Check-in"], folder: "Review " });
    const dry = calls[0]!;
    expect(dry.slice(1, 7)).toEqual(["move-notebook", "nb-a", "nb-weekly", "nb-in-review", "--folder", "Review"]);
    expect(dry).not.toContain("--confirm-write");
    expect(dry).not.toContain("--preview-dir");
    expect(plan.summary).toBe(`Move 2 Kindle notebooks into a new folder "Review" (created by this write): "Project Review", "Week 12" (now in folder "Weekly"). Already there: "Quarterly Check-in". Only folder membership changes; pages and ink are not touched.`);
    expect(plan.folder).toEqual({ title: "Review", created: true });
    expect(plan.notebooks).toEqual([
      { notebookId: "nb-a", title: "Project Review", from: null },
      { notebookId: "nb-weekly", title: "Week 12", from: "Weekly" }
    ]);
    expect(plan.previews).toEqual([]);

    const result = await w.apply(plan.planId);
    expect(calls.slice(1).map((c) => c[0])).toEqual(["backup", "/bin/ignite-import"]);
    expect(calls[2]).toEqual([...dry, "--confirm-write"]);
    expect(result).toMatchObject({ kind: "move-notebook", headServerSeq: 2002, backup: "/backups/pre-write/20261105-120000" });
    expect(result.note).toContain("Kindle/<Folder>/");
    expect((await w.writes()).at(-1)).toMatchObject({ kind: "move-notebook", folder: "Review", notebookIds: ["nb-a", "nb-weekly"] });
    await expect(w.apply(plan.planId)).rejects.toMatchObject({ status: 409 });

    const back = await w.plan({ kind: "move-notebook", notebooks: ["Week 12"], folder: null });
    expect(calls.at(-1)!.slice(1, 4)).toEqual(["move-notebook", "nb-weekly", "--top-level"]);
    expect(back.summary).toMatch(/^Move 1 Kindle notebook to the top level \(no folder\): "Week 12"/);
    expect(back.folder).toBeNull();

    // A notebook that disappears after planning stops the move before any backup.
    const stale = await w.plan({ kind: "move-notebook", notebooks: ["nb-a"], folder: "review" });
    expect(stale.summary).toContain(`into folder "Review":`);
    notebooks = notebooks.filter((n) => n.notebookId !== "nb-a");
    const backups = calls.filter((c) => c[0] === "backup").length;
    await expect(w.apply(stale.planId)).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c[0] === "backup")).toHaveLength(backups);

    await expect(w.plan({ kind: "move-notebook", notebooks: ["Nope"], folder: "Review" })).rejects.toMatchObject({ status: 404 });
    await expect(w.plan({ kind: "move-notebook", notebooks: [], folder: "Review" })).rejects.toMatchObject({ status: 400 });
    await expect(w.plan({ kind: "move-notebook", notebooks: ["Week 12"], folder: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("sends nothing when the ledger backup fails", async () => {
    const w = writer();
    const plan = await w.plan({ kind: "note", notePath: "Tasks.md" });
    backupFails = true;
    await expect(w.apply(plan.planId)).rejects.toThrow(/backup failed, nothing was sent: disk full/);
    expect(calls.filter((c) => c.includes("--confirm-write"))).toHaveLength(0);
    expect(w.getPlan(plan.planId)?.appliedAt).toBeNull();
  });

  it("refuses notes outside the vault and the Kindle mirror itself", async () => {
    const w = writer();
    await expect(w.plan({ kind: "note", notePath: "../outside.md" })).rejects.toBeInstanceOf(WriterError);
    await expect(w.plan({ kind: "note", notePath: "Kindle/Mirror.md" })).rejects.toThrow(/mirrors of Kindle notebooks/);
    await expect(w.plan({ kind: "note", notePath: "Missing.md" })).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("expires plans", async () => {
    const w = writer();
    const plan = await w.plan({ kind: "note", notePath: "Tasks.md" });
    now = new Date(now.getTime() + 31 * 60_000);
    await expect(w.apply(plan.planId)).rejects.toMatchObject({ status: 410 });
    await expect(w.apply("000000000000")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes only the notebook that was resolved when planning", async () => {
    const w = writer();
    const plan = await w.plan({ kind: "delete-notebook", notebook: "Old" });
    expect(calls[0]!.slice(1, 3)).toEqual(["delete-notebook", "nb-old"]);
    expect(plan.summary).toContain(`Delete notebook "Old" (2 pages)`);
    await expect(w.plan({ kind: "delete-page", notebook: "Old", page: 3 })).rejects.toThrow(/page must be 1..2/);
    notebooks = [];
    await expect(w.apply(plan.planId)).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c[0] === "backup")).toHaveLength(0);
  });

  it("surfaces ignite-import's own refusal (e.g. chrome bands)", async () => {
    const w = new IgniteWriter({
      importBinary: "/bin/ignite-import", serverUrl: "http://127.0.0.1:8787", tokenFile: "/t", stateDir: path.join(root, "s2"), vaultPath: vault, mirrorFolder: "Kindle",
      renderer: new PageRenderer(async () => "{}"), backup: async () => "/b", resolveNotebook: () => undefined,
      run: async () => ({ code: 1, stderr: "", stdout: JSON.stringify({ ok: false, error: "page 1 stroke 2 at y=0.02 reaches into Ignite's reserved top/bottom band" }) })
    });
    await expect(w.plan({ kind: "notebook", spec: { notebook: { title: "x" }, pages: [{}] } })).rejects.toThrow(/reserved top\/bottom band/);
  });
});

describe("zsh backup", () => {
  it("returns the backup directory from backup.zsh output and fails loudly otherwise", async () => {
    const ok = zshBackup("/b.zsh", "/data", "/root", 30, async (_bin, args) => {
      expect(args).toEqual(["/data", "/root", "30"]);
      return { code: 0, stderr: "", stdout: "20261105-120000 ok operations=1001 size=24M -> /root/20261105-120000\n" };
    });
    expect(await ok()).toBe("/root/20261105-120000");
    const bad = zshBackup("/b.zsh", "/data", "/root", 30, async () => ({ code: 1, stderr: "integrity_check failed", stdout: "" }));
    await expect(bad()).rejects.toThrow(/integrity_check failed/);
  });
});
