import * as vscode from "vscode";
import { splitMarkdown, reassembleMarkdown, Segment } from "./markdownParser";
import {
  translateText,
  TranslateOptions,
  TranslatePromptKind,
} from "./translator";
import { TranslationCache } from "./translationCache";

/** Max characters per batch sent to the API */
const BATCH_SIZE = 4000;

type TranslationTaskKind = "markdown" | "codeComment";

interface TranslationTask {
  id: number;
  kind: TranslationTaskKind;
  segmentIndex: number;
  content: string;
}

interface CodeCommentPatch {
  lineIndex: number;
  start: number;
  end: number;
  original: string;
  taskId?: number;
}

interface CommentSyntax {
  lineMarkers: string[];
  blockMarkers: { start: string; end: string }[];
}

function segmentStart(index: number): string {
  return `__SEGMENT_${index}_START__`;
}

function segmentEnd(index: number): string {
  return `__SEGMENT_${index}_END__`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Group consecutive pending segments into batches */
function groupIntoBatches(
  pending: TranslationTask[],
  maxChars: number
): { ids: number[]; content: string; kind: TranslatePromptKind }[] {
  const batches: {
    ids: number[];
    content: string;
    kind: TranslatePromptKind;
  }[] = [];
  let ids: number[] = [];
  let joined = "";
  let len = 0;
  let kind: TranslatePromptKind | undefined;

  const flush = () => {
    if (ids.length > 0 && kind) {
      batches.push({ ids, content: joined, kind });
      ids = [];
      joined = "";
      len = 0;
      kind = undefined;
    }
  };

  for (const seg of pending) {
    const framed = formatBatchSegment(seg.id, seg.content);
    if (
      ids.length > 0 &&
      (kind !== seg.kind || len + framed.length > maxChars)
    ) {
      flush();
    }
    kind = seg.kind;
    ids.push(seg.id);
    joined += (joined ? "\n\n" : "") + framed;
    len += framed.length;
  }
  flush();
  return batches;
}

function formatBatchSegment(index: number, content: string): string {
  return `${segmentStart(index)}\n${content}\n${segmentEnd(index)}`;
}

function parseTranslatedBatch(
  translated: string,
  indices: number[]
): Map<number, string> {
  const results = new Map<number, string>();

  for (const index of indices) {
    const start = escapeRegExp(segmentStart(index));
    const end = escapeRegExp(segmentEnd(index));
    const match = translated.match(
      new RegExp(
        `(?:^|\\r?\\n)${start}\\r?\\n([\\s\\S]*?)\\r?\\n${end}(?=\\r?\\n|$)`
      )
    );
    if (match) {
      results.set(index, match[1]);
    }
  }

  return results;
}

function tablePipeCount(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return tablePipeCount(line) >= 2;
}

function markdownLinePrefix(line: string): string | undefined {
  const heading = line.match(/^(\s{0,3}#{1,6}\s+)/);
  if (heading) return heading[1];

  const quoteWithList = line.match(
    /^(\s*(?:>\s*)+(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?)/
  );
  if (quoteWithList) return quoteWithList[1];

  const list = line.match(
    /^(\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/
  );
  if (list) return list[1];

  return undefined;
}

function stripMarkdownLinePrefix(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:>\s*)+(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
}

function hasMarkdownStructure(content: string): boolean {
  return content
    .split("\n")
    .some((line) => Boolean(markdownLinePrefix(line)) || isTableRow(line));
}

function preserveMarkdownLine(original: string, translated: string): string {
  if (isTableDivider(original)) return original;

  if (isTableRow(original)) {
    return tablePipeCount(translated) === tablePipeCount(original)
      ? translated
      : original;
  }

  const prefix = markdownLinePrefix(original);
  if (!prefix) return translated;

  return `${prefix}${stripMarkdownLinePrefix(translated).trimStart()}`;
}

function preserveMarkdownFormat(original: string, translated: string): string {
  const originalLines = original.split("\n");
  const translatedLines = translated.split(/\r?\n/);

  if (originalLines.length !== translatedLines.length) {
    return hasMarkdownStructure(original) ? original : translated;
  }

  return originalLines
    .map((line, index) => preserveMarkdownLine(line, translatedLines[index]))
    .join("\n");
}

function normalizeFenceLanguage(info: string): string {
  const firstToken = info.trim().split(/\s+/)[0] ?? "";
  return firstToken
    .replace(/^\{?\.?/, "")
    .replace(/[},].*$/, "")
    .toLowerCase();
}

function codeFenceLanguage(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(/^\s*(`{3,}|~{3,})(.*)$/);
  return match ? normalizeFenceLanguage(match[2]) : "";
}

function addUnique<T>(items: T[], item: T) {
  if (!items.includes(item)) {
    items.push(item);
  }
}

function getCommentSyntax(language: string): CommentSyntax {
  const syntax: CommentSyntax = { lineMarkers: [], blockMarkers: [] };
  const slashLanguages = new Set([
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hpp",
    "cs",
    "csharp",
    "dart",
    "go",
    "java",
    "js",
    "jsx",
    "jsonc",
    "kt",
    "kotlin",
    "php",
    "rs",
    "rust",
    "scala",
    "swift",
    "ts",
    "tsx",
  ]);
  const hashLanguages = new Set([
    "bash",
    "conf",
    "config",
    "dockerfile",
    "ini",
    "makefile",
    "perl",
    "pl",
    "powershell",
    "ps1",
    "py",
    "python",
    "r",
    "rb",
    "ruby",
    "sh",
    "shell",
    "toml",
    "yaml",
    "yml",
    "zsh",
  ]);
  const dashLanguages = new Set(["ada", "hs", "haskell", "lua", "sql"]);
  const htmlLanguages = new Set([
    "html",
    "markdown",
    "md",
    "svelte",
    "svg",
    "vue",
    "xml",
  ]);
  const percentLanguages = new Set(["erlang", "latex", "matlab", "octave", "tex"]);

  if (!language) {
    addUnique(syntax.lineMarkers, "//");
    addUnique(syntax.lineMarkers, "#");
    addUnique(syntax.lineMarkers, "--");
    syntax.blockMarkers.push({ start: "/*", end: "*/" });
    syntax.blockMarkers.push({ start: "<!--", end: "-->" });
    return syntax;
  }

  if (slashLanguages.has(language)) {
    addUnique(syntax.lineMarkers, "//");
    syntax.blockMarkers.push({ start: "/*", end: "*/" });
  }

  if (language === "css" || language === "scss" || language === "less") {
    syntax.blockMarkers.push({ start: "/*", end: "*/" });
  }

  if (hashLanguages.has(language)) {
    addUnique(syntax.lineMarkers, "#");
  }

  if (dashLanguages.has(language)) {
    addUnique(syntax.lineMarkers, "--");
  }

  if (htmlLanguages.has(language)) {
    syntax.blockMarkers.push({ start: "<!--", end: "-->" });
  }

  if (percentLanguages.has(language)) {
    addUnique(syntax.lineMarkers, "%");
  }

  return syntax;
}

function isValidMarker(line: string, index: number, marker: string): boolean {
  if (marker === "#") {
    return line.slice(index, index + 2) !== "#!";
  }

  return true;
}

function findMarkerOutsideStrings(
  line: string,
  markers: string[]
): { index: number; marker: string } | undefined {
  const sortedMarkers = [...markers].sort((a, b) => b.length - a.length);
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    for (const marker of sortedMarkers) {
      if (line.startsWith(marker, i) && isValidMarker(line, i, marker)) {
        return { index: i, marker };
      }
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    }
  }

  return undefined;
}

function findBlockMarkerOutsideStrings(
  line: string,
  markers: { start: string; end: string }[]
): { index: number; marker: { start: string; end: string } } | undefined {
  const found = findMarkerOutsideStrings(
    line,
    markers.map((marker) => marker.start)
  );
  if (!found) return undefined;

  const marker = markers.find((item) => item.start === found.marker);
  return marker ? { index: found.index, marker } : undefined;
}

function trimmedCommentRange(
  line: string,
  start: number,
  end: number,
  stripLeadingStar: boolean
): { start: number; end: number } | undefined {
  let textStart = start;
  let textEnd = end;

  while (textStart < textEnd && /\s/.test(line[textStart])) {
    textStart++;
  }

  if (stripLeadingStar && line[textStart] === "*") {
    textStart++;
    if (line[textStart] === " ") {
      textStart++;
    }
  }

  while (textEnd > textStart && /\s/.test(line[textEnd - 1])) {
    textEnd--;
  }

  return textEnd > textStart ? { start: textStart, end: textEnd } : undefined;
}

function addCommentPatch(
  patches: CodeCommentPatch[],
  lineIndex: number,
  line: string,
  start: number,
  end: number,
  stripLeadingStar: boolean
) {
  const range = trimmedCommentRange(line, start, end, stripLeadingStar);
  if (!range) return;

  patches.push({
    lineIndex,
    start: range.start,
    end: range.end,
    original: line.slice(range.start, range.end),
  });
}

function extractCodeCommentPatches(content: string): CodeCommentPatch[] {
  const language = codeFenceLanguage(content);
  const syntax = getCommentSyntax(language);
  if (syntax.lineMarkers.length === 0 && syntax.blockMarkers.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  if (lines.length < 3) return [];

  const patches: CodeCommentPatch[] = [];
  let activeBlockEnd: string | undefined;

  for (let lineIndex = 1; lineIndex < lines.length - 1; lineIndex++) {
    const line = lines[lineIndex];

    if (activeBlockEnd) {
      const endIndex = line.indexOf(activeBlockEnd);
      addCommentPatch(
        patches,
        lineIndex,
        line,
        0,
        endIndex >= 0 ? endIndex : line.length,
        true
      );
      if (endIndex >= 0) {
        activeBlockEnd = undefined;
      }
      continue;
    }

    const lineComment = findMarkerOutsideStrings(line, syntax.lineMarkers);
    const blockComment = findBlockMarkerOutsideStrings(
      line,
      syntax.blockMarkers
    );

    if (lineComment && (!blockComment || lineComment.index < blockComment.index)) {
      addCommentPatch(
        patches,
        lineIndex,
        line,
        lineComment.index + lineComment.marker.length,
        line.length,
        false
      );
      continue;
    }

    if (!blockComment) continue;

    const contentStart = blockComment.index + blockComment.marker.start.length;
    const contentEnd = line.indexOf(blockComment.marker.end, contentStart);
    addCommentPatch(
      patches,
      lineIndex,
      line,
      contentStart,
      contentEnd >= 0 ? contentEnd : line.length,
      true
    );

    if (contentEnd < 0) {
      activeBlockEnd = blockComment.marker.end;
    }
  }

  return patches;
}

function normalizeCodeCommentTranslation(translated: string): string {
  return translated.replace(/\s*\r?\n\s*/g, " ").trim();
}

function applyCodeCommentTranslations(
  content: string,
  patches: CodeCommentPatch[],
  translatedTasks: Map<number, string>
): string {
  const lines = content.split("\n");

  for (const patch of patches) {
    if (patch.taskId === undefined) continue;

    const translated = translatedTasks.get(patch.taskId);
    if (!translated) continue;

    const line = lines[patch.lineIndex];
    lines[patch.lineIndex] =
      line.slice(0, patch.start) + translated + line.slice(patch.end);
  }

  return lines.join("\n");
}

function hasConfiguredValue<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): boolean {
  const inspected = config.inspect<T>(key);
  return Boolean(
    inspected?.globalValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.workspaceFolderValue !== undefined
  );
}

function getSetting<T>(
  config: vscode.WorkspaceConfiguration,
  legacyConfig: vscode.WorkspaceConfiguration,
  key: string,
  fallback: T
): T {
  if (hasConfiguredValue<T>(config, key)) {
    return config.get<T>(key) ?? fallback;
  }

  if (hasConfiguredValue<T>(legacyConfig, key)) {
    return legacyConfig.get<T>(key) ?? fallback;
  }

  return config.get<T>(key) ?? fallback;
}

function getConfiguredSetting<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  return hasConfiguredValue<T>(config, key) ? config.get<T>(key) : undefined;
}

function getCustomPromptSetting(
  config: vscode.WorkspaceConfiguration,
  legacyConfig: vscode.WorkspaceConfiguration
): string | undefined {
  const currentPrompt = getConfiguredSetting<string>(config, "customPrompt");
  if (currentPrompt !== undefined) return currentPrompt;

  return getConfiguredSetting<string>(legacyConfig, "customPrompt");
}

function getCodeCommentPromptSetting(
  config: vscode.WorkspaceConfiguration,
  legacyConfig: vscode.WorkspaceConfiguration
): string | undefined {
  const currentPrompt = getConfiguredSetting<string>(
    config,
    "codeCommentPrompt"
  );
  if (currentPrompt !== undefined) return currentPrompt;

  return getConfiguredSetting<string>(legacyConfig, "codeCommentPrompt");
}

function cacheContentKey(
  content: string,
  options: TranslateOptions,
  kind: TranslatePromptKind
): string {
  if (kind === "codeComment") {
    const codeCommentPrompt = options.codeCommentPrompt?.trim();
    return JSON.stringify({
      kind,
      targetLanguage: options.targetLanguage,
      codeCommentPrompt: codeCommentPrompt || "__builtin_code_comment_v1__",
      content,
    });
  }

  return JSON.stringify({
    targetLanguage: options.targetLanguage,
    customPrompt: options.customPrompt?.trim() ?? "",
    content,
  });
}

function getOpenModeSetting(
  config: vscode.WorkspaceConfiguration
): "sideBySide" | "tab" {
  const current = config.get<"sideBySide" | "tab">("openMode");
  if (current === "sideBySide" || current === "tab") {
    return current;
  }

  return "sideBySide";
}

function getOpenTargetSetting(
  config: vscode.WorkspaceConfiguration
): "file" | "preview" {
  const current = config.get<"file" | "preview">("openTarget");
  if (current === "file" || current === "preview") {
    return current;
  }

  return "file";
}

async function translateBatchIndividually(
  ids: number[],
  tasks: Map<number, TranslationTask>,
  translatedTasks: Map<number, string>,
  cache: TranslationCache,
  options: TranslateOptions
) {
  await Promise.allSettled(
    ids.map((id) =>
      translateText(
        tasks.get(id)!.content,
        options,
        tasks.get(id)!.kind
      ).then((translated) => {
        const task = tasks.get(id)!;
        const result =
          task.kind === "markdown"
            ? preserveMarkdownFormat(task.content, translated)
            : normalizeCodeCommentTranslation(translated);
        translatedTasks.set(id, result);
        cache.set(cacheContentKey(task.content, options, task.kind), result);
      })
    )
  );
}

function getFileOpenOptions(
  openMode: "sideBySide" | "tab"
): vscode.TextDocumentShowOptions {
  return openMode === "sideBySide"
    ? {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      }
    : {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
        preserveFocus: false,
      };
}

function getPreviewOpenOptions(
  openMode: "sideBySide" | "tab"
): vscode.TextDocumentShowOptions {
  return openMode === "sideBySide"
    ? {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: false,
      }
    : {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
        preserveFocus: false,
      };
}

async function openTranslationDocument(
  content: string
): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: "markdown",
  });
  translationPreviewUris.add(doc.uri.toString());
  return doc;
}

async function openTranslationResult(
  document: vscode.TextDocument,
  openMode: "sideBySide" | "tab",
  openTarget: "file" | "preview"
) {
  if (openTarget === "file") {
    await vscode.window.showTextDocument(document, getFileOpenOptions(openMode));
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    document.uri,
    "vscode.markdown.preview.editor",
    getPreviewOpenOptions(openMode)
  );
}

export function isTranslationPreviewDocument(document: vscode.TextDocument) {
  return translationPreviewUris.has(document.uri.toString());
}

const translationPreviewUris = new Set<string>();

function buildSegmentTranslations(
  segments: Segment[],
  tasks: Map<number, TranslationTask>,
  translatedTasks: Map<number, string>,
  codeCommentPatches: Map<number, CodeCommentPatch[]>
): Map<number, string> {
  const segmentTranslations = new Map<number, string>();

  for (const task of tasks.values()) {
    const translated = translatedTasks.get(task.id);
    if (!translated || task.kind !== "markdown") continue;

    segmentTranslations.set(task.segmentIndex, translated);
  }

  for (const [segmentIndex, patches] of codeCommentPatches) {
    const translated = applyCodeCommentTranslations(
      segments[segmentIndex].content,
      patches,
      translatedTasks
    );
    if (translated !== segments[segmentIndex].content) {
      segmentTranslations.set(segmentIndex, translated);
    }
  }

  return segmentTranslations;
}

export async function translateFile(
  document: vscode.TextDocument,
  storageUri: vscode.Uri
) {
  const config = vscode.workspace.getConfiguration("markdownAiTranslate");
  const legacyConfig = vscode.workspace.getConfiguration("vscodeTranslate");
  const apiKey = getSetting(config, legacyConfig, "apiKey", "");
  if (!apiKey) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Configure the Markdown AI Translate API key first.")
    );
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "markdownAiTranslate.apiKey"
    );
    return;
  }

  const options: TranslateOptions = {
    apiEndpoint: getSetting(
      config,
      legacyConfig,
      "apiEndpoint",
      "https://api.openai.com/v1"
    ),
    apiKey,
    model: getSetting(config, legacyConfig, "model", "gpt-4o-mini"),
    targetLanguage: getSetting(
      config,
      legacyConfig,
      "targetLanguage",
      vscode.l10n.t("Chinese")
    ),
    customPrompt: getCustomPromptSetting(config, legacyConfig),
    codeCommentPrompt: getCodeCommentPromptSetting(config, legacyConfig),
  };
  const openMode = getOpenModeSetting(config);
  const openTarget = getOpenTargetSetting(config);
  const translateCodeComments = getSetting(
    config,
    legacyConfig,
    "translateCodeComments",
    false
  );

  const content = document.getText();
  const segments = splitMarkdown(content);
  const cache = new TranslationCache(document.uri, storageUri);

  const pending: TranslationTask[] = [];
  const translationTasks = new Map<number, TranslationTask>();
  const translatedTasks = new Map<number, string>();
  const codeCommentPatches = new Map<number, CodeCommentPatch[]>();
  let nextTaskId = 0;

  const addTask = (
    kind: TranslationTaskKind,
    segmentIndex: number,
    taskContent: string
  ): TranslationTask => {
    const task = {
      id: nextTaskId++,
      kind,
      segmentIndex,
      content: taskContent,
    };
    translationTasks.set(task.id, task);
    return task;
  };

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type === "text") {
      if (!segment.content.trim()) continue;

      const task = addTask("markdown", i, segment.content);
      const cached = cache.get(
        cacheContentKey(task.content, options, task.kind)
      );
      if (cached) {
        translatedTasks.set(task.id, cached);
      } else {
        pending.push(task);
      }
      continue;
    }

    if (!translateCodeComments) continue;

    const patches = extractCodeCommentPatches(segment.content);
    if (patches.length === 0) continue;

    codeCommentPatches.set(i, patches);
    for (const patch of patches) {
      const task = addTask("codeComment", i, patch.original);
      patch.taskId = task.id;

      const cached = cache.get(
        cacheContentKey(task.content, options, task.kind)
      );
      if (cached) {
        translatedTasks.set(task.id, cached);
      } else {
        pending.push(task);
      }
    }
  }

  const initialContent = reassembleMarkdown(
    segments,
    buildSegmentTranslations(
      segments,
      translationTasks,
      translatedTasks,
      codeCommentPatches
    )
  );

  const batches = groupIntoBatches(pending, BATCH_SIZE);

  const translationDocument = await openTranslationDocument(initialContent);
  await openTranslationResult(translationDocument, openMode, openTarget);

  if (pending.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("All content was loaded from the translation cache.")
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Translating Markdown"),
      cancellable: true,
    },
    async (progress, token) => {
      let completed = 0;

      // Fire ALL batches concurrently; each writes completed task results.
      const batchPromises = batches.map(async (batch) => {
        try {
          const translated = await translateText(
            batch.content,
            options,
            batch.kind
          );
          const parsed = parseTranslatedBatch(translated, batch.ids);
          if (parsed.size !== batch.ids.length) {
            throw new Error(
              vscode.l10n.t(
                "Translation output did not preserve segment markers."
              )
            );
          }

          for (const [taskId, parsedResult] of parsed) {
            const task = translationTasks.get(taskId);
            if (!task) continue;

            const result =
              task.kind === "markdown"
                ? preserveMarkdownFormat(task.content, parsedResult)
                : normalizeCodeCommentTranslation(parsedResult);
            translatedTasks.set(taskId, result);
            cache.set(
              cacheContentKey(task.content, options, task.kind),
              result
            );
          }
        } catch {
          await translateBatchIndividually(
            batch.ids,
            translationTasks,
            translatedTasks,
            cache,
            options
          );
        } finally {
          completed++;
        }
      });

      // Refresh editor every 300ms with whatever's been translated so far
      const refreshInterval = setInterval(async () => {
        if (token.isCancellationRequested) return;
        await updateDocument(
          translationDocument,
          segments,
          buildSegmentTranslations(
            segments,
            translationTasks,
            translatedTasks,
            codeCommentPatches
          )
        );
        cache.save();
        progress.report({
          message: vscode.l10n.t("{0} / {1}", completed, batches.length),
        });
      }, 300);

      // Wait for all batches to finish
      await Promise.all(batchPromises);
      clearInterval(refreshInterval);

      // Final update
      await updateDocument(
        translationDocument,
        segments,
        buildSegmentTranslations(
          segments,
          translationTasks,
          translatedTasks,
          codeCommentPatches
        )
      );
      cache.save();
      progress.report({
        message: vscode.l10n.t("{0} / {1}", completed, batches.length),
      });
    }
  );
}

async function updateDocument(
  document: vscode.TextDocument,
  segments: Segment[],
  translations: Map<number, string>
) {
  const newContent = reassembleMarkdown(segments, translations);
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
}
