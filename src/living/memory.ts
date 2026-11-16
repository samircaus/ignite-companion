import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Notebook identity and memory, as plain Markdown in the vault (`Living Notebooks/`), so it can be
 * read and edited in Obsidian and by any AI app through the vault tools:
 *
 * - `_profiles/<Name>.md`: one per kind of notebook. Frontmatter `match_folder` binds every
 *   notebook in that Ignite folder; the body is the instructions.
 * - `<Notebook title>.md`: one per living notebook. Frontmatter `ignite_notebook_id`, `profile`,
 *   `enabled`; sections Instructions, Memory, Summary and Log.
 *
 * A notebook takes part when its note says `enabled: true`, or when it sits in a folder a profile
 * matches (its note is then created on the first turn). The bridge-owned `Kindle/` notes are never
 * touched.
 */

export interface Profile { name: string; matchFolder: string | null; instructions: string }

export interface NotebookMemory {
  enabled: boolean;
  profile: Profile;
  notePath: string | null;
  instructions: string;
  memory: string;
  summary: string;
}

export const FOLDER = "Living Notebooks";

const DEFAULT_PROFILES: Record<string, { matchFolder: string | null; body: string }> = {
  General: {
    matchFolder: null,
    body: "A thinking partner for handwritten notes. Be concise and concrete. Prefer short lists and small diagrams over paragraphs. Match the user's language and tone."
  },
  Thinking: {
    matchFolder: "Thinking",
    body: "A notebook for developing ideas. On (+), expand the circled idea with 2-4 concrete directions, questions or next steps; a small diagram when relationships matter. On (?), answer directly and briefly, then name one thing worth checking."
  }
};

export class LivingMemory {
  constructor(private readonly vaultPath: string, private readonly now: () => Date = () => new Date()) {}

  get #dir(): string { return path.join(this.vaultPath, FOLDER); }

  /** Creates the folder and the default profiles if they are missing (never overwrites). */
  async ensureDefaults(): Promise<void> {
    await mkdir(path.join(this.#dir, "_profiles"), { recursive: true });
    for (const [name, p] of Object.entries(DEFAULT_PROFILES)) {
      const file = path.join(this.#dir, "_profiles", `${name}.md`);
      try {
        await readFile(file);
      } catch {
        await writeFile(file, `---\nmatch_folder: ${p.matchFolder ? JSON.stringify(p.matchFolder) : "null"}\n---\n\n${p.body}\n`, { flag: "wx" }).catch(() => undefined);
      }
    }
  }

  async profiles(): Promise<Profile[]> {
    const dir = path.join(this.#dir, "_profiles");
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
    } catch {
      return [{ name: "General", matchFolder: null, instructions: DEFAULT_PROFILES.General!.body }];
    }
    const out: Profile[] = [];
    for (const n of names) {
      const { front, body } = parseNote(await readFile(path.join(dir, n), "utf8"));
      out.push({ name: n.slice(0, -3), matchFolder: typeof front.match_folder === "string" && front.match_folder ? front.match_folder : null, instructions: body.trim() });
    }
    if (!out.some((p) => p.name === "General")) out.push({ name: "General", matchFolder: null, instructions: DEFAULT_PROFILES.General!.body });
    return out;
  }

  /** The notebook's settings and memory. `folder`: its Ignite folder title, if any. */
  async forNotebook(notebookId: string, title: string, folder: string | null): Promise<NotebookMemory> {
    const profiles = await this.profiles();
    const note = await this.#findNote(notebookId, title);
    const byFolder = folder ? profiles.find((p) => p.matchFolder && p.matchFolder.toLowerCase() === folder.toLowerCase()) : undefined;
    const named = typeof note?.front.profile === "string" ? profiles.find((p) => p.name.toLowerCase() === String(note.front.profile).toLowerCase()) : undefined;
    const profile = named ?? byFolder ?? profiles.find((p) => p.name === "General")!;
    const enabled = note ? note.front.enabled === true || (note.front.enabled === undefined && Boolean(byFolder)) : Boolean(byFolder);
    return {
      enabled,
      profile,
      notePath: note ? path.relative(this.vaultPath, note.file).split(path.sep).join("/") : null,
      instructions: note ? section(note.body, "Instructions") : "",
      memory: note ? section(note.body, "Memory") : "",
      summary: note ? section(note.body, "Summary") : ""
    };
  }

  /** Enables a notebook (creating its note) with a profile. */
  async enable(notebookId: string, title: string, profile = "General"): Promise<string> {
    const found = await this.#findNote(notebookId, title);
    if (found) {
      const front = { ...found.front, enabled: true, ...(found.front.profile ? {} : { profile }) };
      await atomicWrite(found.file, renderNote(front, found.body));
      return found.file;
    }
    return await this.#create(notebookId, title, profile, true);
  }

  /** After a turn: a Log line, new facts under Memory, and the Summary if the model rewrote it. */
  async record(input: { notebookId: string; title: string; profile: string; logLine: string; facts: string[]; summary: string | null }): Promise<string> {
    let note = await this.#findNote(input.notebookId, input.title);
    if (!note) {
      await this.#create(input.notebookId, input.title, input.profile, true);
      note = (await this.#findNote(input.notebookId, input.title))!;
    }
    let body = note.body;
    if (input.facts.length) {
      const existing = section(body, "Memory");
      const fresh = input.facts.filter((f) => !existing.toLowerCase().includes(f.toLowerCase()));
      if (fresh.length) body = setSection(body, "Memory", [existing.trim(), ...fresh.map((f) => `- ★ ${f}`)].filter(Boolean).join("\n"));
    }
    if (input.summary) body = setSection(body, "Summary", input.summary);
    const log = section(body, "Log").trim();
    const stamp = this.now().toISOString().slice(0, 16).replace("T", " ");
    body = setSection(body, "Log", [log, `- ${stamp} ${input.logLine.replace(/\n/g, " ")}`].filter(Boolean).join("\n"));
    await atomicWrite(note.file, renderNote(note.front, body));
    return path.relative(this.vaultPath, note.file).split(path.sep).join("/");
  }

  async #create(notebookId: string, title: string, profile: string, enabled: boolean): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const base = safeName(title) || "Notebook";
    let file = path.join(this.#dir, `${base}.md`);
    for (let i = 2; await exists(file); i += 1) file = path.join(this.#dir, `${base} ${i}.md`);
    const body = "\n## Instructions\n\n## Memory\n\n## Summary\n\n## Log\n";
    await writeFile(file, renderNote({ ignite_notebook_id: notebookId, profile, enabled }, body), { flag: "wx" });
    return file;
  }

  async #findNote(notebookId: string, title: string): Promise<{ file: string; front: Record<string, unknown>; body: string } | undefined> {
    let names: string[];
    try {
      names = (await readdir(this.#dir)).filter((n) => n.endsWith(".md"));
    } catch {
      return undefined;
    }
    let byTitle: { file: string; front: Record<string, unknown>; body: string } | undefined;
    for (const n of names) {
      const file = path.join(this.#dir, n);
      const { front, body } = parseNote(await readFile(file, "utf8"));
      if (front.ignite_notebook_id === notebookId) return { file, front, body };
      if (!byTitle && !front.ignite_notebook_id && n.slice(0, -3).toLowerCase() === safeName(title).toLowerCase()) byTitle = { file, front, body };
    }
    return byTitle;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Minimal frontmatter: `key: value` lines (strings, true/false, null, numbers, JSON strings). */
export function parseNote(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { front: {}, body: text };
  const front: Record<string, unknown> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    let value: unknown = raw;
    if (raw === "true" || raw === "false") value = raw === "true";
    else if (raw === "null" || raw === "") value = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) value = raw.slice(1, -1);
    front[kv[1]!] = value;
  }
  return { front, body: text.slice(m[0].length) };
}

function renderNote(front: Record<string, unknown>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** Text under `## name` up to the next `## ` heading. */
export function section(body: string, name: string): string {
  const re = new RegExp(`^## ${name}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  return re.exec(body)?.[1]?.trim() ?? "";
}

export function setSection(body: string, name: string, content: string): string {
  const re = new RegExp(`^## ${name}[ \\t]*\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m");
  const block = `## ${name}\n\n${content.trim()}\n\n`;
  if (re.test(body)) return body.replace(re, block);
  return `${body.replace(/\s*$/, "\n\n")}${block}`;
}
