// Geometry-only OCR ordering; never inserts expected payment values.
type VisionWord = {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerY: number;
  height: number;
};

function visionWordText(word: Record<string, unknown>): string {
  const symbols = Array.isArray(word.symbols)
    ? word.symbols as Array<Record<string, unknown>>
    : [];
  return symbols.map((symbol) =>
    typeof symbol.text === "string" ? symbol.text : ""
  ).join("").trim();
}

function visionWordBox(
  word: Record<string, unknown>,
  pageWidth: number,
  pageHeight: number,
): Omit<VisionWord, "text"> | null {
  const boundingBox = word.boundingBox && typeof word.boundingBox === "object"
    ? word.boundingBox as Record<string, unknown>
    : null;
  if (!boundingBox) return null;

  const rawVertices = Array.isArray(boundingBox.vertices)
    ? boundingBox.vertices as Array<Record<string, unknown>>
    : Array.isArray(boundingBox.normalizedVertices)
    ? boundingBox.normalizedVertices as Array<Record<string, unknown>>
    : [];
  if (rawVertices.length < 2) return null;

  const normalized = !Array.isArray(boundingBox.vertices) &&
    Array.isArray(boundingBox.normalizedVertices);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const vertex of rawVertices) {
    const rawX = typeof vertex.x === "number" ? vertex.x : 0;
    const rawY = typeof vertex.y === "number" ? vertex.y : 0;
    const x = normalized && pageWidth > 0 ? rawX * pageWidth : rawX;
    const y = normalized && pageHeight > 0 ? rawY * pageHeight : rawY;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 2 || ys.length < 2) return null;

  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const height = bottom - top;
  if (!(right > left) || !(height > 0)) return null;
  return {
    left,
    right,
    top,
    bottom,
    centerY: (top + bottom) / 2,
    height,
  };
}

/**
 * Rebuilds OCR text in visual row order. Google Vision's plain text can emit
 * two-column receipts column-by-column, separating a label from its value.
 * Keeping words that share a visual row together lets the receipt parser see
 * pairs such as `Total Amount Sent  ₱420.00` without relaxing fraud checks.
 */
export function googleVisionLayoutText(
  annotation: Record<string, unknown> | null,
): string {
  if (!annotation) return "";
  const pages = Array.isArray(annotation.pages)
    ? annotation.pages as Array<Record<string, unknown>>
    : [];
  const pageTexts: string[] = [];

  for (const page of pages) {
    const pageWidth = typeof page.width === "number" ? page.width : 0;
    const pageHeight = typeof page.height === "number" ? page.height : 0;
    const words: VisionWord[] = [];
    let incompleteGeometry = false;
    const blocks = Array.isArray(page.blocks)
      ? page.blocks as Array<Record<string, unknown>>
      : [];
    for (const block of blocks) {
      const paragraphs = Array.isArray(block.paragraphs)
        ? block.paragraphs as Array<Record<string, unknown>>
        : [];
      for (const paragraph of paragraphs) {
        const paragraphWords = Array.isArray(paragraph.words)
          ? paragraph.words as Array<Record<string, unknown>>
          : [];
        for (const word of paragraphWords) {
          const text = visionWordText(word);
          const box = visionWordBox(word, pageWidth, pageHeight);
          if (text && box) words.push({ text, ...box });
          else if (text) incompleteGeometry = true;
        }
      }
    }
    // Never select a reconstructed candidate that silently dropped OCR words.
    // Partial layout evidence could otherwise hide a contradictory amount.
    if (incompleteGeometry) return "";
    if (!words.length) continue;

    words.sort((a, b) => a.centerY - b.centerY || a.left - b.left);
    const rows: Array<{
      words: VisionWord[];
      top: number;
      bottom: number;
      centerY: number;
    }> = [];
    for (const word of words) {
      let bestRow: typeof rows[number] | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        const overlap = Math.max(
          0,
          Math.min(row.bottom, word.bottom) - Math.max(row.top, word.top),
        );
        const overlapRatio = overlap / Math.min(
          Math.max(1, row.bottom - row.top),
          word.height,
        );
        const distance = Math.abs(row.centerY - word.centerY);
        const sameRow = overlapRatio >= 0.35 ||
          distance <= Math.max(2, word.height * 0.45);
        if (sameRow && distance < bestDistance) {
          bestRow = row;
          bestDistance = distance;
        }
      }
      if (!bestRow) {
        rows.push({
          words: [word],
          top: word.top,
          bottom: word.bottom,
          centerY: word.centerY,
        });
        continue;
      }
      bestRow.words.push(word);
      bestRow.top = Math.min(bestRow.top, word.top);
      bestRow.bottom = Math.max(bestRow.bottom, word.bottom);
      bestRow.centerY = bestRow.words.reduce(
        (sum, item) => sum + item.centerY,
        0,
      ) / bestRow.words.length;
    }

    rows.sort((a, b) => a.centerY - b.centerY);
    const text = rows.map((row) =>
      row.words.sort((a, b) => a.left - b.left)
        .map((word) => word.text)
        .join(" ")
    ).filter(Boolean).join("\n");
    if (text) pageTexts.push(text);
  }
  return pageTexts.join("\n");
}
