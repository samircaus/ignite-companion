import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BEGIN_MARKER, END_MARKER, imageVaultPath, mergeNote, renderBlock, safeSegment, VaultMirror, type MirrorNotebook } from "./vault-mirror.js";

let vault: string;
let cache: string;

beforeEach(async () => {
  vault = await mkdtemp(path.join(os.tmpdir(), "ignite-vault-"));
  cache = await mkdtemp(path.join(os.tmpdir(), "ignite-cache-"));
});
afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

async function png(hash: string): Promise<string> {
  const filename = path.join(cache, `${hash}.png`);
  await writeFile(filename, `png-${hash}`);
  return filename;
}

async function notebook(title: string, pages: { hash: string; text?: string; strokes?: number }[], id = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"): Promise<MirrorNotebook> {
  return {
    notebookId: id,
    title,
    pages: await Promise.all(pages.map(async (page, index) => ({
      number: index + 1,
      pageId: `page-${index}`,
      contentHash: page.hash,
      strokeCount: page.strokes ?? 3,
      image: { vaultPath: imageVaultPath("Kindle", id, { number: index + 1, contentHash: page.hash }), sourcePath: await png(page.hash) },
      transcription: page.text,
      typedText: []
    })))
  };
}

describe("ignite vault mirror", () => {
  it("writes one note per notebook with page images and transcriptions", async () => {
    const mirror = new VaultMirror(vault);
    const result = await mirror.apply([await notebook("Ideas / 2026", [{ hash: "a".repeat(64), text: "WHY RANDOM\nBOXES" }])], new Date("2026-11-05T10:00:00Z"));
    expect(result.written).toEqual(["Kindle/Ideas - 2026.md"]);
    const note = await readFile(path.join(vault, "Kindle", "Ideas - 2026.md"), "utf8");
    expect(note).toMatch(/^---\nsource: "kindle"\nignite_notebook_id: "0190aaaa/);
    expect(note).toContain("tags:\n  - \"kindle\"");
    expect(note).toContain("![[Kindle/_pages/eeeeeeeeeeee/p01-aaaaaaaaaa.png]]");
    expect(note).toContain("> WHY RANDOM\n> BOXES");
    expect(await readdir(path.join(vault, "Kindle", "_pages", "eeeeeeeeeeee"))).toEqual(["p01-aaaaaaaaaa.png"]);
  });

  it("preserves the user's own notes and frontmatter across updates", async () => {
    const mirror = new VaultMirror(vault);
    await mirror.apply([await notebook("Journal", [{ hash: "a".repeat(64), text: "first" }])]);
    const file = path.join(vault, "Kindle", "Journal.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("---\n", "---\nrating: 5\n") + "\n## My thoughts\nKeep this.\n");
    const second = await mirror.apply([await notebook("Journal", [{ hash: "b".repeat(64), text: "second" }])]);
    expect(second.written).toEqual(["Kindle/Journal.md"]);
    const note = await readFile(file, "utf8");
    expect(note).toContain("rating: 5");
    expect(note).toContain("## My thoughts\nKeep this.");
    expect(note).toContain("> second");
    expect(note).not.toContain("> first");
    // Old page image is removed because the mirror wrote it; the new one exists.
    expect(await readdir(path.join(vault, "Kindle", "_pages", "eeeeeeeeeeee"))).toEqual(["p01-bbbbbbbbbb.png"]);
  });

  it("does not rewrite unchanged notebooks", async () => {
    const mirror = new VaultMirror(vault);
    const input = await notebook("Same", [{ hash: "c".repeat(64), text: "x" }]);
    await mirror.apply([input]);
    const again = await mirror.apply([input]);
    expect(again.written).toEqual([]);
    expect(again.unchanged).toBe(1);
  });

  it("renames the note when the notebook is renamed, keeping user content", async () => {
    const mirror = new VaultMirror(vault);
    await mirror.apply([await notebook("Old name", [{ hash: "d".repeat(64), text: "x" }])]);
    await writeFile(path.join(vault, "Kindle", "Old name.md"), (await readFile(path.join(vault, "Kindle", "Old name.md"), "utf8")) + "\nmine\n");
    const result = await mirror.apply([await notebook("New name", [{ hash: "d".repeat(64), text: "x" }])]);
    expect(result.renamed).toEqual([{ from: "Kindle/Old name.md", to: "Kindle/New name.md" }]);
    const note = await readFile(path.join(vault, "Kindle", "New name.md"), "utf8");
    expect(note).toContain("# New name");
    expect(note).toContain("\nmine\n");
  });

  it("never overwrites a note whose generated markers were removed", async () => {
    const mirror = new VaultMirror(vault);
    await mirror.apply([await notebook("Edited", [{ hash: "e".repeat(64), text: "x" }])]);
    const file = path.join(vault, "Kindle", "Edited.md");
    await writeFile(file, "---\nsource: \"kindle\"\nignite_notebook_id: \"0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\"\n---\nI rewrote all of this by hand.\n");
    const result = await mirror.apply([await notebook("Edited", [{ hash: "f".repeat(64), text: "y" }])]);
    expect(result.conflicts).toHaveLength(1);
    expect(await readFile(file, "utf8")).toContain("I rewrote all of this by hand.");
  });

  it("avoids clobbering an unrelated note with the same name", async () => {
    await mkdir(path.join(vault, "Kindle"), { recursive: true });
    await writeFile(path.join(vault, "Kindle", "Notebook 1.md"), "someone else's note\n");
    const mirror = new VaultMirror(vault);
    const result = await mirror.apply([await notebook("Notebook 1", [{ hash: "1".repeat(64), text: "x" }])]);
    expect(result.written).toEqual(["Kindle/Notebook 1 (2).md"]);
    expect(await readFile(path.join(vault, "Kindle", "Notebook 1.md"), "utf8")).toBe("someone else's note\n");
  });

  it("marks notebooks deleted on the Kindle and keeps their note", async () => {
    const mirror = new VaultMirror(vault);
    await mirror.apply([await notebook("Gone", [{ hash: "2".repeat(64), text: "x" }])]);
    const result = await mirror.apply([], new Date("2026-11-06T00:00:00Z"));
    expect(result.deleted).toEqual(["Kindle/Gone.md"]);
    const note = await readFile(path.join(vault, "Kindle", "Gone.md"), "utf8");
    expect(note).toContain("deleted on the Kindle (2026-11-06)");
    expect(note).toContain("ignite_deleted:");
    expect(await readdir(path.join(vault, "Kindle", "_pages", "eeeeeeeeeeee"))).toHaveLength(1);
  });

  it("keeps page folders apart for notebooks created at the same moment", () => {
    const a = imageVaultPath("Kindle", "01a1a874-0000-7000-8000-00000000000a", { number: 1, contentHash: "f".repeat(64) });
    const b = imageVaultPath("Kindle", "01a1a874-0000-7000-8000-00000000000b", { number: 1, contentHash: "f".repeat(64) });
    expect(a).not.toBe(b);
  });

  it("rejects folder names that could escape the vault", () => {
    expect(() => new VaultMirror(vault, "../outside")).toThrow();
    expect(safeSegment("../../etc", "x")).toBe("etc");
    expect(safeSegment("..", "fallback")).toBe("fallback");
  });
});

describe("generated block", () => {
  it("describes blank, drawing-only and failed pages honestly", () => {
    const block = renderBlock({ notebookId: "n", title: "T", pages: [
      { number: 1, pageId: "a", contentHash: "h1", strokeCount: 0, image: { vaultPath: "Kindle/a.png", sourcePath: "" }, transcription: "", typedText: [] },
      { number: 2, pageId: "b", contentHash: "h2", strokeCount: 4, image: { vaultPath: "Kindle/b.png", sourcePath: "" }, transcription: "", typedText: [] },
      { number: 3, pageId: "c", contentHash: "h3", strokeCount: 4, image: undefined, transcription: undefined, typedText: ["Typed"] }
    ] });
    expect(block.startsWith(BEGIN_MARKER)).toBe(true);
    expect(block.endsWith(END_MARKER)).toBe(true);
    expect(block).toContain("*No handwriting on this page.*");
    expect(block).toContain("drawing only");
    expect(block).toContain("Page image unavailable");
    expect(block).toContain("Handwriting transcription unavailable");
    expect(block).toContain("**Typed text**\n\nTyped");
  });

  it("links notebooks sent from the vault back to their note instead of repeating its text", () => {
    const block = renderBlock({ notebookId: "n", title: "Tasks", sourceNote: "Work/Tasks.md", pages: [
      { number: 1, pageId: "a", contentHash: "h1", strokeCount: 0, image: { vaultPath: "Kindle/a.png", sourcePath: "" }, transcription: "", typedText: ["Typed copy of the note"] },
      { number: 2, pageId: "b", contentHash: "h2", strokeCount: 2, image: { vaultPath: "Kindle/b.png", sourcePath: "" }, transcription: "done!", typedText: ["More"] }
    ] });
    expect(block).toContain("Sent to the Kindle from [[Work/Tasks]]");
    expect(block).not.toContain("Typed copy of the note");
    expect(block).toContain("*No handwriting added yet.*");
    expect(block).toContain("> done!");
  });

  it("merges into a note whose frontmatter has list continuation lines", () => {
    const existing = `---\naliases:\n  - a\nsource: "old"\ntags:\n  - mine\n---\nintro\n${BEGIN_MARKER}\nold\n${END_MARKER}\noutro\n`;
    const merged = mergeNote(existing, { source: "kindle", ignite_pages: 2 }, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);
    expect("content" in merged && merged.content).toBe(`---\nsource: "kindle"\nignite_pages: 2\naliases:\n  - a\ntags:\n  - mine\n---\nintro\n${BEGIN_MARKER}\nnew\n${END_MARKER}\noutro\n`);
  });
});
