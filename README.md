# Ignite Companion

A Mac companion for [Ignite](https://github.com/markrai/ignite) on the Kindle Scribe. It runs next
to Ignite's sync server and:

- **Mirrors your notebooks into Markdown.** Each notebook becomes a note in your vault, with the
  page images and the handwriting read by Apple Vision on your Mac. Obsidian works, but any folder
  of Markdown does.
- **Sends things back to the Kindle.** A Markdown note becomes a new notebook laid out in Ignite's
  font, with real ink checkboxes. You can also build notebooks from a page spec, move them between
  folders, and push PDFs or EPUBs over Wi-Fi.
- **Lets an AI answer in your notebooks (Living Notebooks).** Draw a small circled `?` or `+` on a
  page, and the answer is written next to it in handwriting ink, which you can erase on the Kindle.
  Three small dots appear beside your mark within seconds, so you know it was seen; they make way
  for the answer, or for the word "failed" if the AI could not answer.
  Each notebook has its memory and instructions in plain Markdown under `Living Notebooks/`.
- **Exposes all of it as an MCP server**, so Claude, Codex or any MCP client can read your pages
  and propose edits.

Every write is a dry run first: you get a summary and preview images, and nothing reaches the
Kindle until you approve the plan. Notebook writes take a ledger backup first, and AI turns can be
undone.

## How it works

```text
Kindle Scribe (Ignite) ◄─sync─► Ignite sync server (Mac) ◄─HTTP─► Ignite Companion (Mac, loopback)
                                                                     │  ├─ Markdown mirror (your vault)
                                                                     │  ├─ ignite-render (Swift, Apple Vision)
                                                                     │  └─ codex exec / claude -p
                                                    MCP client ◄─stdio─┘
```

The companion runs on your Mac. There is no hosted service and no API keys: the AI uses the Codex
or Claude Code CLI that you are already signed in to, on your own plan.

## Privacy: what leaves your Mac

- **Sync, mirroring and handwriting recognition stay local.** The companion talks only to the
  Ignite sync server (loopback or private LAN, enforced) and reads handwriting with Apple Vision.
- **Kindle access over SSH** goes only to the host you configure, with a pinned host key.
- **AI turns go to your AI provider.** When you circle a mark in a notebook that has Living
  Notebooks turned on, the companion runs `codex exec` or `claude -p`, which sends OpenAI or
  Anthropic the page image, a close-up of the mark, the recognised text near it, the notebook
  title, and that notebook's instructions and memory from `Living Notebooks/`. Nothing is sent
  for notebooks you have not turned on, and `COMPANION_LIVING=off` turns the feature off.
  Codex runs in a read-only sandbox, and Claude may only read the page images.
- No telemetry, analytics or update checks.

## Requirements

- macOS (the page renderer uses Apple Vision) and Node.js 22.12 or newer.
- A Kindle Scribe running Ignite, and the Ignite sync server running on the Mac.
- For writing: Ignite's `ignite-import`. For Living Notebooks: an `ignite-import` with the
  `annotate` and `measure` commands.
- For Living Notebooks: the `codex` or `claude` CLI, signed in.

## Setup

```bash
npm install
npm run build
npm run build:native          # builds ignite-render with swiftc
cp .env.example ~/.ignite-companion.env   # then fill it in
node --env-file="$HOME/.ignite-companion.env" dist/server.js
```

Add the MCP server to your client, with the same API token:

```json
{
  "mcpServers": {
    "ignite-companion": {
      "command": "node",
      "args": ["/path/to/ignite-companion/dist/mcp/index.js"],
      "env": { "COMPANION_API_TOKEN_FILE": "/path/to/api-token" }
    }
  }
}
```

## Safety

- The API listens on loopback only and needs a bearer token.
- Writes go plan → preview → apply. Plans expire after 30 minutes and apply once.
- Kindle file access is limited to `/mnt/us/documents` and `/mnt/us/scribe-app/books`. Existing
  files are never replaced, and deletes go to a recoverable quarantine.
- The AI only adds ink. It never changes or removes yours, and every AI turn can be undone.

## Disclaimer

Not affiliated with or endorsed by Amazon. Kindle and Kindle Scribe are trademarks of Amazon.com,
Inc. or its affiliates. Jailbreaking your device may void its warranty; you do so at your own risk.

## License

AGPL-3.0-only, the same as Ignite. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
