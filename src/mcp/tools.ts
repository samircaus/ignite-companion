import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Minimal client for the Ignite Companion API (loopback). */
export interface LocalApi {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

interface PageResponse {
  notebookTitle: string;
  number: number;
  pageCount: number;
  pageId: string;
  strokeCount: number;
  typedText: string[];
  transcription: string | null;
  notePath: string | null;
  image: { mimeType: string; base64: string } | null;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

interface PlanResponse {
  planId: string;
  kind: string;
  summary: string;
  title: string;
  pages: number;
  warnings: string[];
  expiresAt: string;
  sourceNote: string | null;
  folder?: { title: string; created: boolean } | null;
  notebooks?: { notebookId: string; title: string; from: string | null }[];
  images?: { page: number; mimeType: string; base64: string }[];
}

interface DevicePlanResponse {
  planId: string;
  kind: "push" | "move" | "delete";
  createdAt: string;
  expiresAt: string;
  summary: string;
  source: string;
  destination: string | null;
  bytes: number;
  sha256: string;
  appliedAt: string | null;
}

const plans = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const APPLY_HINT = "Nothing has been sent. Show the user the summary (and the preview pages), and call kindle_apply_plan with this planId only after they explicitly say yes.";

function planResult(plan: PlanResponse): CallToolResult {
  const { images, ...meta } = plan;
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ ...meta, next: APPLY_HINT }, null, 2) }];
  for (const image of images ?? []) content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
  if (plan.pages > (images?.length ?? 0) && images?.length) {
    content.push({ type: "text", text: `Showing ${images.length} of ${plan.pages} preview pages; kindle_preview_page shows the others.` });
  }
  return { content };
}

function devicePlanResult(plan: DevicePlanResponse): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ...plan, next: APPLY_HINT }, null, 2) }] };
}

/**
 * Tools over the Kindle Scribe (Ignite) library and its Markdown mirror. All are read-only
 * except kindle_apply_plan, which writes a plan made by one of the kindle_plan_* tools (dry runs
 * with a rendered preview) to the Ignite sync server, after a ledger backup.
 */
export function createLocalMcpServer(api: LocalApi): McpServer {
  const server = new McpServer({ name: "Ignite Companion", version: "0.1.0" });
  const notebook = z.string().trim().min(1).max(200).describe("Notebook title, a unique part of it, its id, or its 0-based index from kindle_list_notebooks");
  const folder = z.string().trim().min(1).max(96).optional().describe("Ignite notebook folder to file the new notebook in, e.g. \"Weekly\" (matched ignoring case). A folder that does not exist yet is CREATED by the write; the summary says so. Omit for the top level.");

  server.registerTool("kindle_status", {
    description: "Status of the Kindle Scribe (Ignite) bridge: whether the sync server is reachable, the latest synced sequence, notebook/page counts, last vault update and any problems.",
    inputSchema: z.object({}), annotations: readOnly
  }, async () => json(await api.get("/v1/ignite/status")));

  server.registerTool("kindle_list_notebooks", {
    description: "List the notebooks on the Kindle Scribe with page counts, a short preview of each page's recognised handwriting, and the Markdown note that mirrors each notebook.",
    inputSchema: z.object({}), annotations: readOnly
  }, async () => json(await api.get("/v1/ignite/notebooks")));

  server.registerTool("kindle_read_page", {
    description: "Read one Kindle notebook page: returns the page as an image (handwriting, drawings, paper) plus the automatic handwriting transcription and any typed text. Look at the image when the transcription is missing or doubtful; drawings are only in the image.",
    inputSchema: z.object({ notebook, page: z.number().int().min(1).max(1000).default(1).describe("1-based page number") }),
    annotations: readOnly
  }, async ({ notebook: selector, page }) => {
    const result = await api.get("/v1/ignite/page", { notebook: selector, page, image: 1 }) as PageResponse;
    const { image, ...meta } = result;
    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(meta, null, 2) }];
    if (image) content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
    return { content };
  });

  server.registerTool("kindle_read_notebook", {
    description: "Read a whole Kindle notebook as text: every page's handwriting transcription and typed text, in order, plus the mirrored Markdown note path. Use kindle_read_page to see a page's image.",
    inputSchema: z.object({ notebook }), annotations: readOnly
  }, async ({ notebook: selector }) => {
    const first = await api.get("/v1/ignite/page", { notebook: selector, page: 1 }) as PageResponse;
    const pages = [first];
    for (let number = 2; number <= first.pageCount; number++) {
      pages.push(await api.get("/v1/ignite/page", { notebook: selector, page: number }) as PageResponse);
    }
    return json({
      notebook: first.notebookTitle, notePath: first.notePath, pageCount: first.pageCount,
      pages: pages.map((page) => ({ page: page.number, strokes: page.strokeCount, transcription: page.transcription, typedText: page.typedText }))
    });
  });

  server.registerTool("kindle_sync_now", {
    description: "Pull the latest Kindle changes from the Mac's Ignite sync server into the Markdown mirror right away instead of waiting for the next poll. Only reads the Kindle library; it does not change the Kindle.",
    inputSchema: z.object({}), annotations: { ...readOnly, idempotentHint: true }
  }, async () => json(await api.post("/v1/ignite/sync")));

  server.registerTool("kindle_files_list", {
    description: "List files on the Kindle under one of the only two accessible roots: /mnt/us/documents (Kindle library and KOReader) or /mnt/us/scribe-app/books (Ignite Books). This is read-only.",
    inputSchema: z.object({
      root: z.enum(["documents", "books"]).default("documents"),
      recursive: z.boolean().default(true)
    }),
    annotations: readOnly
  }, async ({ root, recursive }) => json(await api.get("/v1/ignite/files", { root, recursive: recursive ? 1 : 0 })));

  server.registerTool("kindle_files_push", {
    description: "PLAN pushing a file from the vault to the Kindle over its Mac-only Wi-Fi SSH channel. This is a dry run: it snapshots the vault file and returns destination, size and SHA-256; nothing is uploaded until kindle_apply_plan is explicitly approved. Destinations are restricted to /mnt/us/documents and /mnt/us/scribe-app/books, and existing files are never replaced.",
    inputSchema: z.object({
      sourcePath: z.string().trim().min(1).max(1000).describe("Vault-relative file path"),
      destination: z.string().trim().min(1).max(1000).optional().describe("Absolute allowed Kindle path; defaults to /mnt/us/documents/<source filename>")
    }),
    annotations: plans
  }, async (input) => devicePlanResult(await api.post("/v1/ignite/files/plan", { kind: "push", ...input }) as DevicePlanResponse));

  server.registerTool("kindle_files_move", {
    description: "PLAN moving one Kindle file between allowed document/book paths. This is a dry run and records the exact size and SHA-256. kindle_apply_plan rechecks the file, creates a recoverable device backup, and only then moves it. Existing destinations are never replaced.",
    inputSchema: z.object({
      source: z.string().trim().min(1).max(1000),
      destination: z.string().trim().min(1).max(1000)
    }),
    annotations: plans
  }, async (input) => devicePlanResult(await api.post("/v1/ignite/files/plan", { kind: "move", ...input }) as DevicePlanResponse));

  server.registerTool("kindle_files_delete", {
    description: "PLAN removing a file from an allowed Kindle document/book path. This is a dry run and records the exact size and SHA-256. kindle_apply_plan rechecks it and moves it to a recoverable quarantine instead of erasing it.",
    inputSchema: z.object({ path: z.string().trim().min(1).max(1000) }),
    annotations: plans
  }, async ({ path }) => devicePlanResult(await api.post("/v1/ignite/files/plan", { kind: "delete", path }) as DevicePlanResponse));

  server.registerTool("kindle_screenshot", {
    description: "Capture the Kindle's current 1860×2480 framebuffer over Wi-Fi SSH and return it as a PNG. This is read-only.",
    inputSchema: z.object({}), annotations: readOnly
  }, async () => {
    const result = await api.get("/v1/ignite/screenshot") as { mimeType: string; base64: string; width: number; height: number; inverted: boolean };
    const { base64, ...meta } = result;
    return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, { type: "image", data: base64, mimeType: result.mimeType }] };
  });

  server.registerTool("kindle_logs", {
    description: "Read the latest Ignite launch/session and lifecycle logs from the Kindle over Wi-Fi SSH, including counts of pen-ups, input stalls, rejected swipes, faults and errors. This is read-only.",
    inputSchema: z.object({ lines: z.number().int().min(20).max(2000).default(500) }), annotations: readOnly
  }, async ({ lines }) => json(await api.get("/v1/ignite/logs", { lines })));

  server.registerTool("kindle_plan_send_note", {
    description: "Plan sending an Markdown note to the Kindle Scribe as a NEW notebook (dry run: nothing is sent). The note is laid out with the Kindle's own font: headings, paragraphs, lists, quotes; tasks become real ink checkboxes the user can tick with the pen. Returns a planId, a one-line summary and preview images of the pages. Images and embeds are sent as placeholders only. After sending, the user's handwriting on those pages flows back into the vault mirror under Kindle/.",
    inputSchema: z.object({
      notePath: z.string().trim().min(1).max(500).describe("Path of the note relative to the vault (Markdown folder)"),
      title: z.string().trim().min(1).max(96).optional().describe("Notebook title (default: the note's first H1 or file name)"),
      paper: z.enum(["blank", "lined", "dot", "grid"]).default("blank").describe("Background paper for all pages"),
      extraPages: z.number().int().min(0).max(20).default(0).describe("Empty pages appended for handwriting"),
      folder
    }),
    annotations: plans
  }, async (input) => planResult(await api.post("/v1/ignite/plan?images=1", { kind: "note", ...input }) as PlanResponse));

  server.registerTool("kindle_plan_notebook", {
    description: "Plan creating a NEW Kindle notebook from a page spec (dry run: nothing is sent). Spec: {\"notebook\":{\"title\":\"…\", \"folder\":\"Weekly\"},\"pages\":[{\"paper\":\"blank|lined|dot|grid\", \"labels\":[{\"text\":\"HELLO\",\"x\":0.08,\"y\":0.12,\"size\":0.04}], \"shapes\":[{\"kind\":\"rect\",\"x\",\"y\",\"w\",\"h\"} | {\"kind\":\"ellipse\",\"cx\",\"cy\",\"rx\",\"ry\"} | {\"kind\":\"line\"|\"arrow\",\"from\":[x,y],\"to\":[x,y]}], \"strokes\":[{\"points\":[[x,y],…]}], \"texts\":[{\"x\",\"y\",\"width\",\"font_size\",\"content\"}]}]}. Coordinates are page-width units: x 0..1, y 0..1.333, and everything must stay within y 0.078..1.255 (Ignite's chrome bands are rejected). labels are erasable ink in a capital stroke font (A–Z 0–9 .,-:!?'/()+); texts are typed, display-only on the Kindle (font_size ~0.023 reads well). notebook.folder (optional) files the notebook in that Ignite folder, matched ignoring case; a missing folder is CREATED by the write and the summary says so. Returns a planId, summary and page previews.",
    inputSchema: z.object({ spec: z.record(z.string(), z.unknown()).describe("The page spec object") }),
    annotations: plans
  }, async ({ spec }) => planResult(await api.post("/v1/ignite/plan?images=1", { kind: "notebook", spec }) as PlanResponse));

  server.registerTool("kindle_plan_delete", {
    description: "Plan deleting a whole Kindle notebook, or one page of it (dry run: nothing is sent). Returns a planId and exactly what would be deleted. The Kindle quarantines deleted items rather than erasing them, but they disappear from Ignite. The last page of a notebook cannot be deleted.",
    inputSchema: z.object({ notebook, page: z.number().int().min(1).max(1000).optional().describe("1-based page to delete; omit to delete the whole notebook") }),
    annotations: plans
  }, async ({ notebook: selector, page }) => planResult(await api.post("/v1/ignite/plan", page === undefined
    ? { kind: "delete-notebook", notebook: selector }
    : { kind: "delete-page", notebook: selector, page }) as PlanResponse));

  server.registerTool("kindle_plan_move_notebook", {
    description: "Plan moving existing Kindle notebooks into an Ignite notebook folder, or back to the top level (dry run: nothing is sent). Only folder membership changes (Ignite's own SetNotebookFolder); pages and ink are not touched. The folder is matched by name ignoring case; a folder that does not exist yet is CREATED by the write and the summary says so. Notebooks already in that folder are listed and skipped. Returns a planId and a summary naming the folder and every notebook; apply with kindle_apply_plan after the user's yes. The vault mirror then moves the notes to Kindle/<Folder>/.",
    inputSchema: z.object({
      notebooks: z.array(notebook).min(1).max(50).describe("The notebooks to move (title, unique part of it, id, or index)"),
      folder: z.string().trim().min(1).max(96).optional().describe("Destination folder name, e.g. \"Review\""),
      topLevel: z.boolean().default(false).describe("Move the notebooks out of any folder, back to the top level (instead of folder)")
    }),
    annotations: plans
  }, async ({ notebooks, folder: name, topLevel }) => {
    if ((name === undefined) === !topLevel) throw new Error("Give either folder or topLevel: true");
    return planResult(await api.post("/v1/ignite/plan", { kind: "move-notebook", notebooks, folder: topLevel ? null : name }) as PlanResponse);
  });

  server.registerTool("kindle_preview_page", {
    description: "Show one preview page of a pending Kindle write plan (from kindle_plan_send_note or kindle_plan_notebook).",
    inputSchema: z.object({ planId: z.string().regex(/^[0-9a-f]{12}$/), page: z.number().int().min(1).max(200) }),
    annotations: readOnly
  }, async ({ planId, page }) => {
    const result = await api.get("/v1/ignite/plan", { planId, page }) as { images: { mimeType: string; base64: string }[] };
    return { content: result.images.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType })) };
  });

  server.registerTool("kindle_apply_plan", {
    description: "WRITE a planned change after the user has seen its summary/preview and explicitly agreed. Notebook plans take a verified ledger backup first. Device-file pushes verify the uploaded checksum; moves are backed up first; deletes go to recoverable quarantine. Each plan can be applied once, within 30 minutes.",
    inputSchema: z.object({ planId: z.string().regex(/^[0-9a-f]{12}$/) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ planId }) => json(await api.post("/v1/ignite/apply", { planId })));

  // Living Notebooks: AI answers written into existing pages as handwriting ink.
  server.registerTool("kindle_recent_changes", {
    description: "What the user wrote on the Kindle recently: per page, how many strokes they added and erased since a ledger sequence, and any circled (?) or (+) command marks in that ink (with whether they were already answered). Read-only. Use it to find \"what I just circled\" before reading the page with kindle_read_page.",
    inputSchema: z.object({ afterSeq: z.number().int().min(0).optional().describe("Ledger sequence to look after; default: the last ~2000 operations") }),
    annotations: readOnly
  }, async ({ afterSeq }) => json(await api.get("/v1/living/changes", { after: afterSeq })));

  server.registerTool("kindle_propose_page_edit", {
    description: "Plan writing onto an EXISTING Kindle page (dry run: nothing is sent): text as handwriting ink (thin pen, the size the user picked; erasable on the Kindle) and/or a small SVG drawing, placed in free space near a point, or on a new page inserted right after it (linked both ways) when it does not fit. Only adds ink; nothing on the page is changed. Text: plain, no Markdown, short lines; only letters, digits, äöüÄÖÜß and . , ; : ! ? - ' \" ( ) / + = * % & # @ → ← • ° € (others are dropped). SVG: a complete <svg> with viewBox, black strokes, rect/circle/ellipse/line/polyline/path and short <text> labels. Returns a planId, summary and a preview image; write with kindle_apply_plan after the user's yes. Each write is an AI turn that kindle_undo_ai_edit can remove.",
    inputSchema: z.object({
      notebook,
      page: z.number().int().min(1).max(1000).describe("1-based page number"),
      text: z.string().max(4000).default("").describe("Handwriting to write (plain text, newlines allowed)"),
      svg: z.string().max(200_000).optional().describe("Optional SVG drawing, placed below the text"),
      near: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1.34) }).optional().describe("Point (page-width units) to place the answer next to, e.g. where the user's question is; default: near the page's latest ink"),
      newPage: z.boolean().default(false).describe("Put it on a new page right after this one instead")
    }),
    annotations: plans
  }, async (input) => {
    const plan = await api.post("/v1/living/plan", input) as { images?: { mimeType: string; base64: string }[] } & Record<string, unknown>;
    const { images, preview: _preview, ...meta } = plan;
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...meta, next: APPLY_HINT }, null, 2) }, ...(images ?? []).map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mimeType }))] };
  });

  server.registerTool("kindle_ai_turns", {
    description: "Recent AI turns written into Kindle pages (from pen marks or kindle_propose_page_edit): turn id, notebook, page, what was asked, status (applied, undone, failed), and the Living Notebooks watcher state.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
    annotations: readOnly
  }, async ({ limit }) => json({ ...(await api.get("/v1/living/status") as object), turns: (await api.get("/v1/living/turns", { limit }) as { turns: unknown[] }).turns }));

  server.registerTool("kindle_undo_ai_edit", {
    description: "REMOVE the ink of one AI turn from its Kindle page (by turnId from kindle_ai_turns). Only ink the AI wrote is removed, never the user's own; a page the turn added stays (empty). Ask the user first.",
    inputSchema: z.object({ turnId: z.string().regex(/^[0-9a-f]{10}$/) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ turnId }) => json(await api.post("/v1/living/undo", { turnId })));

  server.registerTool("kindle_enable_living", {
    description: "Turn on the pen trigger for a Kindle notebook: a small circled (?) or (+) drawn there gets an AI answer written next to it. Creates (or updates) its note under \"Living Notebooks/\" in the vault with the chosen profile (General, Thinking, or one of the user's own in Living Notebooks/_profiles). Ask the user first.",
    inputSchema: z.object({ notebook, profile: z.string().trim().min(1).max(60).default("General") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input) => json(await api.post("/v1/living/enable", input)));

  return server;
}

export function httpLocalApi(baseUrl: string, token: string): LocalApi {
  const call = async (method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown) => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(method === "POST" ? 600_000 : 30_000)
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(`Ignite Companion ${response.status}: ${payload.error ?? response.statusText}`);
    return payload;
  };
  return {
    get: (path, query) => call("GET", path, query),
    post: (path, body) => call("POST", path, undefined, body ?? {})
  };
}
