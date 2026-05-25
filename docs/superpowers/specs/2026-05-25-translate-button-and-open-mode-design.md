# 翻译按钮文案与打开方式设置设计

## 目标

为 Markdown 翻译入口补充更明确的按钮文案，并允许用户配置翻译结果的打开方式，在保留现有双栏默认体验的前提下支持单栏标签页打开。

## 需求范围

本次仅包含两个改动：

1. 编辑器标题栏中的翻译入口从纯图标按钮改为带文字的按钮，文案为“翻译”。
2. 新增设置项，用于控制翻译结果打开方式，支持“双栏”和“单栏新标签页”两种模式，默认保持双栏。

本次不包含：

- 替换当前编辑器内容
- 自动打开 Markdown 预览
- 修改翻译结果文档的数据结构或缓存策略

## 用户体验

### 1. 翻译按钮

- 原 Markdown 文件顶部保留现有图标能力。
- 按钮显示文字“翻译”，降低首次使用时的识别成本。
- 命令面板名称保持现有“翻译 Markdown（双栏预览）”或同步调整为更中性的文案，避免和新配置冲突。

推荐同步调整命令标题为不绑定布局的描述，例如“翻译 Markdown”，避免用户在设置为单栏模式时仍看到“双栏预览”字样。

### 2. 打开方式设置

新增配置项：

- 键名：`markdownAiTranslate.openMode`
- 类型：`string`
- 默认值：`sideBySide`
- 枚举值：
  - `sideBySide`：右侧分栏打开翻译结果
  - `tab`：在当前标签栏中新建标签页打开翻译结果，不强制右侧分栏

设置项文案应明确说明：

- `sideBySide` 是默认行为
- `tab` 不是覆盖当前文件，而是以新的未保存 Markdown 标签页方式打开

## 技术设计

### 1. package.json 调整

修改 [package.json](/E:/code/junes/github/Markdown-AI-Translate/package.json)：

- 更新 `markdownAiTranslate.translate` 的标题文案
- 如 VS Code 菜单能力允许，保留图标同时显示文字
- 在 `contributes.configuration.properties` 中新增 `markdownAiTranslate.openMode`

配置建议结构：

- `type: "string"`
- `enum: ["sideBySide", "tab"]`
- `enumDescriptions` 说明两种行为

### 2. 打开逻辑调整

修改 [src/fileTranslator.ts](/E:/code/junes/github/Markdown-AI-Translate/src/fileTranslator.ts) 中的 `openPreviewDocument`：

- 读取 `markdownAiTranslate.openMode`
- 当值为 `sideBySide` 时，继续使用 `viewColumn: vscode.ViewColumn.Two`
- 当值为 `tab` 时，不再指定右侧列，改为普通新标签页打开

建议把打开行为抽成一个小的决策分支，避免后续继续向 `openPreviewDocument` 塞条件。

### 3. 兼容性

- 默认值为 `sideBySide`，所以现有用户升级后行为不变
- `tab` 模式仍然使用临时 Markdown 文档，已有“翻译结果页识别”和“打开预览按钮”逻辑不需要重构

## 风险与处理

### 风险 1：按钮文案在编辑器标题栏的展示受 VS Code UI 限制

不同版本或主题下，`editor/title` 菜单可能仍以图标优先展示。

处理：

- 先按标准命令标题配置实现
- 如果 VS Code 仍只显示图标，再补充备用策略，例如新增 editor/title 次级菜单文案或调整命令命名

### 风险 2：命令标题与实际行为不一致

如果继续保留“翻译 Markdown（双栏预览）”，在 `tab` 模式下会造成误导。

处理：

- 将命令标题改为与布局无关的文案

## 验证方式

### 功能验证

1. 默认配置下点击“翻译”，翻译结果在右侧第二列打开。
2. 将 `markdownAiTranslate.openMode` 设置为 `tab` 后再次点击“翻译”，翻译结果在当前标签栏新增标签，不在右侧分栏打开。
3. 翻译结果页仍然保留“以预览方式打开翻译结果”按钮。
4. 缓存命中场景下，两种打开方式都生效。

### 回归验证

1. `npm run lint`
2. `npm run compile`
3. `npm run package`

## 实施范围

- [package.json](/E:/code/junes/github/Markdown-AI-Translate/package.json)
- [src/fileTranslator.ts](/E:/code/junes/github/Markdown-AI-Translate/src/fileTranslator.ts)

必要时可同步更新：

- [README.md](/E:/code/junes/github/Markdown-AI-Translate/README.md)
