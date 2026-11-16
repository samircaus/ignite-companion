import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IgniteClient } from "../ignite/client.js";
import type { PageRenderer } from "../ignite/renderer.js";
import { ClaudeCliInterpreter, CodexExecInterpreter, FallbackInterpreter, type Interpreter } from "./interpreter.js";
import { LivingService } from "./service.js";
import { LivingWatcher } from "./watcher.js";

export { LivingService, LivingError } from "./service.js";
export { LivingWatcher } from "./watcher.js";

export interface LivingServices { service: LivingService; watcher: LivingWatcher | undefined }

/**
 * Living Notebooks (AI answers as ink). Needs an `ignite-import` with `annotate` and `measure`:
 * COMPANION_LIVING_IMPORT_BIN (default `<support dir>/native/ignite-import-living`).
 * COMPANION_LIVING=off disables it, COMPANION_LIVING_WATCH=off keeps the tools but not the pen trigger.
 * Interpreters are tried in the order of COMPANION_LIVING_INTERPRETERS (default `codex,claude`):
 * `codex exec` (COMPANION_LIVING_CODEX, else COMPANION_CODEX_COMMAND, else ~/.local/bin/codex or `codex`
 * on PATH; COMPANION_LIVING_MODEL) and `claude -p` (COMPANION_LIVING_CLAUDE, default the first of ~/.bun/bin, ~/.local/bin, ~/.claude/local, else PATH;
 * COMPANION_LIVING_CLAUDE_MODEL). The next one answers when one fails (usage limit, signed out).
 */
export function createLiving(input: {
  client: IgniteClient;
  renderer: PageRenderer;
  serverUrl: string;
  tokenFile: string;
  libraryId?: string | undefined;
  stateDir: string;
  vaultPath: string;
  writerReplicaFile: string;
  ocrLanguages: string[];
}, env: NodeJS.ProcessEnv = process.env): { living: LivingServices | undefined; reason: string | null } {
  if (env.COMPANION_LIVING === "off") return { living: undefined, reason: "COMPANION_LIVING=off" };
  const home = os.homedir();
  const support = path.join(home, "Library", "Application Support", "Ignite Companion");
  const importBinary = env.COMPANION_LIVING_IMPORT_BIN ?? path.join(support, "native", "ignite-import-living");
  if (!existsSync(importBinary)) return { living: undefined, reason: `ignite-import with annotate missing at ${importBinary}` };
  const localCodex = path.join(home, ".local", "bin", "codex");
  const codex = env.COMPANION_LIVING_CODEX ?? env.COMPANION_CODEX_COMMAND ?? (existsSync(localCodex) ? localCodex : "codex");
  const claude = env.COMPANION_LIVING_CLAUDE ?? [path.join(home, ".bun", "bin", "claude"), path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude")].find((p) => existsSync(p)) ?? "claude";
  const log = (event: Record<string, unknown>): void => console.error(JSON.stringify(event));
  const available: Record<string, () => Interpreter> = {
    codex: () => new CodexExecInterpreter({ command: codex, model: env.COMPANION_LIVING_MODEL }),
    claude: () => new ClaudeCliInterpreter({ command: claude, model: env.COMPANION_LIVING_CLAUDE_MODEL })
  };
  const order = (env.COMPANION_LIVING_INTERPRETERS ?? "codex,claude").split(",").map((n) => n.trim()).filter((n) => n in available);
  const interpreter = new FallbackInterpreter((order.length ? order : ["codex"]).map((n) => available[n]!()), log);
  const service = new LivingService({
    client: input.client,
    renderer: input.renderer,
    importBinary,
    serverUrl: input.serverUrl,
    tokenFile: input.tokenFile,
    libraryId: input.libraryId,
    stateDir: input.stateDir,
    vaultPath: input.vaultPath,
    interpreter,
    ocrLanguages: input.ocrLanguages,
    log
  });
  const readReplica = async (file: string): Promise<string | null> => {
    try {
      return (JSON.parse(await readFile(file, "utf8")) as { replica_id?: string }).replica_id ?? null;
    } catch {
      return null;
    }
  };
  const watcher = env.COMPANION_LIVING_WATCH === "off" ? undefined : new LivingWatcher({
    client: input.client,
    libraryId: () => service.libraryId(),
    ownReplicas: async () => new Set([await service.replicaId(), await readReplica(input.writerReplicaFile)].filter((id): id is string => Boolean(id))),
    cursor: () => service.cursor(),
    setCursor: (seq) => service.setCursor(seq),
    consumed: () => service.consumed(),
    check: (pageId, fresh) => service.checkPage(pageId, fresh),
    intervalMs: Number(env.COMPANION_LIVING_POLL_MS ?? 3000),
    quietMs: Number(env.COMPANION_LIVING_QUIET_MS ?? 5000),
    log
  });
  return { living: { service, watcher }, reason: null };
}
