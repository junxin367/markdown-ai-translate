# Markdown AI Translate By junes

Markdown AI Translate By junes 是一个 VS Code Markdown 翻译插件。它通过 OpenAI 兼容 API 翻译当前 Markdown 文件，并在右侧打开临时预览文档，方便并排查看原文和译文。

## 功能特性

- **双栏预览**：翻译结果作为未保存的临时 Markdown 文档在右侧打开，不污染项目目录。
- **增量显示**：翻译批次完成后持续刷新结果文件，不必等待全文结束。
- **翻译缓存**：缓存保存到 VS Code 扩展存储目录，再次翻译时只处理新增或变更段落。
- **Markdown 格式保护**：尽量保留标题、段落空行、列表、任务列表、引用、表格、链接、图片路径、行内代码和代码块，可通过设置控制是否翻译代码围栏内的注释文本。
- **OpenAI 兼容接口**：支持 OpenAI、DeepSeek、智谱 GLM、Ollama 等兼容 `/chat/completions` 的服务。

## 使用方法

### 1. 配置 API

首次点击编辑器右上角 **翻译icon** 按钮时，如果还没有配置 API Key，插件会自动打开自己的设置页。

也可以从命令面板打开插件设置：

1. 按 `Ctrl+Shift+P` 打开命令面板。
2. 输入并运行 **打开 Markdown AI Translate 设置**。
3. VS Code 会直接打开并筛选出本插件的全部设置项。

需要清除翻译缓存时：

1. 按 `Ctrl+Shift+P` 打开命令面板。
2. 输入并运行 **清除 Markdown 翻译缓存**。
3. 插件会删除保存在 VS Code 扩展存储目录中的翻译缓存文件。

也可以手动打开设置：

1. 在 VS Code 中按 `Ctrl+,` 打开设置。
2. 在设置搜索框输入 `markdownAiTranslate`，可以看到本插件的全部设置项。
3. 填写 `API Key`、`OpenAI 兼容 API 地址`、`模型名称` 和 `目标语言`。

如果更喜欢直接编辑 JSON，可以打开命令面板，运行 **首选项: 打开用户设置(JSON)**，加入以下配置：

```json
{
  "markdownAiTranslate.apiEndpoint": "https://api.deepseek.com/v1",
  "markdownAiTranslate.apiKey": "你的 API Key",
  "markdownAiTranslate.model": "deepseek-chat",
  "markdownAiTranslate.targetLanguage": "中文"
}
```

设置项说明：

| 设置项 | 说明 | 示例 |
| --- | --- | --- |
| `markdownAiTranslate.apiEndpoint` | OpenAI 兼容 API 地址 | `https://api.deepseek.com/v1` |
| `markdownAiTranslate.apiKey` | API Key | `你的 API Key` |
| `markdownAiTranslate.model` | 模型名称 | `deepseek-chat` |
| `markdownAiTranslate.targetLanguage` | 目标语言 | `中文` |
| `markdownAiTranslate.customPrompt` | 多行文本输入框。默认填充内置提示词；清空时仍使用内置提示词。自定义后会替换内置翻译指令 | `请保留 Markdown 格式...` |
| `markdownAiTranslate.translateCodeComments` | 是否翻译代码围栏内的注释。默认关闭；关闭后代码围栏完全按原文保留 | `false` |

### 2. 翻译 Markdown

1. 打开任意 `.md` 文件。
2. 点击编辑器标题栏中的 **翻译icon** 按钮，或通过命令面板运行 **翻译 Markdown（双栏预览）**。
3. 插件会在右侧打开临时翻译预览文档。
4. 再次运行时会复用缓存，只翻译未缓存或已变更的内容。

## 文件行为

插件不会在项目目录内生成 `_zh.md` 或 `.translate.json` 文件。翻译结果是未保存的临时文档，缓存位于 VS Code 扩展存储目录中。需要保留译文时，可以手动执行“另存为”。

## 本地开发

```bash
npm install
npm run compile
npm run lint
```

在 VS Code 中按 `F5` 启动 Extension Development Host，即可调试插件。

## 本地打包

```bash
npm run package
```

打包后会生成 `release/Markdown AI Translate By junes-1.0.0.vsix`，可通过 VS Code 的 **从 VSIX 安装...** 安装。

## 许可证

MIT
