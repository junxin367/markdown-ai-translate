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

async function openPreviewDocument(content: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: "markdown",
  });
  return vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: true,
  });
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
      "请先配置 Markdown AI Translate By junes 的 API Key。"
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
    targetLanguage: getSetting(config, legacyConfig, "targetLanguage", "中文"),
    customPrompt: getSetting(config, legacyConfig, "customPrompt", ""),
  };

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

  if (pending.length === 0) {
    await openPreviewDocument(initialContent);
    vscode.window.showInformationMessage(
      "所有翻译内容已从缓存加载。"
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "正在翻译 Markdown",
      cancellable: true,
    },
    async (progress, token) => {
      // Open a temporary preview document instead of writing into the project.
      const editor = await openPreviewDocument(initialContent);

      let completed = 0;

      // Fire ALL batches concurrently — each writes results to translations map
      const tasks = batches.map(async (batch) => {
        try {
          const translated = await translateText(batch.content, options);
          const parsed = parseTranslatedBatch(translated, batch.indices);
          if (parsed.size !== batch.indices.length) {
            throw new Error("翻译结果未保留段落标记。");
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
        await updateEditor(editor, segments, translations);
        cache.save();
        progress.report({ message: `${completed} / ${batches.length}` });
      }, 300);

      // Wait for all batches to finish
      await Promise.all(tasks);
      clearInterval(refreshInterval);

      // Final update
      await updateEditor(editor, segments, translations);
      cache.save();
      progress.report({ message: `${completed} / ${batches.length}` });
    }
  );
}

async function updateEditor(
  editor: vscode.TextEditor,
  segments: Segment[],
  translations: Map<number, string>
) {
  const newContent = reassembleMarkdown(segments, translations);
  const doc = editor.document;
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(doc.getText().length)
  );
  await editor.edit((builder) => builder.replace(fullRange, newContent));
}
