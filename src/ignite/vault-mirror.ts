import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Mirrors Kindle (Ignite) notebooks into the Obsidian vault as ordinary Markdown + PNG pages.
 *
 * Ownership rules, so the vault stays the user's:
 * - One note per notebook under `<folder>/` (Ignite folders become subfolders).
 * - Only the text between `<!-- ignite:begin` and `<!-- ignite:end -->` and the `source`/`ignite_*`
 *   frontmatter keys are generated. Anything else the user writes in that note is preserved.
 * - If the markers were removed, the note is left alone and reported as a conflict.
 * - Page images live under `<folder>/_pages/<notebook>/`; only files this mirror wrote (listed in
 *   `<folder>/.ignite-mirror.json`) are ever removed.
 * - A notebook deleted on the Kindle keeps its note and images; the note is marked deleted.
 */

export const BEGIN_MARKER = "<!-- ignite:begin · generated from the Kindle on every sync; write your own notes below the end marker -->";
export const END_MARKER = "<!-- ignite:end -->";
const OWNED_KEYS = new Set(["source", "ignite_notebook_id", "ignite_folder", "ignite_pages", "ignite_updated", "ignite_deleted"]);
const MANIFEST = ".ignite-mirror.json";

export interface MirrorPage {
  number: number;
  pageId: string;
  contentHash: string;
  strokeCount: number;
  /** Vault-relative image path, or undefined when rendering failed. */
  image?: { vaultPath: string; sourcePath: string } | undefined;
  /** undefined = recognition failed or pending; "" = nothing recognised. */
  transcription?: string | undefined;
  typedText: string[];
}

export interface MirrorNotebook {
  notebookId: string;
  title: string;
  folderTitle?: string | undefined;
  /** Vault path of the note this notebook was sent from (Mac → Kindle), if any. */
  sourceNote?: string | undefined;
  pages: MirrorPage[];
}

interface ManifestEntry { notePath: string; blockHash: string; images: string[]; deletedAt?: string }
interface Manifest { v: 1; notebooks: Record<string, ManifestEntry> }

export interface MirrorResult {
  written: string[];
  unchanged: number;
  renamed: { from: string; to: string }[];
  deleted: string[];
  conflicts: { notePath: string; reason: string }[];
}

export function safeSegment(value: string, fallback: string): string {
  const cleaned = value.normalize("NFC").replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^[.\s-]+|[.\s]+$/g, "").slice(0, 120).trim();
  return cleaned || fallback;
}

export function imageVaultPath(folder: string, notebookId: string, page: { number: number; contentHash: string }): string {
  // Ignite ids are UUIDv7 (time first): the random tail keeps notebooks created together apart.
  return `${folder}/_pages/${notebookId.replace(/-/g, "").slice(-12)}/p${String(page.number).padStart(2, "0")}-${page.contentHash.slice(0, 10)}.png`;
}

export function renderBlock(notebook: MirrorNotebook): string {
  const lines = [BEGIN_MARKER, `# ${notebook.title}`, ""];
  const pages = notebook.pages.length;
  lines.push(`Kindle Scribe notebook · ${pages} ${pages === 1 ? "page" : "pages"}${notebook.folderTitle ? ` · folder ${notebook.folderTitle}` : ""}`, "");
  if (notebook.sourceNote) {
    // The typed text is the source note itself; only what was written by hand is new here.
    lines.push(`Sent to the Kindle from [[${notebook.sourceNote.replace(/\.md$/, "")}]]. Handwriting added on the Kindle is transcribed below each page.`, "");
  }
  for (const page of notebook.pages) {
    lines.push(`## Page ${page.number}`, "");
    if (page.image) lines.push(`![[${page.image.vaultPath}]]`, "");
    else lines.push("> [!warning] Page image unavailable", "");
    if (page.typedText.length > 0 && !notebook.sourceNote) {
      lines.push("**Typed text**", "", ...page.typedText.flatMap((text) => [text.trim(), ""]));
    }
    if (page.strokeCount === 0) {
      if ((page.typedText.length === 0 || notebook.sourceNote) && page.image) lines.push(notebook.sourceNote ? "*No handwriting added yet.*" : "*No handwriting on this page.*", "");
    } else if (page.transcription === undefined) {
      lines.push("> [!warning] Handwriting transcription unavailable", "");
    } else if (page.transcription.trim() === "") {
      lines.push("*No text recognised in the handwriting (drawing only).*", "");
    } else {
      lines.push("> [!note]- Handwriting (automatic transcription, may contain errors)");
      for (const line of page.transcription.split("\n")) lines.push(`> ${line}`);
      lines.push("");
    }
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

type FrontmatterValue = string | number | string[];

/** Merge generated block + owned frontmatter into an existing note, preserving everything else. */
export function mergeNote(existing: string | null, frontmatter: Record<string, FrontmatterValue>, block: string): { content: string } | { conflict: string } {
  const body = existing ?? "";
  const { fields, rest } = splitFrontmatter(body);
  let content: string;
  if (existing === null || rest.trim() === "") {
    content = `${block}\n`;
  } else {
    const begin = rest.indexOf("<!-- ignite:begin");
    const end = rest.indexOf(END_MARKER);
    if (begin < 0 || end < begin) return { conflict: "generated-block markers are missing; note left unchanged" };
    content = rest.slice(0, begin) + block + rest.slice(end + END_MARKER.length);
  }
  const kept = fields.filter((field) => !OWNED_KEYS.has(field.key));
  const owned = Object.entries(frontmatter).map(([key, value]) => yamlField(key, value));
  const tags = kept.some((field) => field.key === "tags") ? [] : [yamlField("tags", ["kindle"])];
  const header = ["---", ...owned, ...tags, ...kept.map((field) => field.lines.join("\n")), "---"].join("\n");
  return { content: `${header}\n${content.replace(/^\n+/, "")}` };
}

function yamlField(key: string, value: FrontmatterValue): string {
  if (Array.isArray(value)) return `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`;
  return `${key}: ${typeof value === "number" ? value : JSON.stringify(value)}`;
}

function splitFrontmatter(content: string): { fields: { key: string; lines: string[] }[]; rest: string } {
  if (!content.startsWith("---\n")) return { fields: [], rest: content };
  const close = content.indexOf("\n---", 4);
  if (close < 0) return { fields: [], rest: content };
  const after = content.indexOf("\n", close + 4);
  const rest = after < 0 ? "" : content.slice(after + 1);
  const fields: { key: string; lines: string[] }[] = [];
  for (const line of content.slice(4, close).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):/.exec(line);
    if (match) fields.push({ key: match[1]!, lines: [line] });
    else if (fields.length > 0) fields[fields.length - 1]!.lines.push(line);
  }
  return { fields, rest };
}

export class VaultMirror {
  readonly root: string;

  constructor(private readonly vaultPath: string, readonly folder = "Kindle") {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/.test(folder)) throw new Error("Ignite vault folder must be a single plain folder name");
    this.root = path.join(vaultPath, folder);
  }

  async apply(notebooks: MirrorNotebook[], now = new Date()): Promise<MirrorResult> {
    const manifest = await this.#loadManifest();
    const result: MirrorResult = { written: [], unchanged: 0, renamed: [], deleted: [], conflicts: [] };
    const taken = new Set(Object.entries(manifest.notebooks).filter(([id]) => notebooks.some((n) => n.notebookId === id)).map(([, entry]) => entry.notePath.toLowerCase()));

    for (const notebook of notebooks) {
      const previous = manifest.notebooks[notebook.notebookId];
      if (previous) taken.delete(previous.notePath.toLowerCase());
      const notePath = previous && !previous.deletedAt && this.#sameTitle(previous.notePath, notebook) ? previous.notePath : await this.#freePath(notebook, taken);
      taken.add(notePath.toLowerCase());

      const block = renderBlock(notebook);
      const blockHash = createHash("sha256").update(block).digest("hex");
      const noteExists = await exists(this.#abs(notePath));
      const oldExists = previous && previous.notePath !== notePath ? await exists(this.#abs(previous.notePath)) : false;
      if (previous && previous.blockHash === blockHash && previous.notePath === notePath && !previous.deletedAt && noteExists) {
        result.unchanged++;
        continue;
      }

      for (const page of notebook.pages) {
        if (!page.image) continue;
        const target = this.#abs(page.image.vaultPath);
        if (await exists(target)) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(page.image.sourcePath, target);
      }

      if (previous && oldExists && !noteExists) {
        await mkdir(path.dirname(this.#abs(notePath)), { recursive: true });
        await rename(this.#abs(previous.notePath), this.#abs(notePath));
        result.renamed.push({ from: previous.notePath, to: notePath });
      }
      const existing = await readText(this.#abs(notePath));
      const merged = mergeNote(existing, {
        source: "kindle",
        ignite_notebook_id: notebook.notebookId,
        ...(notebook.folderTitle ? { ignite_folder: notebook.folderTitle } : {}),
        ignite_pages: notebook.pages.length,
        ignite_updated: now.toISOString()
      }, block);
      if ("conflict" in merged) {
        result.conflicts.push({ notePath, reason: merged.conflict });
        continue;
      }
      await atomicWrite(this.#abs(notePath), merged.content);
      result.written.push(notePath);

      const images = notebook.pages.flatMap((page) => (page.image ? [page.image.vaultPath] : []));
      for (const stale of previous?.images ?? []) {
        if (images.includes(stale)) continue;
        await removeQuietly(this.#abs(stale));
        await rmdir(path.dirname(this.#abs(stale))).catch(() => undefined); // only succeeds when empty
      }
      manifest.notebooks[notebook.notebookId] = { notePath, blockHash, images };
    }

    for (const [notebookId, entry] of Object.entries(manifest.notebooks)) {
      if (entry.deletedAt || notebooks.some((notebook) => notebook.notebookId === notebookId)) continue;
      const existing = await readText(this.#abs(entry.notePath));
      if (existing !== null) {
        const notice = `> [!info] This notebook was deleted on the Kindle (${now.toISOString().slice(0, 10)}). The mirror keeps this note and its pages.`;
        const updated = existing.includes(BEGIN_MARKER) && !existing.includes("was deleted on the Kindle")
          ? existing.replace(BEGIN_MARKER, `${BEGIN_MARKER}\n${notice}\n`).replace(/^---\n/, `---\nignite_deleted: ${JSON.stringify(now.toISOString())}\n`)
          : existing;
        if (updated !== existing) await atomicWrite(this.#abs(entry.notePath), updated);
      }
      entry.deletedAt = now.toISOString();
      result.deleted.push(entry.notePath);
    }

    await this.#saveManifest(manifest);
    return result;
  }

  /** Vault-relative note path recorded for a notebook, if mirrored. */
  async notePath(notebookId: string): Promise<string | undefined> {
    return (await this.#loadManifest()).notebooks[notebookId]?.notePath;
  }

  #sameTitle(notePath: string, notebook: MirrorNotebook): boolean {
    return notePath.toLowerCase() === this.#desiredPath(notebook).toLowerCase() || notePath.toLowerCase().startsWith(this.#desiredPath(notebook).replace(/\.md$/, "").toLowerCase() + " (");
  }

  #desiredPath(notebook: MirrorNotebook): string {
    const title = safeSegment(notebook.title, `Notebook ${notebook.notebookId.slice(0, 8)}`);
    const folder = notebook.folderTitle ? `${safeSegment(notebook.folderTitle, "Folder")}/` : "";
    return `${this.folder}/${folder}${title}.md`;
  }

  async #freePath(notebook: MirrorNotebook, taken: Set<string>): Promise<string> {
    const desired = this.#desiredPath(notebook);
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? desired : desired.replace(/\.md$/, ` (${n}).md`);
      if (taken.has(candidate.toLowerCase())) continue;
      const existing = await readText(this.#abs(candidate));
      // Reuse a note that already belongs to this notebook (e.g. after a lost manifest).
      if (existing === null || existing.includes(`ignite_notebook_id: ${JSON.stringify(notebook.notebookId)}`)) return candidate;
    }
    return desired.replace(/\.md$/, ` (${randomUUID().slice(0, 8)}).md`);
  }

  #abs(vaultRelative: string): string {
    const resolved = path.resolve(this.vaultPath, ...vaultRelative.split("/"));
    if (!resolved.startsWith(this.root + path.sep)) throw new Error("mirror path escaped its folder");
    return resolved;
  }

  async #loadManifest(): Promise<Manifest> {
    const text = await readText(path.join(this.root, MANIFEST));
    if (!text) return { v: 1, notebooks: {} };
    const parsed = JSON.parse(text) as Manifest;
    return parsed.v === 1 && parsed.notebooks ? parsed : { v: 1, notebooks: {} };
  }

  async #saveManifest(manifest: Manifest): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await atomicWrite(path.join(this.root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true; } catch { return false; }
}

async function readText(filename: string): Promise<string | null> {
  try { return await readFile(filename, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filename);
}

async function removeQuietly(filename: string): Promise<void> {
  try { await unlink(filename); } catch {}
}
