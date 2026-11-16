import { describe, expect, it } from "vitest";
import { createLocalMcpServer, type LocalApi } from "./tools.js";

type Handler = (input: unknown) => Promise<{ content: { type: string; text?: string; data?: string }[] }>;

function tools(api: LocalApi): Map<string, { handler: Handler; annotations?: { readOnlyHint?: boolean } }> {
  const server = createLocalMcpServer(api) as unknown as { _registeredTools: Record<string, { handler: Handler; annotations?: { readOnlyHint?: boolean } }> };
  return new Map(Object.entries(server._registeredTools));
}

describe("local MCP tools", () => {
  const calls: string[] = [];
  const api: LocalApi = {
    get: async (path, query) => {
      calls.push(`${path}?${new URLSearchParams(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)])).toString()}`);
      if (path === "/v1/ignite/page") {
        return {
          notebookTitle: "Notebook 1", number: Number(query?.page), pageCount: 2, pageId: `p${query?.page}`, strokeCount: 3,
          typedText: [], transcription: `text ${query?.page}`, notePath: "Kindle/Notebook 1.md",
          image: query?.image ? { mimeType: "image/png", base64: "iVBOR" } : null
        };
      }
      if (path === "/v1/ignite/screenshot") return { mimeType: "image/png", base64: "SCREEN", width: 1860, height: 2480, inverted: false };
      return { ok: true };
    },
    post: async (path, body) => {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      if (path.startsWith("/v1/ignite/plan")) {
        return { planId: "abcdef012345", kind: "note", summary: "Create a new Kindle notebook", title: "T", pages: 3, warnings: [], expiresAt: "x", sourceNote: "a.md",
          images: path.includes("images=1") ? [{ page: 1, mimeType: "image/png", base64: "P1" }] : undefined };
      }
      if (path === "/v1/ignite/files/plan") {
        return { planId: "123456abcdef", kind: "push", createdAt: "a", expiresAt: "b", summary: "Push PDF", source: "Reading/a.pdf",
          destination: "/mnt/us/documents/a.pdf", bytes: 42, sha256: "a".repeat(64), appliedAt: null };
      }
      return { posted: path };
    }
  };

  it("keeps every tool read-only except the ones that write (apply, undo, enable)", () => {
    const registered = tools(api);
    const writers = ["kindle_apply_plan", "kindle_enable_living", "kindle_undo_ai_edit"];
    expect([...registered.keys()].sort()).toEqual([
      "kindle_ai_turns", "kindle_apply_plan", "kindle_enable_living",
      "kindle_files_delete", "kindle_files_list", "kindle_files_move", "kindle_files_push", "kindle_list_notebooks", "kindle_logs",
      "kindle_plan_delete", "kindle_plan_move_notebook", "kindle_plan_notebook", "kindle_plan_send_note", "kindle_preview_page", "kindle_propose_page_edit",
      "kindle_read_notebook", "kindle_read_page", "kindle_recent_changes", "kindle_screenshot", "kindle_status", "kindle_sync_now", "kindle_undo_ai_edit"
    ]);
    for (const [name, tool] of registered) {
      expect(tool.annotations?.readOnlyHint, name).toBe(!writers.includes(name));
    }
    expect((registered.get("kindle_apply_plan")!.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
    expect((registered.get("kindle_undo_ai_edit")!.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
  });

  it("plans are dry runs that return a preview and ask for confirmation", async () => {
    calls.length = 0;
    const result = await tools(api).get("kindle_plan_send_note")!.handler({ notePath: "Tasks.md", paper: "lined", extraPages: 1 });
    expect(calls).toEqual([`POST /v1/ignite/plan?images=1 {"kind":"note","notePath":"Tasks.md","paper":"lined","extraPages":1}`]);
    expect(result.content[0]!.text).toContain("only after they explicitly say yes");
    expect(result.content[1]).toEqual({ type: "image", data: "P1", mimeType: "image/png" });
    expect(result.content[2]!.text).toContain("1 of 3");
    const del = await tools(api).get("kindle_plan_delete")!.handler({ notebook: "Old", page: 2 });
    expect(calls.at(-1)).toBe(`POST /v1/ignite/plan {"kind":"delete-page","notebook":"Old","page":2}`);
    expect(del.content).toHaveLength(1);
  });

  it("passes a folder for new notebooks and plans folder moves", async () => {
    calls.length = 0;
    await tools(api).get("kindle_plan_send_note")!.handler({ notePath: "Tasks.md", folder: "Weekly" });
    expect(calls[0]).toBe(`POST /v1/ignite/plan?images=1 {"kind":"note","notePath":"Tasks.md","folder":"Weekly"}`);
    const move = tools(api).get("kindle_plan_move_notebook")!;
    const result = await move.handler({ notebooks: ["Project Review", "Quarterly Check-in"], folder: "Review" });
    expect(calls[1]).toBe(`POST /v1/ignite/plan {"kind":"move-notebook","notebooks":["Project Review","Quarterly Check-in"],"folder":"Review"}`);
    expect(result.content[0]!.text).toContain("only after they explicitly say yes");
    await move.handler({ notebooks: ["Week 12"], topLevel: true });
    expect(calls[2]).toBe(`POST /v1/ignite/plan {"kind":"move-notebook","notebooks":["Week 12"],"folder":null}`);
    await expect(move.handler({ notebooks: ["Week 12"] })).rejects.toThrow(/folder or topLevel/);
    await expect(move.handler({ notebooks: ["Week 12"], folder: "Review", topLevel: true })).rejects.toThrow(/folder or topLevel/);
    expect(calls).toHaveLength(3);
  });

  it("returns the page image as MCP image content next to the transcription", async () => {
    const result = await tools(api).get("kindle_read_page")!.handler({ notebook: "Notebook 1", page: 2 });
    expect(result.content[0]!.text).toContain("text 2");
    expect(result.content[0]!.text).not.toContain("iVBOR");
    expect(result.content[1]).toEqual({ type: "image", data: "iVBOR", mimeType: "image/png" });
  });

  it("plans device-file changes and exposes screenshot/log reads", async () => {
    calls.length = 0;
    const push = await tools(api).get("kindle_files_push")!.handler({ sourcePath: "Reading/a.pdf", destination: "/mnt/us/documents/a.pdf" });
    expect(calls[0]).toBe('POST /v1/ignite/files/plan {"kind":"push","sourcePath":"Reading/a.pdf","destination":"/mnt/us/documents/a.pdf"}');
    expect(push.content[0]!.text).toContain("only after they explicitly say yes");
    const screenshot = await tools(api).get("kindle_screenshot")!.handler({});
    expect(screenshot.content[1]).toEqual({ type: "image", data: "SCREEN", mimeType: "image/png" });
    await tools(api).get("kindle_logs")!.handler({ lines: 200 });
    expect(calls.at(-1)).toBe("/v1/ignite/logs?lines=200");
  });

  it("reads every page of a notebook as text", async () => {
    calls.length = 0;
    const result = await tools(api).get("kindle_read_notebook")!.handler({ notebook: "Notebook 1" });
    const parsed = JSON.parse(result.content[0]!.text!) as { pages: { transcription: string }[] };
    expect(parsed.pages.map((page) => page.transcription)).toEqual(["text 1", "text 2"]);
    expect(calls.every((call) => !call.includes("image=1"))).toBe(true);
  });
});
