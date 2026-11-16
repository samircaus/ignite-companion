import { readFile } from "node:fs/promises";
import type { IgniteLibrarySummary, IgniteOperationsPage, IgniteSnapshotResponse } from "./types.js";

/**
 * Read-only client for an Ignite `scribe-sync-server` (plain HTTP, trusted LAN / loopback).
 * Only GET routes are used: the bridge never writes to the Kindle's ledger.
 * The bearer token is read from a file on each start and never logged or returned.
 */
export class IgniteClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly timeoutMs = 20_000) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(baseUrl)) {
      throw new Error("COMPANION_IGNITE_URL must be a plain-HTTP loopback or private-LAN origin");
    }
  }

  get url(): string { return this.baseUrl; }

  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<IgniteClient | undefined> {
    const tokenFile = env.COMPANION_IGNITE_TOKEN_FILE;
    if (!tokenFile) return undefined;
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length < 16) throw new Error("Ignite token file is empty or too short");
    return new IgniteClient((env.COMPANION_IGNITE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""), token);
  }

  async libraries(signal?: AbortSignal): Promise<IgniteLibrarySummary[]> {
    const body = await this.#json("/v1/libraries", signal) as { libraries?: IgniteLibrarySummary[] };
    return Array.isArray(body.libraries) ? body.libraries : [];
  }

  async snapshot(libraryId: string, signal?: AbortSignal): Promise<IgniteSnapshotResponse> {
    return await this.#json(`/v1/libraries/${encodeURIComponent(libraryId)}/snapshot`, signal) as IgniteSnapshotResponse;
  }

  /** Operations after `after` (server seq), oldest first: the cheap delta the Living Notebooks watcher tails. */
  async operations(libraryId: string, after: number, limit = 500, signal?: AbortSignal): Promise<IgniteOperationsPage> {
    return await this.#json(`/v1/libraries/${encodeURIComponent(libraryId)}/operations?after=${Math.max(0, Math.floor(after))}&limit=${limit}`, signal) as IgniteOperationsPage;
  }

  async blob(sha256: string, signal?: AbortSignal): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid blob hash");
    const response = await this.#fetch(`/v1/blobs/${sha256}`, signal);
    return Buffer.from(await response.arrayBuffer());
  }

  async #json(path: string, signal?: AbortSignal): Promise<unknown> {
    return await (await this.#fetch(path, signal)).json();
  }

  async #fetch(path: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) throw new Error(`Ignite server ${response.status} for ${path.split("/").slice(0, 3).join("/")}`);
    return response;
  }
}
