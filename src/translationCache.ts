import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Simple hash for cache key — fast, non-cryptographic */
function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export class TranslationCache {
  private cache = new Map<string, string>();
  private filePath: string;

  constructor(originalUri: vscode.Uri, storageUri: vscode.Uri) {
    const originalPath = originalUri.fsPath;
    const cacheDir = path.join(storageUri.fsPath, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    this.filePath = path.join(
      cacheDir,
      `${path.basename(originalPath, ".md")}-${hashText(originalPath)}.translate.json`
    );
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v as string);
        }
      }
    } catch {
      // Corrupted cache — start fresh
    }
  }

  save() {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.cache) {
      obj[k] = v;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  get(original: string): string | undefined {
    return this.cache.get(hashText(original));
  }

  set(original: string, translated: string) {
    this.cache.set(hashText(original), translated);
  }
}

export function clearTranslationCache(storageUri: vscode.Uri): number {
  const cacheDir = path.join(storageUri.fsPath, "cache");
  if (!fs.existsSync(cacheDir)) return 0;

  let deleted = 0;
  for (const entry of fs.readdirSync(cacheDir)) {
    if (!entry.endsWith(".translate.json")) continue;
    fs.unlinkSync(path.join(cacheDir, entry));
    deleted++;
  }

  return deleted;
}
