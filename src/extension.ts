import * as vscode from "vscode";
import { translateFile } from "./fileTranslator";
import { clearTranslationCache } from "./translationCache";

export function activate(context: vscode.ExtensionContext) {
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
          ? `已清除 ${deleted} 个翻译缓存文件。`
          : "当前没有可清除的翻译缓存。"
      );
    }
  );

  const translateCmd = vscode.commands.registerCommand(
    "markdownAiTranslate.translate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("当前没有打开的编辑器。");
        return;
      }

      const doc = editor.document;
      if (doc.languageId !== "markdown" && !doc.fileName.endsWith(".md")) {
        vscode.window.showWarningMessage("请先打开一个 Markdown 文件。");
        return;
      }

      await translateFile(doc, context.globalStorageUri);
    }
  );

  context.subscriptions.push(openSettingsCmd, clearCacheCmd, translateCmd);
}

export function deactivate() {}
