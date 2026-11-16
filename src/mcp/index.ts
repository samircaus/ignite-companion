#!/usr/bin/env node
// Ignite Companion MCP server (stdio) for Claude Code, Claude Desktop, Codex or any MCP client.
// Talks only to the loopback Ignite Companion API. The bearer token comes from
// COMPANION_API_TOKEN or the file named by COMPANION_API_TOKEN_FILE; it is never printed.
import { readFile } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLocalMcpServer, httpLocalApi } from "./tools.js";

async function token(): Promise<string> {
  const value = process.env.COMPANION_API_TOKEN
    ?? (process.env.COMPANION_API_TOKEN_FILE ? (await readFile(process.env.COMPANION_API_TOKEN_FILE, "utf8")).trim() : "");
  if (value.length < 32) throw new Error("Set COMPANION_API_TOKEN or COMPANION_API_TOKEN_FILE (32+ characters, the same token the service uses)");
  return value;
}

const base = process.env.COMPANION_API_URL ?? "http://127.0.0.1:7340";
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(base)) throw new Error("COMPANION_API_URL must be loopback");
const api = httpLocalApi(base, await token());
serveStdio(() => createLocalMcpServer(api));
