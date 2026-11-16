import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { IgnitePage, IgnitePressureCurve, IgniteRenderProfile, PageTranscription } from "./types.js";

/** Kindle Scribe raster width the sealed stroke radii refer to. */
export const KINDLE_RASTER_WIDTH = 1860;
const PRESSURE_Q_MAX = 4095;
const SEALED_CURVE: IgnitePressureCurve = { q_r1_max: 820, q_r2_max: 2866, q_r3_max: 3685, min_radius: 1, max_radius: 4, missing_fallback_radius: 2 };

/** Ignite's sealed pressure → radius bands (`scribe-app/src/pressure_curve.rs`), in Kindle raster px. */
export function strokeRadius(pressure: number | undefined, profile: IgniteRenderProfile, style: string): number {
  if (style === "legacy-fixed-v1") return profile.legacy_fixed_radius ?? 2;
  const curve = profile.pressure ?? SEALED_CURVE;
  if (pressure === undefined || !Number.isFinite(pressure)) return curve.missing_fallback_radius;
  const q = Math.round(Math.min(1, Math.max(0, pressure)) * PRESSURE_Q_MAX);
  const r = q <= curve.q_r1_max ? 1 : q <= curve.q_r2_max ? 2 : q <= curve.q_r3_max ? 3 : 4;
  return Math.min(curve.max_radius, Math.max(curve.min_radius, r));
}

/**
 * Identity of what a page looks like: background + visible stroke ids (a stroke id names exact
 * geometry) + typed text. Equal hash ⇒ identical render and transcription, so both are cached on it.
 */
export function pageContentHash(page: IgnitePage): string {
  const hash = createHash("sha256");
  hash.update(page.background.kind === "blob" ? `bg:${page.background.sha256}` : "bg:blank");
  hash.update(`|ink:${page.render.ink_byte}|v:${page.render.profile_version}`);
  for (const stroke of page.strokes) hash.update(`|s:${stroke.stroke_id}`);
  for (const text of page.texts ?? []) hash.update(`|t:${text.text_id}:${text.x},${text.y},${text.width},${text.font_size}:${text.content}`);
  return hash.digest("hex");
}

export interface RenderJob {
  page: IgnitePage;
  pageSpace: { width: number; height: number };
  backgroundPath?: string | undefined;
  png?: { path: string; width: number } | undefined;
  ocr?: { width: number; languages: string[] } | undefined;
  /** Stroke ids drawn by the writer (checkboxes, rules): rendered, but left out of recognition. */
  printed?: Set<string> | undefined;
}

export interface RenderResult { ok: boolean; error?: string; png?: string; ocr?: PageTranscription }

export function nativeJob(job: RenderJob): unknown {
  const { page } = job;
  return {
    pageWidth: job.pageSpace.width,
    pageHeight: job.pageSpace.height,
    rasterWidth: KINDLE_RASTER_WIDTH,
    strokes: page.strokes.map((stroke) => ({
      points: stroke.points.flatMap((point) => [point.x, point.y, strokeRadius(point.pressure ?? undefined, page.render, stroke.style)]),
      ...(job.printed?.has(stroke.stroke_id) ? { ocr: false } : {})
    })),
    texts: (page.texts ?? []).map((text) => ({ x: text.x, y: text.y, width: text.width, fontSize: text.font_size, content: text.content })),
    background: page.background.kind === "blob" && job.backgroundPath
      ? { path: job.backgroundPath, width: page.background.format.width, height: page.background.format.height, stride: page.background.format.stride }
      : null,
    png: job.png?.path ?? null,
    pngWidth: job.png?.width ?? null,
    ocr: job.ocr ?? null
  };
}

export type NativeRunner = (input: string, signal?: AbortSignal) => Promise<string>;

/** Runs the `ignite-render` Swift helper (CoreGraphics drawing + Apple Vision recognition). */
export class PageRenderer {
  /** `fontPath`: Ignite's `default-sans-v1.ttf`, so typed text wraps exactly as on the Kindle. */
  constructor(private readonly run: NativeRunner, private readonly fontPath?: string) {}

  static native(binaryPath: string, timeoutMs = 300_000, fontPath?: string): PageRenderer {
    return new PageRenderer((input, signal) => runBinary(binaryPath, input, timeoutMs, signal), fontPath);
  }

  async render(jobs: RenderJob[], signal?: AbortSignal): Promise<RenderResult[]> {
    if (jobs.length === 0) return [];
    const output = await this.run(JSON.stringify({ jobs: jobs.map(nativeJob), ...(this.fontPath ? { fontPath: this.fontPath } : {}) }), signal);
    const parsed = JSON.parse(output) as { results?: RenderResult[] };
    if (!Array.isArray(parsed.results) || parsed.results.length !== jobs.length) throw new Error("ignite-render returned a malformed result");
    return parsed.results;
  }
}

function runBinary(binaryPath: string, input: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, ...(signal ? { signal } : {}) });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`ignite-render exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 400)}`));
    });
    child.stdin.end(input);
  });
}
