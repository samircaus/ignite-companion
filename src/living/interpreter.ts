import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Glyph } from "./marks.js";

/**
 * Interpreter: page image + context → what to write back. Model-neutral interface; the first
 * implementation runs Codex headless (`codex exec`, the ChatGPT plan already signed in on this
 * Mac) with the page images attached and a JSON schema for the answer. A Claude CLI adapter can
 * implement the same interface.
 */

export interface InterpretContext {
  glyph: Glyph;
  notebookTitle: string;
  pageNumber: number;
  pageCount: number;
  /** Full page, and a close-up of the marked area (PNG paths). */
  pageImage: string;
  focusImage: string | null;
  /** Where the mark and what it is about are, in page-width units (x 0..1, y 0..1.333). */
  markBox: [number, number, number, number];
  aboutBox: [number, number, number, number] | null;
  /** Recognised handwriting near the mark (a hint; can be wrong). */
  nearbyText: string;
  /** Profile instructions and the notebook's own note sections. */
  profileName: string;
  profileInstructions: string;
  notebookInstructions: string;
  memory: string;
  summary: string;
  /** Text room in characters per line at the planned size, to keep lines short. */
  lineChars: number;
}

export interface Interpretation {
  /** One line: what the user is asking for, as understood. */
  understood: string;
  /** Text to write back in handwriting (plain text, newlines allowed). */
  answer: string;
  /** Optional small diagram. */
  svg: string | null;
  /** True when the request is unclear: `answer` then holds one short question to the user. */
  needsConfirmation: boolean;
  /** Short facts worth remembering for this notebook. */
  memoryFacts: string[];
  /** New rolling summary of the notebook, or null to keep it. */
  summaryUpdate: string | null;
  /** Which interpreter answered (set by FallbackInterpreter). */
  model?: string;
}

export interface Interpreter {
  readonly name: string;
  interpret(context: InterpretContext, signal?: AbortSignal): Promise<Interpretation>;
}

/** Characters the Kindle handwriting font draws (ignite-import `hand.rs`), after normalising. */
const FONT_CHARS = new Set([..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?-'\"()/+=*%&#@→←•°€ßäöüÄÖÜ \n"]);
const REPLACE: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "`": "'", "\u00b4": "'", "\u201c": "\"", "\u201d": "\"", "\u201e": "\"", "\u00ab": "\"", "\u00bb": "\"",
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00a0": " ", "\t": " ", "\u00b7": "\u2022", "\u2026": "...", "\u00d7": "x",
  "\u2248": "=", "\u2260": "/=", "\u2264": "<=", "\u2265": ">=", "\u21d2": "\u2192",
  "\u00e9": "e", "\u00e8": "e", "\u00ea": "e", "\u00e1": "a", "\u00e0": "a", "\u00e2": "a", "\u00f3": "o", "\u00f2": "o", "\u00f4": "o",
  "\u00fa": "u", "\u00f9": "u", "\u00fb": "u", "\u00ed": "i", "\u00ec": "i", "\u00e7": "c", "\u00f1": "n",
  "[": "(", "]": ")", "{": "(", "}": ")", "<": "(", ">": ")", "_": "-", "|": "/", "~": "-", "^": "", "$": "USD ", "\u00a7": "S"
};

/** Text the handwriting font can draw: known substitutes applied, anything else dropped. */
export function fontSafe(text: string): string {
  let s = text.replace(/\r\n?/g, "\n").replace(/=>/g, "→").replace(/->/g, "→").replace(/<-/g, "←");
  s = s.normalize("NFC");
  let out = "";
  for (const ch of s) {
    if (FONT_CHARS.has(ch)) out += ch;
    else if (REPLACE[ch] !== undefined) out += REPLACE[ch];
  }
  // Markdown leftovers read badly in handwriting.
  return out.replace(/\*\*|__/g, "").replace(/^#+\s*/gm, "").replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["understood", "answer", "svg", "needs_confirmation", "memory_facts", "summary_update"],
  properties: {
    understood: { type: "string", description: "One short line: what the user is asking for." },
    answer: { type: "string", description: "What to write back on the page, plain text with line breaks. No Markdown." },
    svg: { type: ["string", "null"], description: "Optional small SVG diagram, or null." },
    needs_confirmation: { type: "boolean", description: "True if the request is unclear; answer then holds one short question." },
    memory_facts: { type: "array", items: { type: "string" }, description: "0-3 short facts worth remembering for this notebook." },
    summary_update: { type: ["string", "null"], description: "New 2-5 sentence summary of the notebook so far, or null to keep it." }
  }
} as const;

const fmt = (b: [number, number, number, number]): string => `x ${b[0].toFixed(2)}–${b[2].toFixed(2)}, y ${b[1].toFixed(2)}–${b[3].toFixed(2)}`;

export function buildPrompt(c: InterpretContext): string {
  const command = c.glyph === "+"
    ? "EXPAND (+): develop the circled idea. Add a few concrete directions, details or next steps that build on what is written. Do not repeat it."
    : "ASK (?): answer the question, or explain / give a short opinion on what is circled. Be direct.";
  return [
    `You are the AI inside a handwritten notebook on a Kindle Scribe. The user drew a small circled "${c.glyph}" on page ${c.pageNumber} of ${c.pageCount} of the notebook "${c.notebookTitle}". Your answer will be written onto the page as handwriting next to their mark, so it must be short and readable.`,
    "",
    `Command: ${command}`,
    "",
    "Images: the first image is the whole page (page width = 1). " + (c.focusImage ? "The second is a close-up of the marked area. " : "") + `The mark is at ${fmt(c.markBox)}. ` + (c.aboutBox ? `What it refers to is at ${fmt(c.aboutBox)} (a loop the user drew, or the ink around the mark).` : "There is no selection loop; it refers to the ink nearest the mark."),
    "Ink drawn by you in earlier turns is on the page too; the user may be reacting to it.",
    c.nearbyText.trim() ? `Handwriting recognised near the mark (may contain errors; trust the image):\n${c.nearbyText.trim()}` : "",
    "",
    `Profile "${c.profileName}":`,
    c.profileInstructions.trim() || "(none)",
    c.notebookInstructions.trim() ? `Instructions for this notebook:\n${c.notebookInstructions.trim()}` : "",
    c.memory.trim() ? `Notebook memory:\n${c.memory.trim()}` : "",
    c.summary.trim() ? `Notebook summary so far:\n${c.summary.trim()}` : "",
    "",
    "Rules for the answer:",
    `- Plain text only, no Markdown. Short lines (about ${c.lineChars} characters at most), at most 12 lines, usually 3-8. Lists as "1." or "-" lines.`,
    "- Write in the language the user wrote in.",
    "- Only these characters: letters a-z A-Z, digits, ä ö ü Ä Ö Ü ß, space, newline and . , ; : ! ? - ' \" ( ) / + = * % & # @ → ← • ° €. No emoji, no other symbols.",
    "- svg: only when a small diagram really helps (boxes, arrows, a sketch), else null. A complete <svg> with a viewBox, black strokes, no fill, no colours, at most 25 elements (rect, circle, ellipse, line, polyline, path), labels as <text> with font-size about 8% of the viewBox height, 1-3 words each, same character rules. Keep it simple and clear.",
    "- If you cannot tell what the user wants, set needs_confirmation to true and put one short question in answer.",
    "- memory_facts: only lasting facts about this notebook's subject (names, decisions, plot facts), never about the mark itself; often empty.",
    "- summary_update: null unless the notebook's direction changed or there is no summary yet."
  ].filter((line) => line !== "").join("\n");
}

export type ProcessRunner = (command: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export class CodexExecInterpreter implements Interpreter {
  readonly name = "codex";

  constructor(private readonly options: { command: string; model?: string | undefined; timeoutMs?: number; run?: ProcessRunner }) {}

  async interpret(context: InterpretContext, signal?: AbortSignal): Promise<Interpretation> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "companion-living-"));
    try {
      const schema = path.join(dir, "schema.json");
      const out = path.join(dir, "answer.json");
      await writeFile(schema, JSON.stringify(OUTPUT_SCHEMA));
      const args = [
        "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
        "--cd", dir, "--output-schema", schema, "--output-last-message", out,
        "--image", context.pageImage, ...(context.focusImage ? ["--image", context.focusImage] : []),
        ...(this.options.model ? ["--model", this.options.model] : []),
        "-"
      ];
      const run = this.options.run ?? runProcess;
      const result = await run(this.options.command, args, buildPrompt(context), this.options.timeoutMs ?? 240_000, signal);
      let raw: string;
      try {
        raw = await readFile(out, "utf8");
      } catch {
        throw new Error(`codex exec gave no answer (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
      }
      return parseInterpretation(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Claude Code headless (`claude -p`, the Claude plan signed in on this Mac). The page images are
 * read with Claude's Read tool (the only tool allowed), the answer is the same JSON object.
 */
export class ClaudeCliInterpreter implements Interpreter {
  readonly name = "claude";

  constructor(private readonly options: { command: string; model?: string | undefined; timeoutMs?: number; run?: ProcessRunner }) {}

  async interpret(context: InterpretContext, signal?: AbortSignal): Promise<Interpretation> {
    const images = [context.pageImage, ...(context.focusImage ? [context.focusImage] : [])];
    const prompt = [
      buildPrompt(context),
      "",
      `First look at the images with the Read tool: ${images.join(" and ")}.`,
      `Then reply with ONLY one JSON object, no prose and no code fence, with exactly these keys: ${JSON.stringify(Object.keys(OUTPUT_SCHEMA.properties))}.`
    ].join("\n");
    const dirs = [...new Set(images.map((i) => path.dirname(i)))];
    const args = ["-p", "--output-format", "json", "--allowedTools", "Read", "--strict-mcp-config", ...dirs.flatMap((d) => ["--add-dir", d]), ...(this.options.model ? ["--model", this.options.model] : [])];
    const run = this.options.run ?? runProcess;
    const result = await run(this.options.command, args, prompt, this.options.timeoutMs ?? 240_000, signal);
    let envelope: { is_error?: boolean; result?: string };
    try {
      envelope = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as { is_error?: boolean; result?: string };
    } catch {
      throw new Error(`claude -p gave no answer (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
    if (envelope.is_error || typeof envelope.result !== "string") throw new Error(`claude -p failed: ${String(envelope.result ?? "no result").slice(0, 300)}`);
    return parseInterpretation(envelope.result);
  }
}

/** Tries each interpreter in order (e.g. Codex, then Claude when Codex is over its limit or signed out). */
export class FallbackInterpreter implements Interpreter {
  constructor(private readonly chain: Interpreter[], private readonly log?: (event: Record<string, unknown>) => void) {
    if (!chain.length) throw new Error("FallbackInterpreter needs at least one interpreter");
  }

  get name(): string { return this.chain.map((i) => i.name).join(" → "); }

  async interpret(context: InterpretContext, signal?: AbortSignal): Promise<Interpretation> {
    const errors: string[] = [];
    for (const interpreter of this.chain) {
      try {
        const answer = await interpreter.interpret(context, signal);
        return { ...answer, model: interpreter.name };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${interpreter.name}: ${message.slice(0, 200)}`);
        this.log?.({ event: "living_interpreter_failed", interpreter: interpreter.name, error: message.slice(0, 300) });
      }
    }
    throw new Error(`No AI could answer. ${errors.join(" | ")}`);
  }
}

export function parseInterpretation(raw: string): Interpretation {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model's answer was not JSON");
  const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const svg = typeof j.svg === "string" && /<svg[\s>]/i.test(j.svg) ? j.svg.trim() : null;
  return {
    understood: str(j.understood).slice(0, 300),
    answer: fontSafe(str(j.answer)),
    svg,
    needsConfirmation: j.needs_confirmation === true,
    memoryFacts: Array.isArray(j.memory_facts) ? j.memory_facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 5).map((f) => f.trim().slice(0, 200)) : [],
    summaryUpdate: typeof j.summary_update === "string" && j.summary_update.trim() ? j.summary_update.trim().slice(0, 1500) : null
  };
}

export function runProcess(command: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, ...(signal ? { signal } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.end(input);
  });
}
