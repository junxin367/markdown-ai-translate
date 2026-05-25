# Translate Button And Open Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible button text for the Markdown translate action and let users choose whether translated output opens side-by-side or as a new tab in the current editor group.

**Architecture:** Keep the change local to the extension manifest and the preview-opening helper. The manifest will define the new command text and the `openMode` setting, while `fileTranslator.ts` will branch at document-open time based on the configured mode without changing translation or cache flow.

**Tech Stack:** VS Code extension manifest (`package.json`), TypeScript, VS Code Extension API

---

## File Structure

- Modify: `package.json`
  - Update the translate command title to remove layout-specific wording and expose clearer button text.
  - Add the `markdownAiTranslate.openMode` configuration property.
- Modify: `src/fileTranslator.ts`
  - Read the new setting and choose either `ViewColumn.Two` or the default editor group when opening the translated document.
- Optional follow-up only if wording becomes stale: `README.md`
  - Not required for this implementation batch because the user asked to continue directly and README already has unrelated local edits.

### Task 1: Update manifest command text and configuration

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Change the translate command title to neutral wording**

Update the command definition from a layout-bound title to a neutral one:

```json
{
  "command": "markdownAiTranslate.translate",
  "title": "翻译 Markdown",
  "category": "Markdown AI Translate By junes",
  "icon": "resources/icon.svg"
}
```

- [ ] **Step 2: Add the open mode configuration property**

Add a new property under `contributes.configuration.properties`:

```json
"markdownAiTranslate.openMode": {
  "type": "string",
  "default": "sideBySide",
  "enum": ["sideBySide", "tab"],
  "enumDescriptions": [
    "翻译结果在右侧编辑器分栏打开。",
    "翻译结果在当前标签栏中新建标签页打开，不强制右侧分栏。"
  ],
  "order": 6,
  "markdownDescription": "控制翻译结果的打开方式。默认双栏；选择 tab 时会以新的未保存 Markdown 标签页打开。"
}
```

- [ ] **Step 3: Keep the editor title menu bound to the translate command**

Do not change the existing `editor/title` menu target. The command title update is what allows VS Code to surface clearer button text where the UI supports it.

- [ ] **Step 4: Save manifest changes and visually inspect JSON structure**

Check that:

- the JSON remains valid
- the new property is inside `configuration.properties`
- the command still uses the same `command` id

### Task 2: Add open mode branching to translated document opening

**Files:**
- Modify: `src/fileTranslator.ts`

- [ ] **Step 1: Read the new setting near other translation settings**

Add a typed setting read for the open mode:

```ts
const openMode = config.get<"sideBySide" | "tab">(
  "openMode",
  "sideBySide"
);
```

- [ ] **Step 2: Thread the open mode into the preview-opening helper**

Change the helper signature from:

```ts
async function openPreviewDocument(content: string): Promise<vscode.TextEditor>
```

to:

```ts
async function openPreviewDocument(
  content: string,
  openMode: "sideBySide" | "tab"
): Promise<vscode.TextEditor>
```

- [ ] **Step 3: Branch the `showTextDocument` options by mode**

Implement the mode decision directly inside the helper:

```ts
const showOptions: vscode.TextDocumentShowOptions =
  openMode === "sideBySide"
    ? {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      }
    : {
        preview: false,
        preserveFocus: true,
      };

return vscode.window.showTextDocument(doc, showOptions);
```

This preserves the current right-side behavior for the default mode and opens a new tab in the current editor group for `tab`.

- [ ] **Step 4: Update all helper call sites**

Replace:

```ts
await openPreviewDocument(initialContent);
```

and:

```ts
const editor = await openPreviewDocument(initialContent);
```

with:

```ts
await openPreviewDocument(initialContent, openMode);
```

and:

```ts
const editor = await openPreviewDocument(initialContent, openMode);
```

- [ ] **Step 5: Confirm translated preview tracking still works**

Keep this line unchanged:

```ts
translationPreviewUris.add(doc.uri.toString());
```

The translated-document identification must remain based on the created untitled document, not the view column.

### Task 3: Verify behavior and packageability

**Files:**
- Verify: `package.json`
- Verify: `src/fileTranslator.ts`

- [ ] **Step 1: Run the type check**

Run: `npm run lint`

Expected: command exits with code `0`

- [ ] **Step 2: Run the extension build**

Run: `npm run compile`

Expected: `dist/extension.js` is rebuilt successfully

- [ ] **Step 3: Run VSIX packaging**

Run: `npm run package`

Expected: a `.vsix` file is created under `release/`

- [ ] **Step 4: Manually verify the two open modes in VS Code**

Check:

- default `sideBySide` still opens the translated document in the right-hand editor group
- `markdownAiTranslate.openMode = "tab"` opens the translated document as a new tab in the current group
- the translated document still shows the “以预览方式打开翻译结果” button

- [ ] **Step 5: Prepare commit once verification passes**

Suggested commit message:

```bash
git add package.json src/fileTranslator.ts
git commit -m "feat: add translate open mode setting"
```
