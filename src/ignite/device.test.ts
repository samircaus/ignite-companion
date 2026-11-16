import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KindleDevice, type SshRunner } from "./device.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(run: SshRunner) {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-kindle-device-"));
  temporary.push(root);
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "Reading"), { recursive: true });
  await writeFile(path.join(vault, "Reading", "paper.pdf"), Buffer.from("fake pdf bytes"));
  return new KindleDevice({
    host: "kindle.test", port: 2222, keyPath: "/key", knownHostsPath: "/known", vaultPath: vault,
    stateDir: path.join(root, "state"), run
  });
}

describe("KindleDevice", () => {
  it("snapshots a vault file, previews its fingerprint, and checksum-verifies an atomic push", async () => {
    const payload = Buffer.from("fake pdf bytes");
    const digest = createHash("sha256").update(payload).digest("hex");
    const calls: { command: string; input?: Buffer }[] = [];
    const run: SshRunner = async (command, input) => {
      calls.push({ command, ...(input ? { input } : {}) });
      if (command.startsWith("readlink -f '/mnt/us/documents'")) return ok("/mnt/us/documents\n");
      if (command.startsWith("sha256sum '/mnt/us/documents/paper.pdf.companion-")) return ok(`${digest}\n`);
      return ok();
    };
    const device = await fixture(run);
    const plan = await device.plan({ kind: "push", sourcePath: "Reading/paper.pdf" });
    expect(plan.destination).toBe("/mnt/us/documents/paper.pdf");
    expect(plan.sha256).toBe(digest);
    expect(plan.summary).toContain("No existing Kindle file will be replaced");

    const result = await device.apply(plan.planId);
    expect(result.path).toBe("/mnt/us/documents/paper.pdf");
    expect(calls.find((call) => call.command.startsWith("umask 022; cat >"))?.input).toEqual(payload);
    expect(calls.some((call) => call.command.includes("mv '/mnt/us/documents/paper.pdf.companion-"))).toBe(true);
  });

  it("rejects every destination outside the two allowlisted roots before SSH", async () => {
    let called = false;
    const device = await fixture(async () => { called = true; return ok(); });
    await expect(device.plan({ kind: "push", sourcePath: "Reading/paper.pdf", destination: "/mnt/us/paper.pdf" })).rejects.toThrow("must be inside");
    expect(called).toBe(false);
  });

  it("returns NUL-safe file names from the selected root", async () => {
    const device = await fixture(async (command) => command.startsWith("readlink")
      ? ok("/mnt/us/documents\n")
      : ok(Buffer.from("/mnt/us/documents/A File.pdf\0/mnt/us/documents/B.epub\0")));
    await expect(device.list("documents")).resolves.toEqual({
      root: "/mnt/us/documents",
      files: ["/mnt/us/documents/A File.pdf", "/mnt/us/documents/B.epub"]
    });
  });

  it("encodes the visible framebuffer as a grayscale PNG", async () => {
    const raw = Buffer.alloc(1872 * 2480, 255);
    const device = await fixture(async (command) => command.startsWith("dd if=/dev/fb0") ? ok(raw) : ok("identity\n"));
    const screenshot = await device.screenshot();
    expect(screenshot).toMatchObject({ mimeType: "image/png", width: 1860, height: 2480, inverted: false });
    expect(Buffer.from(screenshot.base64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});

function ok(stdout: string | Buffer = "") { return { code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: "" }; }
