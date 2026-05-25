import * as vscode from "vscode";
import { splitMarkdown, reassembleMarkdown, Segment } from "./markdownParser";
import { translateText, TranslateOptions } from "./translator";
import { TranslationCache } from "./translationCache";

/** Max characters per batch sent to the API */
const BATCH_SIZE = 4000;

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
  pending: { index: number; content: string }[],
  maxChars: number
): { indices: number[]; content: string }[] {
  const batches: { indices: number[]; content: string }[] = [];
  let indices: number[] = [];
  let joined = "";
  let len = 0;

  const flush = () => {
    if (indices.length > 0) {
      batches.push({ indices, content: joined });
      indices = [];
      joined = "";
      len = 0;
    }
  };

  for (const seg of pending) {
    const framed = formatBatchSegment(seg.index, seg.content);
    if (len + framed.length > maxChars && indices.length > 0) {
      flush();
    }
    indices.push(seg.index);
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
  indices: number[],
  segments: Segment[],
  translations: Map<number, string>,
  cache: TranslationCache,
  options: TranslateOptions
) {
  await Promise.allSettled(
    indices.map((segIdx) =>
      translateText(segments[segIdx].content, options).then((translated) => {
        const result = preserveMarkdownFormat(
          segments[segIdx].content,
          translated
        );
        translations.set(segIdx, result);
        cache.set(segments[segIdx].content, result);
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
    customPrompt: getSetting(config, legacyConfig, "customPrompt", ""),
  };
  const openMode = getOpenModeSetting(config);
  const openTarget = getOpenTargetSetting(config);

  const content = document.getText();
  const segments = splitMarkdown(content);
  const cache = new TranslationCache(document.uri, storageUri);

  const pending: { index: number; content: string }[] = [];
  const translations = new Map<number, string>();

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type !== "text") continue;
    if (!segments[i].content.trim()) continue;

    const cached = cache.get(segments[i].content);
    if (cached) {
      translations.set(i, cached);
    } else {
      pending.push({ index: i, content: segments[i].content });
    }
  }

  const initialContent = reassembleMarkdown(segments, translations);

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

      // Fire ALL batches concurrently — each writes results to translations map
      const tasks = batches.map(async (batch) => {
        try {
          const translated = await translateText(batch.content, options);
          const parsed = parseTranslatedBatch(translated, batch.indices);
          if (parsed.size !== batch.indices.length) {
            throw new Error(
              vscode.l10n.t(
                "Translation output did not preserve segment markers."
              )
            );
          }

          for (const [segIdx, parsedResult] of parsed) {
            const result = preserveMarkdownFormat(
              segments[segIdx].content,
              parsedResult
            );
            translations.set(segIdx, result);
            cache.set(segments[segIdx].content, result);
          }
        } catch {
          await translateBatchIndividually(
            batch.indices,
            segments,
            translations,
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
        await updateDocument(translationDocument, segments, translations);
        cache.save();
        progress.report({
          message: vscode.l10n.t("{0} / {1}", completed, batches.length),
        });
      }, 300);

      // Wait for all batches to finish
      await Promise.all(tasks);
      clearInterval(refreshInterval);

      // Final update
      await updateDocument(translationDocument, segments, translations);
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
