import * as https from "https";
import * as http from "http";
import { l10n } from "vscode";

export interface TranslateOptions {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  customPrompt?: string;
  codeCommentPrompt?: string;
}

export type TranslatePromptKind = "markdown" | "codeComment";

const DEFAULT_MARKDOWN_SYSTEM_PROMPT = l10n.t(
  "You are a professional translator. Translate the user-provided text into the target language.\nRules:\n- Preserve all Markdown formatting, including headings, lists, links, images, and inline code\n- Do not modify placeholders such as __URL0__, __CODE0__, __SEGMENT_0_START__, or __SEGMENT_0_END__\n- Do not translate URLs or image paths\n- Keep the original paragraph structure\n- Output only the translated text with no explanations"
);

const DEFAULT_CODE_COMMENT_SYSTEM_PROMPT = l10n.t(
  "You are a professional technical translator. Translate comment text extracted from fenced code blocks into the target language.\nRules:\n- Translate only natural-language comment text\n- Preserve code identifiers, commands, package names, flags, file paths, URLs, and placeholders such as __URL0__, __CODE0__, __SEGMENT_0_START__, or __SEGMENT_0_END__ exactly\n- Do not add Markdown formatting, bold or italic markers, quote wrappers, comment markers, or explanations\n- Keep the original meaning concise\n- Output only the translated comment text"
);

/**
 * Protect URLs/paths in markdown syntax from being garbled by the model.
 * Only the URL part is replaced with a placeholder — alt text / link text
 * is left in place so the model can translate it.
 */
function protect(text: string): { protected: string; tokens: string[] } {
  const tokens: string[] = [];
  let result = text;

  // Single-pass regex for both images and links to avoid re-matching
  result = result.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, bang, label, url) => {
      tokens.push(url);
      return `${bang}[${label}](__URL${tokens.length - 1}__)`;
    }
  );

  // Protect inline code: `code` → __CODE0__
  result = result.replace(/`([^`]+)`/g, (match) => {
    tokens.push(match);
    return `__CODE${tokens.length - 1}__`;
  });

  return { protected: result, tokens };
}

function restore(text: string, tokens: string[]): string {
  let result = text;
  for (let i = tokens.length - 1; i >= 0; i--) {
    // CODE placeholders are full matches like `code`
    const codeRe = new RegExp(`__CODE${i}__`, "g");
    // URL placeholders are inside (...) — restore the URL
    const urlRe = new RegExp(`__URL${i}__`, "g");
    result = result.replace(codeRe, tokens[i]).replace(urlRe, tokens[i]);
  }
  return result;
}

function getSystemPrompt(
  options: TranslateOptions,
  promptKind: TranslatePromptKind
): { prompt: string; isCustom: boolean } {
  if (promptKind === "codeComment") {
    const codeCommentPrompt = options.codeCommentPrompt?.trim();
    return {
      prompt: codeCommentPrompt || DEFAULT_CODE_COMMENT_SYSTEM_PROMPT,
      isCustom: Boolean(codeCommentPrompt),
    };
  }

  const customPrompt = options.customPrompt?.trim();
  return {
    prompt: customPrompt || DEFAULT_MARKDOWN_SYSTEM_PROMPT,
    isCustom: Boolean(customPrompt),
  };
}

function buildUserPrompt(
  protectedText: string,
  options: TranslateOptions,
  promptKind: TranslatePromptKind,
  hasCustomSystemPrompt: boolean
): string {
  if (promptKind === "codeComment") {
    return l10n.t(
      "Target language: {0}\n\nComment text:\n{1}",
      options.targetLanguage,
      protectedText
    );
  }

  return hasCustomSystemPrompt
    ? l10n.t(
        "Target language: {0}\n\nText:\n{1}",
        options.targetLanguage,
        protectedText
      )
    : l10n.t(
        "Translate the following text into {0}. Output only the translation with no explanations.\n\n{1}",
        options.targetLanguage,
        protectedText
      );
}

export async function translateText(
  text: string,
  options: TranslateOptions,
  promptKind: TranslatePromptKind = "markdown"
): Promise<string> {
  const { protected: protectedText, tokens } = protect(text);
  const systemPrompt = getSystemPrompt(options, promptKind);

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const prompt = buildUserPrompt(
        protectedText,
        options,
        promptKind,
        systemPrompt.isCustom
      );
      const raw = await callOpenAI(prompt, systemPrompt.prompt, options);
      return restore(raw, tokens);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(l10n.t("Translation request retries exhausted."));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callOpenAI(
  prompt: string,
  systemPrompt: string,
  options: TranslateOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${options.apiEndpoint}/chat/completions`);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      stream: false,
    });

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = httpModule.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk: string | Buffer) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              l10n.t(
                "API request failed {0}: {1}",
                String(res.statusCode),
                data.slice(0, 200)
              )
            )
          );
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error(l10n.t("The API response was empty.")));
            return;
          }
          resolve(content.trim());
        } catch {
          reject(
            new Error(
              l10n.t(
                "Failed to parse API response: {0}",
                data.slice(0, 200)
              )
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error(l10n.t("API request timed out (120 seconds).")));
    });
    req.write(body);
    req.end();
  });
}
