# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

VSCode Translate — a VS Code extension that translates Markdown files via OpenAI-compatible APIs. Generates `xxx_zh.md` alongside the original, with translation caching and incremental display.

## Build & Develop

```bash
npm install              # Install dependencies
npm run compile          # Production build (esbuild → dist/extension.js)
npm run watch            # Dev build with watch + sourcemaps
npm run lint             # TypeScript type check (tsc --noEmit)
```

To test: F5 in VS Code opens Extension Development Host. Open a .md file, run "Translate Markdown (Bilingual Preview)" from command palette.

## Architecture

- **`src/extension.ts`** — Entry point. Registers `vscodeTranslate.translate` command. Activates on `onLanguage:markdown`.
- **`src/fileTranslator.ts`** — Main workflow: parse → check cache → fire all translation batches concurrently → refresh editor every 300ms. Groups consecutive segments into ~4000 char batches. Cache and file saved incrementally so progress survives cancellation.
- **`src/markdownParser.ts`** — Splits markdown into `Segment[]` by blank lines. Code blocks are marked `type: "code"` and skipped. `reassembleMarkdown()` joins segments back with translations.
- **`src/translator.ts`** — API client with retry (2 retries, exponential backoff). `protect()` replaces image/link URLs with `__URL0__` placeholders before translation, `restore()` puts them back after. This ensures `![caption](path)` gets the caption translated but the path preserved.
- **`src/translationCache.ts`** — JSON file (`xxx.translate.json`) keyed by hash of original text. On re-run, only uncached/changed paragraphs are sent to the API.

## Key Design Decisions

- File-based output (`xxx_zh.md`) instead of webview — simpler, persists across sessions, works with git diff
- All batches fired concurrently to API, editor refreshes every 300ms for fast initial display
- Cache saved after each batch — re-run skips completed blocks, supports resume after cancel
- Editor updated in-place via `TextEditor.edit()` — no file-reload dialogs
- Single-pass regex `(!?)\[...\](...)` handles both images and links to avoid re-matching
- No external markdown-it dependency — segments are split by blank lines, keeping the parser lightweight

## Settings

All user-configurable via `vscodeTranslate.*`:
- `apiEndpoint` — OpenAI-compatible base URL
- `apiKey` — API key (required)
- `model` — model name
- `targetLanguage` — target language name (e.g. "Chinese", "Japanese")
