import * as vscode from "vscode";
import {
  isTranslationPreviewDocument,
  translateFile,
} from "./fileTranslator";
import { clearTranslationCache } from "./translationCache";

function isTranslatableMarkdownDocument(document: vscode.TextDocument): boolean {
  return (
    document.languageId === "markdown" ||
    document.languageId === "skill" ||
    document.fileName.toLowerCase().endsWith(".md")
  );
}

export function activate(context: vscode.ExtensionContext) {
  const updateTranslationPreviewContext = async (
    editor: vscode.TextEditor | undefined
  ) => {
    await vscode.commands.executeCommand(
      "setContext",
      "markdownAiTranslate.isTranslationPreviewDocument",
      Boolean(editor && isTranslationPreviewDocument(editor.document))
    );
  };

  const openSettingsCmd = vscode.commands.registerCommand(
    "markdownAiTranslate.openSettings",
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "markdownAiTranslate"
      );
    }
  );

  const clearCacheCmd = vscode.commands.registerCommand(
    "markdownAiTranslate.clearCache",
    async () => {
      const deleted = clearTranslationCache(context.globalStorageUri);
      vscode.window.showInformationMessage(
        deleted > 0
          ? vscode.l10n.t(
              "Cleared {0} translation cache file(s).",
              deleted
            )
          : vscode.l10n.t("No translation cache files were found.")
      );
    }
  );

  const openPreviewCmd = vscode.commands.registerCommand(
    "markdownAiTranslate.openPreview",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isTranslationPreviewDocument(editor.document)) {
        return;
      }

      await vscode.commands.executeCommand("markdown.showPreview");
    }
  );

  const translateCmd = vscode.commands.registerCommand(
    "markdownAiTranslate.translate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("No editor is currently open.")
        );
        return;
      }

      const doc = editor.document;
      if (!isTranslatableMarkdownDocument(doc)) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Open a Markdown or Skill file first.")
        );
        return;
      }

      await translateFile(doc, context.globalStorageUri);
      await updateTranslationPreviewContext(vscode.window.activeTextEditor);
    }
  );

  context.subscriptions.push(
    openSettingsCmd,
    clearCacheCmd,
    openPreviewCmd,
    translateCmd,
    vscode.window.onDidChangeActiveTextEditor(updateTranslationPreviewContext)
  );

  void updateTranslationPreviewContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
