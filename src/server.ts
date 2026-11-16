#!/usr/bin/env node
/**
 * Ignite Companion: a small loopback HTTP API on the Mac that runs next to the Ignite sync server.
 * It mirrors Kindle Scribe notebooks into a Markdown folder (Obsidian works), writes notes and
 * notebooks back through plan → preview → apply, and runs Living Notebooks (AI answers in ink).
 * The MCP server (`ignite-companion-mcp`) is the usual way to talk to it.
 *
 * Required: COMPANION_VAULT_PATH (the Markdown folder), COMPANION_API_TOKEN (32+ characters; the
 * MCP server sends the same one), COMPANION_IGNITE_TOKEN_FILE (the Ignite sync server token).
 * Optional: COMPANION_API_HOST (127.0.0.1, loopback only), COMPANION_API_PORT (7340). Everything
 * else is described in src/ignite/index.ts and src/living/index.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createIgnite, WriterError } from "./ignite/index.js";
import type { WriteRequest } from "./ignite/writer.js";
import type { DeviceFileRequest } from "./ignite/device.js";
import { LivingError } from "./living/index.js";

class InputError extends Error {}

const vaultPath = requireVault(process.env.COMPANION_VAULT_PATH);
const token = requireToken(process.env.COMPANION_API_TOKEN);
const hostname = process.env.COMPANION_API_HOST ?? "127.0.0.1";
const port = parsePort(process.env.COMPANION_API_PORT ?? "7340");
if (!isLoopback(hostname)) throw new Error("COMPANION_API_HOST must be loopback");
if (!process.env.COMPANION_IGNITE_TOKEN_FILE) throw new Error("COMPANION_IGNITE_TOKEN_FILE is required (the Ignite sync server token file)");

const ignite = await createIgnite(vaultPath);
if (!ignite) throw new Error("Ignite bridge is not configured");
const { bridge, writer, device, living } = ignite;
for (const [event, reason] of [["writer_disabled", ignite.writerDisabledReason], ["kindle_device_disabled", ignite.deviceDisabledReason], ["living_disabled", ignite.livingDisabledReason]] as const) {
  if (reason) console.error(JSON.stringify({ event, reason }));
}

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    if (error instanceof WriterError || error instanceof LivingError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof InputError || error instanceof SyntaxError) sendJson(response, 400, { error: error.message });
    else {
      console.error(JSON.stringify({ event: "api_error", error: error instanceof Error ? error.message : String(error) }));
      sendJson(response, 500, { error: "Internal server error" });
    }
  }
});

server.listen(port, hostname, () => console.log(JSON.stringify({ event: "companion_started", hostname, port })));
void bridge.start();
if (living) {
  void living.service.start().then(() => living.watcher?.start()).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "living_start_failed", error: error instanceof Error ? error.message : String(error) }));
  });
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(); });
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await bridge.stop();
  await living?.watcher?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${hostname}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/health") return sendJson(response, 200, { ok: true });
  if (!authorized(request.headers.authorization)) {
    response.setHeader("www-authenticate", "Bearer");
    return sendJson(response, 401, { error: "Authentication required" });
  }
  if (request.method === "POST") return handlePost(request, url, response);
  if (request.method === "GET") return handleGet(url, response);
  sendJson(response, 405, { error: "Method not allowed" });
}

async function handlePost(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
  switch (url.pathname) {
    case "/v1/ignite/sync":
      await bridge.sync({ force: true });
      return sendJson(response, 200, bridge.status());
    case "/v1/ignite/plan": {
      if (!writer) return sendJson(response, 503, { error: `Writing to the Kindle is not available: ${ignite!.writerDisabledReason}` });
      const plan = await writer.plan(parseWriteRequest(await readJson(request, 2.5 * 1024 * 1024)));
      return sendJson(response, 200, url.searchParams.get("images") === "1" ? { ...plan, images: await previewImages(plan.previews, 4) } : plan);
    }
    case "/v1/ignite/files/plan":
      if (!device) return sendJson(response, 503, { error: `Kindle device files are not available: ${ignite!.deviceDisabledReason}` });
      return sendJson(response, 200, await device.plan(parseDeviceFileRequest(await readJson(request, 32 * 1024))));
    case "/v1/ignite/apply": {
      const body = await readJson(request, 4 * 1024) as { planId?: unknown };
      if (typeof body.planId !== "string") throw new WriterError(400, "planId is required");
      if (living?.service.hasPlan(body.planId)) return sendJson(response, 200, await living.service.apply(body.planId));
      if (device?.getPlan(body.planId)) return sendJson(response, 200, await device.apply(body.planId));
      if (writer?.getPlan(body.planId)) return sendJson(response, 200, await writer.apply(body.planId));
      return sendJson(response, 404, { error: "Unknown or expired plan id" });
    }
  }
  if (url.pathname.startsWith("/v1/living/")) {
    if (!living) return sendJson(response, 503, { error: `Living Notebooks is not available: ${ignite!.livingDisabledReason}` });
    const body = await readJson(request, 512 * 1024) as Record<string, unknown>;
    if (url.pathname === "/v1/living/plan") {
      const near = body.near && typeof body.near === "object" ? body.near as { x?: unknown; y?: unknown } : null;
      const plan = await living.service.propose({
        notebook: String(body.notebook ?? ""),
        page: Number(body.page ?? 1),
        text: typeof body.text === "string" ? body.text : "",
        svg: typeof body.svg === "string" && body.svg.trim() ? body.svg : null,
        near: near && Number.isFinite(Number(near.x)) && Number.isFinite(Number(near.y)) ? { x: Number(near.x), y: Number(near.y) } : null,
        newPage: body.newPage === true
      });
      return sendJson(response, 200, { ...plan, images: await previewImages([{ page: 1, path: plan.preview }], 1) });
    }
    if (url.pathname === "/v1/living/undo") {
      if (typeof body.turnId !== "string") throw new LivingError(400, "turnId is required");
      return sendJson(response, 200, await living.service.undo(body.turnId));
    }
    if (url.pathname === "/v1/living/enable") {
      const ref = await living.service.findPage({ notebook: String(body.notebook ?? ""), page: 1 });
      const note = await living.service.memory.enable(ref.notebook.notebook_id, ref.notebook.title, typeof body.profile === "string" && body.profile.trim() ? body.profile.trim() : "General");
      return sendJson(response, 200, { notebook: ref.notebook.title, note: path.relative(vaultPath, note) });
    }
  }
  sendJson(response, 404, { error: "Not found" });
}

async function handleGet(url: URL, response: ServerResponse): Promise<void> {
  switch (url.pathname) {
    case "/v1/ignite/status":
      return sendJson(response, 200, {
        ...bridge.status(),
        writes: writer ? { enabled: true, recent: (await writer.writes()).slice(-5).map(({ strokeIds: _ids, ...w }) => w) } : { enabled: false, reason: ignite!.writerDisabledReason },
        device: device ? { enabled: true, roots: device.roots } : { enabled: false, reason: ignite!.deviceDisabledReason },
        living: living ? { enabled: true } : { enabled: false, reason: ignite!.livingDisabledReason }
      });
    case "/v1/ignite/plan": {
      const plan = writer?.getPlan(url.searchParams.get("planId") ?? "");
      if (!plan) return sendJson(response, 404, { error: "Unknown or expired plan id" });
      const page = Number(url.searchParams.get("page") ?? "0");
      if (page <= 0) return sendJson(response, 200, plan);
      const preview = plan.previews.find((item) => item.page === page);
      return sendJson(response, preview ? 200 : 404, preview ? { planId: plan.planId, page, images: await previewImages([preview], 1) } : { error: "No such preview page" });
    }
    case "/v1/ignite/files":
      if (!device) return sendJson(response, 503, { error: `Kindle device files are not available: ${ignite!.deviceDisabledReason}` });
      return sendJson(response, 200, await device.list(url.searchParams.get("root") === "books" ? "books" : "documents", url.searchParams.get("recursive") !== "0"));
    case "/v1/ignite/screenshot":
      if (!device) return sendJson(response, 503, { error: `Kindle screenshot is not available: ${ignite!.deviceDisabledReason}` });
      return sendJson(response, 200, await device.screenshot());
    case "/v1/ignite/logs":
      if (!device) return sendJson(response, 503, { error: `Kindle logs are not available: ${ignite!.deviceDisabledReason}` });
      return sendJson(response, 200, await device.logs(boundedInteger(url.searchParams.get("lines"), 500, 20, 2000, "lines")));
    case "/v1/ignite/notebooks":
      return sendJson(response, 200, bridge.notebooks());
    case "/v1/ignite/page": {
      const number = url.searchParams.get("page");
      const page = bridge.page({
        ...(url.searchParams.get("pageId") ? { pageId: url.searchParams.get("pageId")! } : {}),
        ...(url.searchParams.get("notebook") !== null ? { notebook: url.searchParams.get("notebook")! } : {}),
        ...(number !== null ? { number: Number(number) } : {})
      });
      if (!page) return sendJson(response, 404, { error: "Kindle page not found" });
      const { imagePath, ...view } = page;
      let image: { mimeType: string; base64: string } | null = null;
      if (url.searchParams.get("image") === "1" && imagePath) {
        image = await readFile(imagePath).then((data) => ({ mimeType: "image/png", base64: data.toString("base64") }), () => null);
      }
      return sendJson(response, 200, { ...view, image });
    }
  }
  if (url.pathname.startsWith("/v1/living/")) {
    if (!living) return sendJson(response, 503, { error: `Living Notebooks is not available: ${ignite!.livingDisabledReason}` });
    if (url.pathname === "/v1/living/status") return sendJson(response, 200, { ...(await living.service.status()), watcher: living.watcher?.status() ?? null });
    if (url.pathname === "/v1/living/turns") return sendJson(response, 200, { turns: await living.service.turns(boundedInteger(url.searchParams.get("limit"), 20, 1, 100, "limit")) });
    if (url.pathname === "/v1/living/changes") {
      const after = url.searchParams.get("after");
      return sendJson(response, 200, await living.service.recentChanges(after === null ? undefined : Number(after)));
    }
  }
  sendJson(response, 404, { error: "Not found" });
}

function parseWriteRequest(body: unknown): WriteRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  switch (value.kind) {
    case "note": {
      const notePath = str("notePath");
      if (!notePath) throw new WriterError(400, "notePath is required");
      return { kind: "note", notePath, title: str("title"), paper: str("paper") as "blank" | undefined, extraPages: value.extraPages === undefined ? undefined : Number(value.extraPages), folder: str("folder") };
    }
    case "move-notebook": {
      const notebooks = value.notebooks;
      if (!Array.isArray(notebooks) || notebooks.length === 0 || notebooks.some((item) => typeof item !== "string" || !item.trim())) {
        throw new WriterError(400, "notebooks must be a non-empty list of notebook titles or ids");
      }
      if (value.folder !== null && typeof value.folder !== "string") throw new WriterError(400, "folder must be a folder name, or null for the top level");
      return { kind: "move-notebook", notebooks: notebooks as string[], folder: value.folder as string | null };
    }
    case "notebook":
      return { kind: "notebook", spec: value.spec };
    case "delete-notebook":
    case "delete-page": {
      const notebook = str("notebook");
      if (!notebook) throw new WriterError(400, "notebook is required");
      return value.kind === "delete-notebook" ? { kind: "delete-notebook", notebook } : { kind: "delete-page", notebook, page: Number(value.page) };
    }
    default:
      throw new WriterError(400, "kind must be note, notebook, move-notebook, delete-notebook or delete-page");
  }
}

function parseDeviceFileRequest(body: unknown): DeviceFileRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  switch (value.kind) {
    case "push": {
      const sourcePath = str("sourcePath");
      if (!sourcePath) throw new WriterError(400, "sourcePath is required");
      return { kind: "push", sourcePath, destination: str("destination") };
    }
    case "move": {
      const source = str("source"), destination = str("destination");
      if (!source || !destination) throw new WriterError(400, "source and destination are required");
      return { kind: "move", source, destination };
    }
    case "delete": {
      const devicePath = str("path");
      if (!devicePath) throw new WriterError(400, "path is required");
      return { kind: "delete", path: devicePath };
    }
    default:
      throw new WriterError(400, "kind must be push, move or delete");
  }
}

async function previewImages(previews: { page: number; path: string }[], limit: number): Promise<{ page: number; mimeType: string; base64: string }[]> {
  const out = [];
  for (const preview of previews.slice(0, limit)) {
    out.push({ page: preview.page, mimeType: "image/png", base64: (await readFile(preview.path)).toString("base64") });
  }
  return out;
}

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(provided, expected);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > maximumBytes) throw new InputError("Request body is too large");
    chunks.push(value);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new InputError(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("COMPANION_API_PORT must be a valid port");
  return parsed;
}

function requireToken(value: string | undefined): string {
  if (!value || value.length < 32) throw new Error("COMPANION_API_TOKEN must be set to at least 32 characters");
  return value;
}

function requireVault(value: string | undefined): string {
  if (!value) throw new Error("COMPANION_VAULT_PATH is required (the Markdown folder notebooks are mirrored into)");
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`COMPANION_VAULT_PATH does not exist: ${resolved}`);
  return resolved;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
