/**
 * Split markdown content into translatable segments.
 * Each segment is either a text block (to translate) or a code block (to skip).
 */
export interface Segment {
  type: "text" | "code";
  content: string;
}

export function splitMarkdown(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flush = (type: "text" | "code") => {
    if (current.length > 0) {
      segments.push({ type, content: current.join("\n") });
      current = [];
    }
  };

  for (const line of lines) {
    // Detect fenced code block boundaries
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        current.push(line);
        flush("code");
        inCodeBlock = false;
      } else {
        flush("text");
        current.push(line);
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      current.push(line);
      continue;
    }

    // Blank lines are markdown structure. Keep them outside translated text so
    // model output trimming cannot collapse paragraph boundaries.
    if (line.trim() === "") {
      flush("text");
      segments.push({ type: "code", content: line });
      continue;
    }

    current.push(line);
  }

  // Flush remaining
  if (current.length > 0) {
    flush(inCodeBlock ? "code" : "text");
  }

  return segments;
}

/**
 * Reassemble segments into a single markdown string.
 * Replaces segments with their translated content when available.
 */
export function reassembleMarkdown(
  segments: Segment[],
  translations: Map<number, string>
): string {
  return segments
    .map((seg, i) => translations.get(i) ?? seg.content)
    .join("\n");
}
