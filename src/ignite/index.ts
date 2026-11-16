import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IgniteBridge } from "./bridge.js";
import { IgniteClient } from "./client.js";
import { PageRenderer } from "./renderer.js";
import { VaultMirror } from "./vault-mirror.js";
import { IgniteWriter, zshBackup } from "./writer.js";
import { KindleDevice } from "./device.js";
import { createLiving, type LivingServices } from "../living/index.js";

export { IgniteBridge, resolveNotebook } from "./bridge.js";
export { IgniteWriter, WriterError } from "./writer.js";
export { KindleDevice } from "./device.js";

export interface IgniteServices {
  bridge: IgniteBridge;
  writer: IgniteWriter | undefined;
  writerDisabledReason: string | null;
  device: KindleDevice | undefined;
  deviceDisabledReason: string | null;
  /** Living Notebooks: AI answers written into pages (pen marks and page-edit tools). */
  living: LivingServices | undefined;
  livingDisabledReason: string | null;
}

/**
 * Enabled only when `COMPANION_IGNITE_TOKEN_FILE` is set. Other settings (all optional):
 * COMPANION_IGNITE_URL (http://127.0.0.1:8787), COMPANION_IGNITE_VAULT_FOLDER (Kindle),
 * COMPANION_IGNITE_POLL_SECONDS (30), COMPANION_IGNITE_OCR_LANGUAGES (en-US),
 * COMPANION_IGNITE_LIBRARY_ID, COMPANION_IGNITE_RENDER_BIN, COMPANION_IGNITE_STATE_DIR, COMPANION_IGNITE_FONT.
 *
 * Writing (Mac → Kindle) additionally needs the Ignite service's `ignite-import` and
 * `backup.zsh`, and the sync server's data folder: COMPANION_IGNITE_IMPORT_BIN,
 * COMPANION_IGNITE_BACKUP_SCRIPT (default: the Ignite launch agent's copies),
 * COMPANION_IGNITE_DATA_DIR (required; no default), COMPANION_IGNITE_PREWRITE_BACKUPS
 * (<state dir>/backups/pre-write, 30 kept). COMPANION_IGNITE_WRITES=off disables writing.
 *
 * Direct Kindle file access over SSH needs COMPANION_KINDLE_HOST, COMPANION_KINDLE_KEY and
 * COMPANION_KINDLE_KNOWN_HOSTS (no defaults), plus COMPANION_KINDLE_PORT (2222) and
 * COMPANION_KINDLE_BOOKS_ROOT (/mnt/us/scribe-app/books). Without them, or with
 * COMPANION_KINDLE_DEVICE=off, it stays disabled.
 */
export async function createIgnite(vaultPath: string, env: NodeJS.ProcessEnv = process.env): Promise<IgniteServices | undefined> {
  const client = await IgniteClient.fromEnvironment(env);
  if (!client) return undefined;
  const home = os.homedir();
  const support = path.join(home, "Library", "Application Support", "Ignite Companion");
  const igniteApp = path.join(home, "Library", "Application Support", "Ignite");
  const binary = env.COMPANION_IGNITE_RENDER_BIN ?? path.join(support, "native", "ignite-render");
  if (!existsSync(binary)) throw new Error(`Ignite renderer missing at ${binary}; run "npm run build:native"`);
  const pollSeconds = Number(env.COMPANION_IGNITE_POLL_SECONDS ?? "30");
  if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new Error("COMPANION_IGNITE_POLL_SECONDS must be 5..3600");
  const font = env.COMPANION_IGNITE_FONT ?? path.join(igniteApp, "fonts", "default-sans-v1.ttf");
  const renderer = PageRenderer.native(binary, 300_000, existsSync(font) ? font : undefined);
  const stateDir = env.COMPANION_IGNITE_STATE_DIR ?? path.join(support, "ignite");
  const mirror = new VaultMirror(vaultPath, env.COMPANION_IGNITE_VAULT_FOLDER ?? "Kindle");

  let device: KindleDevice | undefined;
  let deviceDisabledReason: string | null = null;
  const kindleHost = env.COMPANION_KINDLE_HOST?.trim();
  const kindleKey = env.COMPANION_KINDLE_KEY;
  const kindleKnownHosts = env.COMPANION_KINDLE_KNOWN_HOSTS;
  const kindlePort = Number(env.COMPANION_KINDLE_PORT ?? "2222");
  if (env.COMPANION_KINDLE_DEVICE === "off") deviceDisabledReason = "COMPANION_KINDLE_DEVICE=off";
  else if (!kindleHost || !kindleKey || !kindleKnownHosts) deviceDisabledReason = "set COMPANION_KINDLE_HOST, COMPANION_KINDLE_KEY and COMPANION_KINDLE_KNOWN_HOSTS to reach the Kindle over SSH";
  else if (!existsSync(kindleKey)) deviceDisabledReason = `Kindle SSH key missing at ${kindleKey}`;
  else if (!existsSync(kindleKnownHosts)) deviceDisabledReason = `Kindle known-hosts file missing at ${kindleKnownHosts}`;
  else if (!Number.isInteger(kindlePort) || kindlePort < 1 || kindlePort > 65535) deviceDisabledReason = "COMPANION_KINDLE_PORT must be 1..65535";
  else {
    device = new KindleDevice({
      host: kindleHost,
      port: kindlePort,
      keyPath: kindleKey,
      knownHostsPath: kindleKnownHosts,
      vaultPath,
      stateDir: path.join(stateDir, "device"),
      booksRoot: env.COMPANION_KINDLE_BOOKS_ROOT
    });
  }

  let writer: IgniteWriter | undefined;
  let writerDisabledReason: string | null = null;
  const importBinary = env.COMPANION_IGNITE_IMPORT_BIN ?? path.join(igniteApp, "bin", "ignite-import");
  const backupScript = env.COMPANION_IGNITE_BACKUP_SCRIPT ?? path.join(igniteApp, "backup.zsh");
  const dataDir = env.COMPANION_IGNITE_DATA_DIR ?? "";
  if (env.COMPANION_IGNITE_WRITES === "off") writerDisabledReason = "COMPANION_IGNITE_WRITES=off";
  else if (!dataDir) writerDisabledReason = "set COMPANION_IGNITE_DATA_DIR to the sync server's data folder to enable writing";
  else if (!existsSync(importBinary)) writerDisabledReason = `ignite-import missing at ${importBinary}`;
  else if (!existsSync(backupScript)) writerDisabledReason = `backup script missing at ${backupScript}`;
  else if (!existsSync(path.join(dataDir, "ledger.sqlite3"))) writerDisabledReason = `no ledger at ${dataDir}`;

  // The bridge and writer reference each other (writer resolves notebooks through the bridge's
  // snapshot; the bridge reads the writer's log), so the bridge is created first.
  const bridge: IgniteBridge = new IgniteBridge({
    client,
    renderer,
    mirror,
    stateDir,
    libraryId: env.COMPANION_IGNITE_LIBRARY_ID,
    pollMs: pollSeconds * 1000,
    ocrLanguages: (env.COMPANION_IGNITE_OCR_LANGUAGES ?? "en-US").split(",").map((item) => item.trim()).filter(Boolean),
    printedStrokes: () => writer?.printedStrokeIds() ?? Promise.resolve(new Set()),
    sourceNotes: () => writer?.sourceNotes() ?? Promise.resolve(new Map())
  });
  if (!writerDisabledReason) {
    writer = new IgniteWriter({
      importBinary,
      serverUrl: client.url,
      tokenFile: env.COMPANION_IGNITE_TOKEN_FILE!,
      libraryId: env.COMPANION_IGNITE_LIBRARY_ID,
      stateDir: path.join(stateDir, "writer"),
      vaultPath,
      mirrorFolder: mirror.folder,
      renderer,
      backup: zshBackup(backupScript, dataDir, env.COMPANION_IGNITE_PREWRITE_BACKUPS ?? path.join(stateDir, "backups", "pre-write"), 30),
      resolveNotebook: (selector) => bridge.findNotebook(selector),
      afterWrite: () => void bridge.sync({ force: true })
    });
  }
  const ocrLanguages = (env.COMPANION_IGNITE_OCR_LANGUAGES ?? "en-US").split(",").map((item) => item.trim()).filter(Boolean);
  const { living, reason: livingDisabledReason } = createLiving({
    client,
    renderer,
    serverUrl: client.url,
    tokenFile: env.COMPANION_IGNITE_TOKEN_FILE!,
    libraryId: env.COMPANION_IGNITE_LIBRARY_ID,
    stateDir: path.join(stateDir, "living"),
    vaultPath,
    writerReplicaFile: path.join(stateDir, "writer", "replica", "ignite-import-replica.json"),
    ocrLanguages
  }, env);
  return { bridge, writer, writerDisabledReason, device, deviceDisabledReason, living, livingDisabledReason };
}
