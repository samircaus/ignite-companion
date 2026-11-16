import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { WriterError } from "./writer.js";

const DOCUMENTS_ROOT = "/mnt/us/documents";
const DEFAULT_BOOKS_ROOT = "/mnt/us/scribe-app/books";
const DEVICE_BACKUP_ROOT = "/mnt/us/scribe-app/backups/files";
const PLAN_TTL_MS = 30 * 60_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

export type DeviceFileRequest =
  | { kind: "push"; sourcePath: string; destination?: string | undefined }
  | { kind: "move"; source: string; destination: string }
  | { kind: "delete"; path: string };

export interface DeviceFilePlan {
  planId: string;
  kind: DeviceFileRequest["kind"];
  createdAt: string;
  expiresAt: string;
  summary: string;
  source: string;
  destination: string | null;
  bytes: number;
  sha256: string;
  appliedAt: string | null;
}

export interface DeviceFileResult {
  planId: string;
  kind: DeviceFileRequest["kind"];
  summary: string;
  backup: string;
  path: string;
}

interface StoredDevicePlan extends DeviceFilePlan {
  payloadPath?: string | undefined;
  dir: string;
}

interface DeviceWriteRecord extends DeviceFileResult { at: string }

export interface SshResult { code: number | null; stdout: Buffer; stderr: string }
export type SshRunner = (command: string, input: Buffer | undefined, timeoutMs: number) => Promise<SshResult>;

export interface KindleDeviceOptions {
  host: string;
  port: number;
  keyPath: string;
  knownHostsPath: string;
  vaultPath: string;
  stateDir: string;
  booksRoot?: string | undefined;
  now?: (() => Date) | undefined;
  run?: SshRunner | undefined;
}

export class KindleDevice {
  readonly #plans = new Map<string, StoredDevicePlan>();
  readonly #run: SshRunner;
  readonly #now: () => Date;
  readonly #booksRoot: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: KindleDeviceOptions) {
    this.#run = options.run ?? sshRunner(options);
    this.#now = options.now ?? (() => new Date());
    this.#booksRoot = validateConfiguredRoot(options.booksRoot ?? DEFAULT_BOOKS_ROOT);
  }

  get roots(): readonly string[] { return [DOCUMENTS_ROOT, this.#booksRoot]; }
  get #plansDir(): string { return path.join(this.options.stateDir, "plans"); }
  get #logPath(): string { return path.join(this.options.stateDir, "device-writes.json"); }

  async list(root: "documents" | "books" = "documents", recursive = true): Promise<{ root: string; files: string[] }> {
    const selected = root === "books" ? this.#booksRoot : DOCUMENTS_ROOT;
    await this.#ensureRemoteRoot(selected, false);
    const depth = recursive ? "" : " -maxdepth 1";
    const result = await this.#ssh(`find ${shell(selected)}${depth} -type f -print0`, undefined, 30_000);
    return { root: selected, files: result.stdout.toString("utf8").split("\0").filter(Boolean).sort() };
  }

  async plan(request: DeviceFileRequest): Promise<DeviceFilePlan> {
    await this.#prune();
    const planId = randomBytes(6).toString("hex");
    const dir = path.join(this.#plansDir, planId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const createdAt = this.#now();
      let stored: StoredDevicePlan;
      if (request.kind === "push") {
        const source = await this.#vaultFile(request.sourcePath);
        const destination = this.#devicePath(request.destination ?? path.posix.join(DOCUMENTS_ROOT, path.basename(source.relative)), "destination");
        await this.#assertDestinationAvailable(destination);
        const payloadPath = path.join(dir, "payload");
        await copyFile(source.absolute, payloadPath);
        const info = await stat(payloadPath);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new WriterError(413, "Vault file is missing or larger than 512 MB");
        const sha256 = await fileSha256(payloadPath);
        stored = {
          planId, kind: request.kind, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
          summary: `Push vault file ${source.relative} (${formatBytes(info.size)}, SHA-256 ${sha256.slice(0, 16)}…) to ${destination}. No existing Kindle file will be replaced.`,
          source: source.relative, destination, bytes: info.size, sha256, appliedAt: null, payloadPath, dir
        };
      } else if (request.kind === "move") {
        const source = this.#devicePath(request.source, "source");
        const destination = this.#devicePath(request.destination, "destination");
        if (source === destination) throw new WriterError(400, "source and destination are the same path");
        const info = await this.#remoteFile(source);
        await this.#assertDestinationAvailable(destination);
        stored = {
          planId, kind: request.kind, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
          summary: `Move ${source} (${formatBytes(info.bytes)}, SHA-256 ${info.sha256.slice(0, 16)}…) to ${destination}, after making a recoverable device backup.`,
          source, destination, ...info, appliedAt: null, dir
        };
      } else {
        const source = this.#devicePath(request.path, "path");
        const info = await this.#remoteFile(source);
        stored = {
          planId, kind: request.kind, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
          summary: `Remove ${source} (${formatBytes(info.bytes)}, SHA-256 ${info.sha256.slice(0, 16)}…) from the Kindle-visible folders by moving it into a recoverable quarantine.`,
          source, destination: null, ...info, appliedAt: null, dir
        };
      }
      this.#plans.set(planId, stored);
      return publicPlan(stored);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  getPlan(planId: string): DeviceFilePlan | undefined {
    const plan = this.#plans.get(planId);
    return plan ? publicPlan(plan) : undefined;
  }

  apply(planId: string): Promise<DeviceFileResult> {
    const next = this.#queue.then(() => this.#apply(planId));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #apply(planId: string): Promise<DeviceFileResult> {
    const plan = this.#plans.get(planId);
    if (!plan) throw new WriterError(404, "Unknown or expired device-file plan id; make a new plan first");
    if (plan.appliedAt) throw new WriterError(409, `Plan ${planId} was already applied at ${plan.appliedAt}`);
    if (new Date(plan.expiresAt).getTime() < this.#now().getTime()) throw new WriterError(410, "The plan expired; make a new plan and check its preview again");

    const stamp = compactStamp(this.#now());
    const backupDir = `${DEVICE_BACKUP_ROOT}/${stamp}-${plan.planId}`;
    let backup: string;
    let resultPath: string;
    if (plan.kind === "push") {
      if (!plan.payloadPath || await fileSha256(plan.payloadPath) !== plan.sha256) throw new WriterError(409, "The planned vault-file snapshot changed; make a new plan");
      await this.#assertDestinationAvailable(plan.destination!);
      await this.#ensureDestinationParent(plan.destination!);
      const localBackupDir = path.join(this.options.stateDir, "backups", `${stamp}-${plan.planId}`);
      await mkdir(localBackupDir, { recursive: true, mode: 0o700 });
      backup = path.join(localBackupDir, path.basename(plan.destination!));
      await copyFile(plan.payloadPath, backup);
      const temp = `${plan.destination}.companion-${plan.planId}.new`;
      const payload = await readFile(plan.payloadPath);
      await this.#ssh(`umask 022; cat > ${shell(temp)} && chmod 644 ${shell(temp)} && sync`, payload, 300_000);
      const uploaded = (await this.#ssh(`sha256sum ${shell(temp)} | cut -d' ' -f1`, undefined, 30_000)).stdout.toString("utf8").trim();
      if (uploaded !== plan.sha256) {
        await this.#ssh(`rm -f ${shell(temp)}`, undefined, 30_000).catch(() => undefined);
        throw new WriterError(502, "Checksum mismatch after upload; the destination was not installed");
      }
      const installed = await this.#ssh(`if [ -e ${shell(plan.destination!)} ] || [ -L ${shell(plan.destination!)} ]; then exit 17; fi; mv ${shell(temp)} ${shell(plan.destination!)} && sync`, undefined, 30_000, true);
      if (installed.code === 17) {
        await this.#ssh(`rm -f ${shell(temp)}`, undefined, 30_000).catch(() => undefined);
        throw new WriterError(409, `Destination appeared after the plan: ${plan.destination}`);
      }
      if (installed.code !== 0) throw new WriterError(502, installed.stderr || "Could not install the uploaded file");
      resultPath = plan.destination!;
    } else {
      const current = await this.#remoteFile(plan.source);
      if (current.bytes !== plan.bytes || current.sha256 !== plan.sha256) throw new WriterError(409, "The Kindle source file changed since the plan; make a new plan");
      await this.#ssh(`mkdir -p ${shell(backupDir)} && chmod 700 ${shell(backupDir)}`, undefined, 30_000);
      if (plan.kind === "move") {
        await this.#assertDestinationAvailable(plan.destination!);
        await this.#ensureDestinationParent(plan.destination!);
        const saved = `${backupDir}/${path.posix.basename(plan.source)}`;
        const moved = await this.#ssh(`cp -p ${shell(plan.source)} ${shell(saved)} && sync && if [ -e ${shell(plan.destination!)} ] || [ -L ${shell(plan.destination!)} ]; then exit 17; fi; mv ${shell(plan.source)} ${shell(plan.destination!)} && sync`, undefined, 120_000, true);
        if (moved.code === 17) throw new WriterError(409, `Destination appeared after the plan; source backup is at ${saved}`);
        if (moved.code !== 0) throw new WriterError(502, moved.stderr || `Move failed; source backup is at ${saved}`);
        backup = saved;
        resultPath = plan.destination!;
      } else {
        const quarantined = `${backupDir}/${path.posix.basename(plan.source)}`;
        await this.#ssh(`mv ${shell(plan.source)} ${shell(quarantined)} && sync`, undefined, 120_000);
        backup = quarantined;
        resultPath = plan.source;
      }
    }
    plan.appliedAt = this.#now().toISOString();
    const result = { planId: plan.planId, kind: plan.kind, summary: plan.summary, backup, path: resultPath };
    await this.#append({ ...result, at: plan.appliedAt });
    return result;
  }

  async screenshot(): Promise<{ mimeType: "image/png"; base64: string; width: number; height: number; inverted: boolean }> {
    const stride = 1872, width = 1860, height = 2480;
    const raw = (await this.#ssh(`dd if=/dev/fb0 bs=${stride} count=${height} 2>/dev/null`, undefined, 60_000)).stdout;
    if (raw.length < stride * height) throw new WriterError(502, `Framebuffer capture was short (${raw.length} bytes)`);
    const polarity = (await this.#ssh("if [ -f /mnt/us/scribe-app/fb-polarity ]; then cat /mnt/us/scribe-app/fb-polarity; else grep 'complement=' /mnt/us/scribe-app/logs/scribe-app.child.log 2>/dev/null | tail -1; fi", undefined, 15_000)).stdout.toString("utf8");
    const inverted = /(^|\b)complement(?:=1)?(\b|$)/.test(polarity.trim());
    const pixels = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y++) {
      raw.copy(pixels, y * width, y * stride, y * stride + width);
      if (inverted) for (let x = y * width; x < (y + 1) * width; x++) pixels[x] = 255 - pixels[x]!;
    }
    const png = grayPng(width, height, pixels);
    return { mimeType: "image/png", base64: png.toString("base64"), width, height, inverted };
  }

  async logs(lines = 500): Promise<{ summary: Record<string, number>; latestSession: string; lifecycle: string }> {
    if (!Number.isInteger(lines) || lines < 20 || lines > 2000) throw new WriterError(400, "lines must be 20..2000");
    const child = (await this.#ssh(`tail -n ${lines} /mnt/us/scribe-app/logs/scribe-app.child.log 2>/dev/null || true`, undefined, 30_000)).stdout.toString("utf8");
    const boundary = child.lastIndexOf("scribe_singleton acquired");
    const latestSession = boundary >= 0 ? child.slice(child.lastIndexOf("\n", boundary) + 1) : child;
    const lifecycle = (await this.#ssh("for f in lifecycle-host.log launcher.log install.log; do echo \"===== $f =====\"; tail -n 80 \"/mnt/us/scribe-app/logs/$f\" 2>/dev/null || true; done", undefined, 30_000)).stdout.toString("utf8");
    return {
      summary: {
        penUps: matches(latestSession, /pen_up_phases/g),
        inputStalls: matches(latestSession, /input_stall/g),
        rejectedSwipes: matches(latestSession, /finger_swipe_rejected/g),
        faults: matches(latestSession, /\b(?:FAULT|panic|fatal)\b/gi),
        errors: matches(latestSession, /\berror\b/gi)
      },
      latestSession,
      lifecycle
    };
  }

  async #vaultFile(input: string): Promise<{ absolute: string; relative: string }> {
    if (typeof input !== "string" || !input.trim()) throw new WriterError(400, "sourcePath is required");
    const vault = await realpath(this.options.vaultPath);
    let absolute: string;
    try { absolute = await realpath(path.resolve(vault, input)); }
    catch { throw new WriterError(404, `No vault file at ${input}`); }
    if (!absolute.startsWith(vault + path.sep)) throw new WriterError(400, "Only files inside the vault can be pushed");
    const info = await stat(absolute);
    if (!info.isFile()) throw new WriterError(400, "sourcePath must name a file");
    return { absolute, relative: path.relative(vault, absolute).split(path.sep).join("/") };
  }

  #devicePath(input: string, label: string): string {
    if (typeof input !== "string" || !input.trim() || input.includes("\0")) throw new WriterError(400, `${label} is required`);
    const normalized = path.posix.normalize(input.trim());
    if (!normalized.startsWith("/")) throw new WriterError(400, `${label} must be an absolute Kindle path`);
    if (!this.roots.some((root) => normalized.startsWith(root + "/"))) {
      throw new WriterError(400, `${label} must be inside ${this.roots.join(" or ")}`);
    }
    return normalized;
  }

  async #remoteFile(file: string): Promise<{ bytes: number; sha256: string }> {
    const canonical = await this.#canonical(file);
    if (canonical !== file) throw new WriterError(400, `Symlinked device paths are not allowed: ${file}`);
    const result = await this.#ssh(`test -f ${shell(file)} && test ! -L ${shell(file)} && stat -c '%s' ${shell(file)} && sha256sum ${shell(file)} | cut -d' ' -f1`, undefined, 120_000, true);
    if (result.code !== 0) throw new WriterError(404, `No regular file at ${file}`);
    const [bytes, sha256] = result.stdout.toString("utf8").trim().split("\n");
    if (!/^\d+$/.test(bytes ?? "") || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new WriterError(404, `No regular file at ${file}`);
    return { bytes: Number(bytes), sha256: sha256! };
  }

  async #assertDestinationAvailable(destination: string): Promise<void> {
    const parent = path.posix.dirname(destination);
    await this.#ensureRemoteRoot(parent, true);
    const result = await this.#ssh(`if [ -e ${shell(destination)} ] || [ -L ${shell(destination)} ]; then exit 17; fi`, undefined, 15_000, true);
    if (result.code === 17) throw new WriterError(409, `Destination already exists: ${destination}`);
    if (result.code !== 0) throw new WriterError(502, result.stderr || "Could not validate the Kindle destination");
  }

  async #ensureDestinationParent(destination: string): Promise<void> {
    const parent = path.posix.dirname(destination);
    if (parent === this.#booksRoot) {
      await this.#ssh(`mkdir -p ${shell(this.#booksRoot)} && chmod 755 ${shell(this.#booksRoot)}`, undefined, 30_000);
    }
    await this.#ensureRemoteRoot(parent, false);
  }

  async #canonical(candidate: string): Promise<string> {
    const result = await this.#ssh(`readlink -f ${shell(candidate)}`, undefined, 15_000, true);
    const canonical = result.stdout.toString("utf8").trim();
    if (result.code !== 0 || !canonical) throw new WriterError(404, `Device path does not exist: ${candidate}`);
    return canonical;
  }

  async #ensureRemoteRoot(root: string, allowMissingBooksRoot: boolean): Promise<void> {
    if (allowMissingBooksRoot && root === this.#booksRoot) {
      const parent = path.posix.dirname(root);
      const probe = await this.#ssh(`if [ -e ${shell(root)} ] || [ -L ${shell(root)} ]; then readlink -f ${shell(root)}; elif [ "$(readlink -f ${shell(parent)})" = ${shell(parent)} ]; then printf '%s\\n' ${shell(root)}; else exit 18; fi`, undefined, 15_000, true);
      const canonical = probe.stdout.toString("utf8").trim();
      if (probe.code !== 0 || canonical !== root) throw new WriterError(400, `Unsafe Kindle books root: ${root}`);
      return;
    }
    const canonical = await this.#canonical(root);
    if (canonical !== root || !this.roots.some((allowed) => canonical === allowed || canonical.startsWith(allowed + "/"))) {
      throw new WriterError(400, `Device path escapes the allowed roots: ${root}`);
    }
  }

  async #ssh(command: string, input: Buffer | undefined, timeoutMs: number, allowFailure = false): Promise<SshResult> {
    let result: SshResult;
    try { result = await this.#run(command, input, timeoutMs); }
    catch (error) { throw new WriterError(503, `Kindle SSH unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (!allowFailure && result.code !== 0) throw new WriterError(502, `Kindle command failed (exit ${result.code}): ${result.stderr.trim().slice(0, 300) || "no output"}`);
    return result;
  }

  async #append(record: DeviceWriteRecord): Promise<void> {
    let records: DeviceWriteRecord[] = [];
    try { records = (JSON.parse(await readFile(this.#logPath, "utf8")) as { writes?: DeviceWriteRecord[] }).writes ?? []; } catch {}
    records.push(record);
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.#logPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ v: 1, writes: records.slice(-200) }, null, 1), { mode: 0o600 });
    await rename(temp, this.#logPath);
  }

  async #prune(): Promise<void> {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (new Date(plan.expiresAt).getTime() + 24 * 3600_000 < now) {
        this.#plans.delete(id);
        await rm(plan.dir, { recursive: true, force: true });
      }
    }
  }
}

function publicPlan(plan: StoredDevicePlan): DeviceFilePlan {
  const { payloadPath: _payload, dir: _dir, ...rest } = plan;
  return { ...rest };
}

function validateConfiguredRoot(root: string): string {
  const normalized = path.posix.normalize(root);
  if (!normalized.startsWith("/mnt/us/") || normalized === DOCUMENTS_ROOT || normalized.includes("\0")) throw new Error("COMPANION_KINDLE_BOOKS_ROOT must be an absolute, dedicated directory under /mnt/us");
  return normalized;
}

function sshRunner(options: KindleDeviceOptions): SshRunner {
  return (command, input, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/ssh", [
      "-i", options.keyPath, "-o", "IdentitiesOnly=yes", "-o", `UserKnownHostsFile=${options.knownHostsPath}`,
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-p", String(options.port), `root@${options.host}`, command
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

function shell(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function compactStamp(date: Date): string { return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function matches(input: string, expression: RegExp): number { return input.match(expression)?.length ?? 0; }

function grayPng(width: number, height: number, pixels: Buffer): Buffer {
  const scanlines = Buffer.allocUnsafe((width + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines[y * (width + 1)] = 0;
    pixels.copy(scanlines, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
