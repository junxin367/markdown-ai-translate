import * as https from "https";
import * as http from "http";

export interface TranslateOptions {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  customPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `你是一名专业翻译。请把用户提供的文本翻译成目标语言。
规则：
- 保留所有 Markdown 格式，包括标题、列表、链接、图片、行内代码等
- 不要修改任何占位符，例如 __URL0__、__CODE0__、__SEGMENT_0_START__ 或 __SEGMENT_0_END__
- 不要翻译 URL 或图片路径
- 保持原有段落结构
- 只输出翻译后的文本，不要输出任何解释`;

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

export async function translateText(
  text: string,
  options: TranslateOptions
): Promise<string> {
  const { protected: protectedText, tokens } = protect(text);
  const systemPrompt = options.customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const prompt = `请将以下文本翻译成${options.targetLanguage}。只输出翻译结果，不要输出任何解释。\n\n${protectedText}`;
      const raw = await callOpenAI(prompt, systemPrompt, options);
      return restore(raw, tokens);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error("翻译请求重试次数已用完。");
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
              `API 请求失败 ${res.statusCode}: ${data.slice(0, 200)}`
            )
          );
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error("API 返回内容为空。"));
            return;
          }
          resolve(content.trim());
        } catch {
          reject(
            new Error(
              `解析 API 响应失败: ${data.slice(0, 200)}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error("API 请求超时（120 秒）。"));
    });
    req.write(body);
    req.end();
  });
}
