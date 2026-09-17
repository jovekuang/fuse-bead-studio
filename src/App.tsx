import { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { PALETTE, countBeads } from "../shared/palette";
import { COCO_BY_MARD } from "../shared/colorCodes";

type View = "home" | "upload" | "gallery" | "inventory";
type UploadMode = "photo" | "template" | "scratch";
type EditorTool = "brush" | "bucket" | "eraser" | "eyedropper" | "replace";
type SizePreset = "small" | "medium" | "large" | "custom";
type Template = { id: string; title: string; sourceKind: UploadMode; sourceUrl: string; width: number; height: number; cells: Array<string | null>; updatedAt: string };
type Artwork = { id: string; templateId: string | null; templateTitle: string; photoUrl: string; caption: string; usage: Record<string, number>; inventoryDeducted: boolean; createdAt: string };
type Inventory = { code: string; name: string; hex: string; quantity: number; lowThreshold: number; isLow: boolean };
type StockTransaction = { id: string; type: "refill" | "use" | "adjustment"; label: string; changes: Record<string, number>; createdAt: string };
type Draft = { id?: string; title: string; sourceKind: UploadMode; sourceFile?: File; sourceUrl: string; width: number; height: number; cells: Array<string | null> };
type OcrWord = { text: string; left: number; top: number; width: number; height: number; confidence: number };
const NAV_LABELS: Record<View, string> = { home: "Home", upload: "Create", gallery: "Gallery", inventory: "Inventory" };
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SERIES = [...new Set(PALETTE.map((color) => color.code[0]))];
const SERIES_NAMES: Record<string, string> = {
  A: "Yellows", B: "Greens", C: "Blues & aquas", D: "Purples", E: "Pinks",
  F: "Reds & corals", G: "Browns & skin tones", H: "Neutrals & transparent",
  M: "Muted neutrals", P: "Pastels & accents", R: "Bright basics",
  Y: "Special pastels", Q: "Specialty greens", T: "Glow in the dark",
};
const RESOLUTIONS: Array<{ id: SizePreset; label: string; width?: number; height?: number }> = [
  { id: "small", label: "Small", width: 26, height: 26 },
  { id: "medium", label: "Medium", width: 52, height: 52 },
  { id: "large", label: "Large", width: 104, height: 104 },
  { id: "custom", label: "Custom" },
];

function fitArtworkToSmall(draft: Draft): Draft | null {
  const occupied = draft.cells.flatMap((code, index) => code ? [{ x: index % draft.width, y: Math.floor(index / draft.width), code }] : []);
  if (!occupied.length) return null;
  const left = Math.min(...occupied.map((cell) => cell.x));
  const right = Math.max(...occupied.map((cell) => cell.x));
  const top = Math.min(...occupied.map((cell) => cell.y));
  const bottom = Math.max(...occupied.map((cell) => cell.y));
  if (right - left + 1 > 26 || bottom - top + 1 > 26) return null;
  const offsetX = Math.floor((26 - (right - left + 1)) / 2);
  const offsetY = Math.floor((26 - (bottom - top + 1)) / 2);
  const cells: Draft["cells"] = Array(26 * 26).fill(null);
  for (const cell of occupied) cells[(cell.y - top + offsetY) * 26 + cell.x - left + offsetX] = cell.code;
  return { ...draft, width: 26, height: 26, cells };
}

function resizeDraft(draft: Draft, width: number, height: number): { draft: Draft | null; cropped: number } {
  const cells: Draft["cells"] = Array(width * height).fill(null);
  let cropped = 0;
  draft.cells.forEach((code, index) => {
    if (!code) return;
    const x = index % draft.width;
    const y = Math.floor(index / draft.width);
    if (x < 0 || x >= width || y < 0 || y >= height) cropped += 1;
    else cells[y * width + x] = code;
  });
  return { draft: cropped ? null : { ...draft, width, height, cells }, cropped };
}

function moveSelectedDraft(draft: Draft, selection: Set<number>, columnOffset: number, rowOffset: number): { draft: Draft | null; cropped: number; blocked: number } {
  const selected = [...selection].filter((index) => Boolean(draft.cells[index]));
  const cells = [...draft.cells];
  let cropped = 0; let blocked = 0;
  for (const index of selected) {
    const x = index % draft.width + columnOffset;
    const y = Math.floor(index / draft.width) + rowOffset;
    if (x < 0 || x >= draft.width || y < 0 || y >= draft.height) { cropped += 1; continue; }
    const destination = y * draft.width + x;
    if (draft.cells[destination] && !selection.has(destination)) blocked += 1;
  }
  if (cropped || blocked || !selected.length) return { draft: null, cropped, blocked };
  for (const index of selected) cells[index] = null;
  for (const index of selected) {
    const destination = (Math.floor(index / draft.width) + rowOffset) * draft.width + index % draft.width + columnOffset;
    cells[destination] = draft.cells[index];
  }
  return { draft: { ...draft, cells }, cropped: 0, blocked: 0 };
}

function lineCellIndices(from: number, to: number, width: number): number[] {
  let x0 = from % width; let y0 = Math.floor(from / width);
  const x1 = to % width; const y1 = Math.floor(to / width);
  const dx = Math.abs(x1 - x0); const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0); const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy; const indices: number[] = [];
  while (true) {
    indices.push(y0 * width + x0);
    if (x0 === x1 && y0 === y1) break;
    const doubled = error * 2;
    if (doubled >= dy) { error += dy; x0 += sx; }
    if (doubled <= dx) { error += dx; y0 += sy; }
  }
  return indices;
}

function rectangleCellIndices(from: number, to: number, width: number): number[] {
  const fromX = from % width; const fromY = Math.floor(from / width);
  const toX = to % width; const toY = Math.floor(to / width);
  const indices: number[] = [];
  for (let y = Math.min(fromY, toY); y <= Math.max(fromY, toY); y += 1) {
    for (let x = Math.min(fromX, toX); x <= Math.max(fromX, toX); x += 1) indices.push(y * width + x);
  }
  return indices;
}

const paletteByCode = new Map<string, (typeof PALETTE)[number]>(PALETTE.map((color) => [color.code, color]));
function paletteCodesFromText(text: string): string[] {
  const tokens = text.toUpperCase().match(/[A-Z0-9]{2,3}/g) ?? []; const codes = new Set<string>();
  const leadingConfusions: Record<string, string> = { "4": "H", "6": "G", "8": "B", "0": "Q" };
  for (const token of tokens) {
    if (paletteByCode.has(token)) codes.add(token);
    const corrected = `${leadingConfusions[token[0]] ?? token[0]}${token.slice(1)}`;
    if (paletteByCode.has(corrected)) codes.add(corrected);
  }
  return [...codes];
}
const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) {
    const shortage = result.shortages?.map((item: { code: string; needed: number; available: number }) => `${item.code}: need ${item.needed}, have ${item.available}`).join(" · ");
    throw new Error(shortage || result.message || "Something went wrong.");
  }
  return result;
};

async function recognizeSegmentedCode(image: HTMLImageElement, bounds: [number, number, number, number]): Promise<string | null> {
  const [x1, x2, y1, y2] = bounds; const source = document.createElement("canvas");
  source.width = Math.max(16, Math.round((x2 - x1) * .62)); source.height = Math.max(16, Math.round((y2 - y1) * .5));
  const sourceContext = source.getContext("2d", { willReadFrequently: true })!;
  sourceContext.drawImage(image, x1 + (x2 - x1) * .19, y1 + (y2 - y1) * .25, (x2 - x1) * .62, (y2 - y1) * .5, 0, 0, source.width, source.height);
  const data = sourceContext.getImageData(0, 0, source.width, source.height); const buckets = new Map<number, WeightedRgb>();
  for (let index = 0; index < data.data.length; index += 4) {
    const red = data.data[index]; const green = data.data[index + 1]; const blue = data.data[index + 2]; const key = (red >> 3) << 10 | (green >> 3) << 5 | (blue >> 3);
    const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, count: 0 }; bucket.red += red; bucket.green += green; bucket.blue += blue; bucket.count += 1; buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0]; if (!dominant) return null;
  const background = [dominant.red / dominant.count, dominant.green / dominant.count, dominant.blue / dominant.count]; const mask = new Uint8Array(source.width * source.height);
  const columnInk = Array(source.width).fill(0);
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < source.width; x += 1) {
    const offset = (y * source.width + x) * 4; const distance = [0, 1, 2].reduce((sum, channel) => sum + (data.data[offset + channel] - background[channel]) ** 2, 0);
    if (distance > 42 ** 2 * 3) { mask[y * source.width + x] = 1; columnInk[x] += 1; }
  }
  const activeColumns = columnInk.flatMap((count, x) => count >= Math.max(2, source.height * .06) ? [x] : []); const groups: Array<[number, number]> = [];
  for (const x of activeColumns) {
    const group = groups.at(-1); if (!group || x > group[1] + 2) groups.push([x, x]); else group[1] = x;
  }
  let glyphs = groups.filter(([left, right]) => right - left + 1 >= 2);
  if (glyphs.length < 2 || glyphs.length > 3) {
    if (!activeColumns.length) return null;
    const left = Math.min(...activeColumns); const right = Math.max(...activeColumns); let top = source.height; let bottom = -1;
    for (let y = 0; y < source.height; y += 1) for (let x = left; x <= right; x += 1) if (mask[y * source.width + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    if (bottom < top) return null;
    const characterCount = (right - left + 1) / (bottom - top + 1) > 1.55 ? 3 : 2; const characterWidth = (right - left + 1) / characterCount;
    glyphs = Array.from({ length: characterCount }, (_, index): [number, number] => [Math.round(left + index * characterWidth), Math.round(left + (index + 1) * characterWidth - 1)]);
  }
  let code = "";
  for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex += 1) {
    const [left, right] = glyphs[glyphIndex]; let top = source.height; let bottom = -1;
    for (let y = 0; y < source.height; y += 1) for (let x = left; x <= right; x += 1) if (mask[y * source.width + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    if (bottom < top) return null;
    const glyph = document.createElement("canvas"); glyph.width = 220; glyph.height = 220; const context = glyph.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, glyph.width, glyph.height);
    const binary = document.createElement("canvas"); binary.width = source.width; binary.height = source.height; const binaryContext = binary.getContext("2d")!; const binaryData = binaryContext.createImageData(source.width, source.height);
    for (let index = 0; index < mask.length; index += 1) { const value = mask[index] ? 0 : 255; binaryData.data[index * 4] = value; binaryData.data[index * 4 + 1] = value; binaryData.data[index * 4 + 2] = value; binaryData.data[index * 4 + 3] = 255; }
    binaryContext.putImageData(binaryData, 0, 0); context.imageSmoothingEnabled = false; context.drawImage(binary, left, top, right - left + 1, bottom - top + 1, 24, 24, 172, 172);
    const blob = await new Promise<Blob>((resolve, reject) => glyph.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare a printed character.")), "image/png"));
    const body = new FormData(); body.append("image", blob, "character.png"); const kind = glyphIndex === 0 ? "letter" : "digit";
    const { text } = await api<{ text: string }>(`/api/ocr-template?mode=char&kind=${kind}`, { method: "POST", body });
    const character = text.toUpperCase().match(kind === "letter" ? /[ABCDEFGHMPRQTY]/ : /\d/)?.[0]; if (!character) return null; code += character;
  }
  return paletteByCode.has(code) ? code : null;
}

function nearestColor(red: number, green: number, blue: number, allowedCodes?: Set<string>): string {
  const candidates = allowedCodes?.size ? PALETTE.filter((color) => allowedCodes.has(color.code)) : PALETTE;
  let match: (typeof PALETTE)[number] = candidates[0] ?? PALETTE[0]; let distance = Infinity;
  for (const color of candidates) {
    if (color.transparent || color.code === "T1") continue;
    const hex = color.hex.slice(1); const r = parseInt(hex.slice(0, 2), 16); const g = parseInt(hex.slice(2, 4), 16); const b = parseInt(hex.slice(4, 6), 16);
    const next = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
    if (next < distance) { distance = next; match = color; }
  }
  return match.code;
}

function labelColor(hex: string): string {
  const red = parseInt(hex.slice(1, 3), 16); const green = parseInt(hex.slice(3, 5), 16); const blue = parseInt(hex.slice(5, 7), 16);
  return red * .299 + green * .587 + blue * .114 > 165 ? "#342f2b" : "white";
}

type WeightedRgb = { red: number; green: number; blue: number; count: number };

function dominantPalette(pixels: Uint8ClampedArray, foreground: number[]): Set<string> {
  const buckets = new Map<number, { red: number; green: number; blue: number; count: number }>();
  for (const index of foreground) {
    const offset = index * 4; const red = pixels[offset]; const green = pixels[offset + 1]; const blue = pixels[offset + 2];
    const key = (red >> 3) << 10 | (green >> 3) << 5 | (blue >> 3);
    const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, count: 0 };
    bucket.red += red; bucket.green += green; bucket.blue += blue; bucket.count += 1; buckets.set(key, bucket);
  }
  const samples: WeightedRgb[] = [...buckets.values()].map((bucket) => ({
    red: bucket.red / bucket.count, green: bucket.green / bucket.count, blue: bucket.blue / bucket.count, count: bucket.count,
  }));
  if (!samples.length) return new Set();

  // Small bead designs need fewer shades. Larger occupied areas retain more detail,
  // up to ten colors, while a simple ~400-bead illustration is limited to four.
  const colorLimit = Math.max(3, Math.min(10, Math.round(Math.sqrt(foreground.length) / 5)));
  const centers: WeightedRgb[] = [{ ...samples.reduce((best, sample) => sample.count > best.count ? sample : best) }];
  const distanceToCenters = (sample: WeightedRgb) => Math.min(...centers.map((center) =>
    (sample.red - center.red) ** 2 + (sample.green - center.green) ** 2 + (sample.blue - center.blue) ** 2));
  while (centers.length < Math.min(colorLimit, samples.length)) {
    const next = samples.reduce((best, sample) => distanceToCenters(sample) * Math.sqrt(sample.count) > distanceToCenters(best) * Math.sqrt(best.count) ? sample : best);
    centers.push({ ...next });
  }
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const totals = centers.map(() => ({ red: 0, green: 0, blue: 0, count: 0 }));
    for (const sample of samples) {
      let cluster = 0; let closest = Infinity;
      centers.forEach((center, index) => {
        const distance = (sample.red - center.red) ** 2 + (sample.green - center.green) ** 2 + (sample.blue - center.blue) ** 2;
        if (distance < closest) { closest = distance; cluster = index; }
      });
      totals[cluster].red += sample.red * sample.count; totals[cluster].green += sample.green * sample.count; totals[cluster].blue += sample.blue * sample.count; totals[cluster].count += sample.count;
    }
    totals.forEach((total, index) => {
      if (total.count) centers[index] = { red: total.red / total.count, green: total.green / total.count, blue: total.blue / total.count, count: total.count };
    });
  }
  return new Set(centers.filter((center) => center.count).map((center) => nearestColor(center.red, center.green, center.blue)));
}

async function pictureToGrid(file: File, width: number, height: number): Promise<{ sourceUrl: string; width: number; height: number; cells: Array<string | null> }> {
  const sourceUrl = URL.createObjectURL(file);
  const image = new Image(); image.src = sourceUrl; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const sourceRatio = image.naturalWidth / image.naturalHeight; const targetRatio = width / height;
  let sourceX = 0; let sourceY = 0; let sourceWidth = image.naturalWidth; let sourceHeight = image.naturalHeight;
  if (sourceRatio > targetRatio) { sourceWidth = image.naturalHeight * targetRatio; sourceX = (image.naturalWidth - sourceWidth) / 2; }
  else if (sourceRatio < targetRatio) { sourceHeight = image.naturalWidth / targetRatio; sourceY = (image.naturalHeight - sourceHeight) / 2; }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const borderRed: number[] = []; const borderGreen: number[] = []; const borderBlue: number[] = [];
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    if (row !== 0 && row !== height - 1 && column !== 0 && column !== width - 1) continue;
    const offset = (row * width + column) * 4; borderRed.push(pixels[offset]); borderGreen.push(pixels[offset + 1]); borderBlue.push(pixels[offset + 2]);
  }
  const background = [median(borderRed), median(borderGreen), median(borderBlue)];
  const isBackground = Array(width * height).fill(false); const queue: number[] = [];
  const resemblesBackground = (index: number) => {
    const offset = index * 4; if (pixels[offset + 3] < 40) return true;
    return (pixels[offset] - background[0]) ** 2 + (pixels[offset + 1] - background[1]) ** 2 + (pixels[offset + 2] - background[2]) ** 2 <= 42 ** 2;
  };
  const addBackground = (index: number) => { if (!isBackground[index] && resemblesBackground(index)) { isBackground[index] = true; queue.push(index); } };
  for (let column = 0; column < width; column += 1) { addBackground(column); addBackground((height - 1) * width + column); }
  for (let row = 1; row < height - 1; row += 1) { addBackground(row * width); addBackground(row * width + width - 1); }
  while (queue.length) {
    const index = queue.pop()!; const row = Math.floor(index / width); const column = index % width;
    if (column > 0) addBackground(index - 1); if (column < width - 1) addBackground(index + 1);
    if (row > 0) addBackground(index - width); if (row < height - 1) addBackground(index + width);
  }
  const foreground = Array.from({ length: width * height }, (_, index) => index).filter((index) => !isBackground[index]);
  const allowedCodes = dominantPalette(pixels, foreground);
  const cells: Array<string | null> = Array.from({ length: width * height }, (_, index) => {
    if (isBackground[index]) return null;
    const offset = index * 4; return nearestColor(pixels[offset], pixels[offset + 1], pixels[offset + 2], allowedCodes);
  });
  const initialCounts = countBeads(cells); const stableCodes = new Set(Object.entries(initialCounts).filter(([, count]) => count > 1).map(([code]) => code));
  cells.forEach((code, index) => {
    if (!code || initialCounts[code] !== 1) return;
    const nearby = new Map<string, number>(); const row = Math.floor(index / width); const column = index % width;
    for (let radius = 1; radius <= 3 && nearby.size === 0; radius += 1) for (let y = Math.max(0, row - radius); y <= Math.min(height - 1, row + radius); y += 1) for (let x = Math.max(0, column - radius); x <= Math.min(width - 1, column + radius); x += 1) {
      const neighbor = cells[y * width + x]; if (neighbor && stableCodes.has(neighbor)) nearby.set(neighbor, (nearby.get(neighbor) ?? 0) + 1);
    }
    const replacement = [...nearby].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (replacement) cells[index] = replacement;
    else if (stableCodes.size) { const offset = index * 4; cells[index] = nearestColor(pixels[offset], pixels[offset + 1], pixels[offset + 2], stableCodes); }
  });
  return { sourceUrl, width, height, cells };
}

async function scratchSource(width: number, height: number): Promise<File> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!; context.fillStyle = "#fffdf8"; context.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create a blank template.")), "image/png"));
  return new File([blob], "blank-template.png", { type: "image/png" });
}

const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 255;
};

const glyphMasks = new Map<string, Uint8Array>();
function normalizedMask(canvas: HTMLCanvasElement, isInk: (red: number, green: number, blue: number) => boolean): Uint8Array | null {
  const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null;
  const data = context.getImageData(0, 0, canvas.width, canvas.height); let left = canvas.width; let top = canvas.height; let right = -1; let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) { const offset = (y * canvas.width + x) * 4; if (isInk(data.data[offset], data.data[offset + 1], data.data[offset + 2])) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); } }
  if (right < left || bottom < top) return null;
  const source = document.createElement("canvas"); source.width = canvas.width; source.height = canvas.height; const sourceContext = source.getContext("2d")!; sourceContext.fillStyle = "white"; sourceContext.fillRect(0, 0, source.width, source.height);
  const mask = sourceContext.createImageData(canvas.width, canvas.height);
  for (let index = 0; index < data.data.length; index += 4) { const ink = isInk(data.data[index], data.data[index + 1], data.data[index + 2]); const value = ink ? 0 : 255; mask.data[index] = value; mask.data[index + 1] = value; mask.data[index + 2] = value; mask.data[index + 3] = 255; }
  sourceContext.putImageData(mask, 0, 0);
  const target = document.createElement("canvas"); target.width = 96; target.height = 44; const targetContext = target.getContext("2d", { willReadFrequently: true })!; targetContext.fillStyle = "white"; targetContext.fillRect(0, 0, 96, 44); targetContext.imageSmoothingEnabled = false; targetContext.drawImage(source, left, top, right - left + 1, bottom - top + 1, 2, 2, 92, 40);
  const normalized = targetContext.getImageData(0, 0, 96, 44).data; const result = new Uint8Array(96 * 44);
  for (let index = 0; index < result.length; index += 1) result[index] = normalized[index * 4] < 128 ? 1 : 0;
  return result;
}

function recognizePrintedGlyph(image: HTMLImageElement, bounds: [number, number, number, number]): string | null {
  const [x1, x2, y1, y2] = bounds; const width = Math.max(12, Math.round((x2 - x1) * .56)); const height = Math.max(12, Math.round((y2 - y1) * .56));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, x1 + (x2 - x1) * .22, y1 + (y2 - y1) * .22, (x2 - x1) * .56, (y2 - y1) * .56, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data; const channels = [[], [], []] as [number[], number[], number[]];
  for (let index = 0; index < pixels.length; index += 4) { channels[0].push(pixels[index]); channels[1].push(pixels[index + 1]); channels[2].push(pixels[index + 2]); }
  const background = channels.map(median); const sample = normalizedMask(canvas, (red, green, blue) => (red - background[0]) ** 2 + (green - background[1]) ** 2 + (blue - background[2]) ** 2 > 34 ** 2);
  if (!sample) return null;
  let best = { code: "", score: -Infinity };
  for (const color of PALETTE) {
    let candidate = glyphMasks.get(color.code);
    if (!candidate) {
      const glyph = document.createElement("canvas"); glyph.width = 240; glyph.height = 110; const glyphContext = glyph.getContext("2d")!; glyphContext.fillStyle = "white"; glyphContext.fillRect(0, 0, glyph.width, glyph.height); glyphContext.fillStyle = "black"; glyphContext.font = "700 72px Arial, sans-serif"; glyphContext.textBaseline = "top"; glyphContext.fillText(color.code, 4, 4);
      candidate = normalizedMask(glyph, (red, green, blue) => red < 128 && green < 128 && blue < 128) ?? new Uint8Array(96 * 44); glyphMasks.set(color.code, candidate);
    }
    let intersection = 0; let union = 0;
    for (let index = 0; index < sample.length; index += 1) { if (sample[index] && candidate[index]) intersection += 1; if (sample[index] || candidate[index]) union += 1; }
    const score = intersection / Math.max(1, union); if (score > best.score) best = { code: color.code, score };
  }
  return best.score >= .28 ? best.code : null;
}

function findGridLines(data: ImageData, axis: "x" | "y"): number[] {
  const length = axis === "x" ? data.width : data.height;
  const cross = axis === "x" ? data.height : data.width;
  const candidates: number[] = [];
  for (let position = 0; position < length; position += 1) {
    let dark = 0; let sampled = 0;
    for (let other = 0; other < cross; other += 2) {
      const x = axis === "x" ? position : other; const y = axis === "x" ? other : position;
      const offset = (y * data.width + x) * 4; sampled += 1;
      if (Math.max(data.data[offset], data.data[offset + 1], data.data[offset + 2]) < 190) dark += 1;
    }
    if (dark / sampled > .35) candidates.push(position);
  }
  const groups: number[][] = [];
  for (const value of candidates) {
    const group = groups.at(-1);
    if (!group || value > group.at(-1)! + 1) groups.push([value]); else group.push(value);
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function findContrastGridLines(data: ImageData, axis: "x" | "y"): number[] {
  const length = axis === "x" ? data.width : data.height; const cross = axis === "x" ? data.height : data.width;
  const luminance = (position: number, other: number) => {
    const x = axis === "x" ? position : other; const y = axis === "x" ? other : position; const offset = (y * data.width + x) * 4;
    return data.data[offset] * .299 + data.data[offset + 1] * .587 + data.data[offset + 2] * .114;
  };
  const candidates: number[] = [];
  for (let position = 3; position < length - 3; position += 1) {
    let contrastHits = 0; let sampled = 0;
    for (let other = 0; other < cross; other += 2) {
      const neighbor = (luminance(position - 3, other) + luminance(position + 3, other)) / 2;
      if (neighbor - luminance(position, other) > 6) contrastHits += 1;
      sampled += 1;
    }
    if (contrastHits / sampled > .24) candidates.push(position);
  }
  const groups: number[][] = [];
  for (const value of candidates) {
    const group = groups.at(-1); if (!group || value > group.at(-1)! + 1) groups.push([value]); else group.push(value);
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function mergeGridLineCandidates(...groups: number[][]): number[] {
  const sorted = groups.flat().sort((left, right) => left - right); const merged: number[][] = [];
  for (const value of sorted) {
    const group = merged.at(-1); if (!group || value > group.at(-1)! + 2) merged.push([value]); else group.push(value);
  }
  return merged.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function photographedGridLines(data: ImageData, axis: "x" | "y", fraction = axis === "x" ? .05 : .025): number[] {
  const length = axis === "x" ? data.width : data.height; const cross = axis === "x" ? data.height : data.width;
  // Phone photos usually keep a clean strip of grid along the top and left even
  // when the artwork hides most lines in the center. Read that strip directly.
  const other = Math.round(cross * fraction); const radius = 4;
  const luminance = (position: number) => {
    const x = axis === "x" ? position : other; const y = axis === "x" ? other : position; const offset = (y * data.width + x) * 4;
    return data.data[offset] * .299 + data.data[offset + 1] * .587 + data.data[offset + 2] * .114;
  };
  const scores = Array(length).fill(0);
  for (let position = radius; position < length - radius; position += 1) scores[position] = (luminance(position - radius) + luminance(position + radius)) / 2 - luminance(position);
  const candidates: number[] = [];
  for (let position = radius; position < length - radius; position += 1) {
    const localBest = Math.max(...scores.slice(Math.max(radius, position - 3), Math.min(length - radius, position + 4)));
    if (scores[position] >= 12 && scores[position] >= localBest) candidates.push(position);
  }
  if (candidates.length < 5) return [];
  const spacing = gridSpacing(candidates); let best: number[] = [];
  // Perspective makes the spacing shrink gradually. Follow the smooth sequence of
  // line peaks instead of forcing a rectangle with perfectly uniform spacing.
  for (let start = 0; start < candidates.length; start += 1) {
    const lines = [candidates[start]]; let current = candidates[start]; let movingSpacing = spacing;
    while (true) {
      const expected = current + movingSpacing;
      const options = candidates.filter((candidate) => candidate > current && Math.abs(candidate - expected) <= spacing * .34);
      if (!options.length) break;
      const next = options.reduce((closest, candidate) => Math.abs(candidate - expected) < Math.abs(closest - expected) ? candidate : closest);
      movingSpacing = movingSpacing * .8 + (next - current) * .2; current = next; lines.push(next);
    }
    if (lines.length > best.length) best = lines;
  }
  return best.length >= 5 ? best : [];
}

function alignPerspectiveLines(reference: number[], observed: number[], axisLength: number): number[] {
  if (observed.length === reference.length) return observed;
  if (observed.length < 5 || observed.length > reference.length) return reference;
  const offset = observed.at(-1)! > axisLength * .85 ? reference.length - observed.length : observed[0] < axisLength * .15 ? 0 : -1;
  if (offset < 0) return reference;
  const source = reference.slice(offset, offset + observed.length); const sourceMean = source.reduce((sum, value) => sum + value, 0) / source.length;
  const observedMean = observed.reduce((sum, value) => sum + value, 0) / observed.length;
  const numerator = source.reduce((sum, value, index) => sum + (value - sourceMean) * (observed[index] - observedMean), 0);
  const denominator = source.reduce((sum, value) => sum + (value - sourceMean) ** 2, 0);
  const slope = denominator ? numerator / denominator : 1; const intercept = observedMean - slope * sourceMean;
  return reference.map((value) => value * slope + intercept);
}

function gridSpacing(lines: number[]): number {
  const gaps = lines.slice(1).map((value, index) => value - lines[index]).filter((gap) => gap >= 5 && gap <= 100);
  const frequencies = new Map<number, number>();
  for (const gap of gaps) frequencies.set(Math.round(gap), (frequencies.get(Math.round(gap)) ?? 0) + 1);
  const mode = [...frequencies].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 20;
  const matching = gaps.filter((gap) => Math.abs(gap - mode) <= 2);
  return matching.reduce((sum, gap) => sum + gap, 0) / Math.max(1, matching.length);
}

function regularGridLines(candidates: number[], spacing: number): number[] {
  const tolerance = Math.max(3, spacing * .24); let best: { start: number; first: number; last: number; score: number } | null = null;
  for (const start of candidates) {
    const steps = candidates.flatMap((candidate) => {
      const step = Math.round((candidate - start) / spacing);
      return Math.abs(candidate - (start + step * spacing)) <= tolerance ? [step] : [];
    });
    if (!steps.length) continue;
    const first = Math.min(...steps); const last = Math.max(...steps); const length = last - first + 1;
    const hits = new Set(steps).size; const density = hits / Math.max(1, length); const score = hits - (length - hits) * .28;
    if (length >= 5 && density >= .48 && (!best || score > best.score)) best = { start, first, last, score };
  }
  if (!best) return candidates;
  return Array.from({ length: best.last - best.first + 1 }, (_, index) => Math.round(best!.start + (best!.first + index) * spacing));
}

function fitGridLines(candidates: number[], spacing: number, cellCount: number, axisLength: number): number[] {
  const tolerance = Math.max(2, spacing * .22);
  let best: { origin: number; score: number } | null = null;
  for (const candidate of candidates) for (let line = 0; line <= cellCount; line += 1) {
    const origin = candidate - line * spacing; const end = origin + cellCount * spacing;
    if (origin < -tolerance || end > axisLength + tolerance) continue;
    let hits = 0;
    for (let index = 0; index <= cellCount; index += 1) {
      const expected = origin + index * spacing;
      if (candidates.some((value) => Math.abs(value - expected) <= tolerance)) hits += 1;
    }
    // Prefer the lattice with the most detected lines. A slight edge preference keeps
    // page furniture such as legends from winning an otherwise tied match.
    const edgePenalty = Math.min(origin, Math.max(0, axisLength - end)) / axisLength;
    const score = hits - edgePenalty * .05;
    if (!best || score > best.score) best = { origin, score };
  }
  if (!best || best.score < Math.max(5, cellCount * .2)) return regularGridLines(candidates, spacing);
  return Array.from({ length: cellCount + 1 }, (_, index) => Math.round(best!.origin + index * spacing));
}

function fitPrintedGridLines(candidates: number[], cellCount: number, axisLength: number, preferredSpacing?: number): number[] {
  const gaps = candidates.slice(1).map((value, index) => value - candidates[index]).filter((gap) => gap >= 5 && gap <= 100);
  const frequencies = new Map<number, number>();
  for (const gap of gaps) frequencies.set(Math.round(gap), (frequencies.get(Math.round(gap)) ?? 0) + 1);
  const spacings = [...frequencies].sort((left, right) => right[1] - left[1]).slice(0, 16).map(([gap]) => {
    const matching = gaps.filter((value) => Math.abs(value - gap) <= 2); return matching.reduce((sum, value) => sum + value, 0) / matching.length;
  });
  let best: { lines: number[]; hits: number; error: number } | null = null;
  const compatibleSpacings = preferredSpacing ? spacings.filter((spacing) => Math.abs(spacing - preferredSpacing) / preferredSpacing <= .3) : spacings;
  for (const spacing of compatibleSpacings.length ? compatibleSpacings : spacings) {
    const lines = fitGridLines(candidates, spacing, cellCount, axisLength); if (lines.length !== cellCount + 1) continue;
    const tolerance = Math.max(2, spacing * .22); let hits = 0; let error = 0;
    for (const line of lines) {
      const distance = Math.min(...candidates.map((candidate) => Math.abs(candidate - line)));
      if (distance <= tolerance) { hits += 1; error += distance; }
    }
    if (!best || hits > best.hits || hits === best.hits && error < best.error) best = { lines, hits, error };
  }
  return best && best.hits >= Math.max(5, Math.ceil((cellCount + 1) * .3)) ? best.lines : [];
}

async function readTemplatePage(image: HTMLImageElement): Promise<{ width: number; height: number; totalBeads: number | null; words: OcrWord[] } | null> {
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = longestSide < 1600 ? Math.min(3, 2000 / longestSide) : Math.min(1, 3000 / longestSide);
  const canvas = document.createElement("canvas"); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d"); if (!context) return null;
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not read template size.")), "image/png"));
  const body = new FormData(); body.append("image", blob, "template-page.png");
  const { text, words } = await api<{ text: string; words: OcrWord[] }>("/api/ocr-template", { method: "POST", body });
  const normalizedText = text.replace(/[\s,]/g, "");
  const sizeToken = normalizedText.match(/(\d{1,3})[xX×](\d{1,9})/);
  if (!sizeToken) return null;
  const width = Number(sizeToken[1]); const digitsAfterX = sizeToken[2];
  // OCR often joins the dimensions and bead total into one token (for example,
  // `21x20254`). Split it by testing the only interpretation whose total can fit
  // inside the declared grid. This prevents the trailing total from becoming rows.
  const tokenEnd = (sizeToken.index ?? 0) + sizeToken[0].length;
  const afterToken = normalizedText.slice(tokenEnd); const laterTotal = afterToken.match(/\d{2,6}/);
  // A normal header such as `52x52|1321` has a short, complete height before
  // the delimiter. Keep that height intact. Only split a long digit run such as
  // `21x20254`, where OCR removed the separator between height and bead total.
  if (digitsAfterX.length <= 3) {
    const height = Number(digitsAfterX); const totalBeads = laterTotal ? Number(laterTotal[0]) : null;
    return width >= 4 && width <= 128 && height >= 4 && height <= 128 ? { width, height, totalBeads, words: words.map((word) => ({ ...word, left: word.left / scale, top: word.top / scale, width: word.width / scale, height: word.height / scale })) } : null;
  }
  const interpretations = Array.from({ length: Math.min(3, digitsAfterX.length - 1) }, (_, index) => {
    const heightDigits = index + 1; const height = Number(digitsAfterX.slice(0, heightDigits));
    const trailing = digitsAfterX.slice(heightDigits); const totalBeads = trailing ? Number(trailing) : null;
    const validTotal = totalBeads === null || totalBeads > 0 && totalBeads <= width * height;
    return { height, totalBeads, valid: height >= 4 && height <= 128 && validTotal };
  }).filter((candidate) => candidate.valid).sort((left, right) => Number(right.totalBeads !== null) - Number(left.totalBeads !== null));
  const interpretation = interpretations[0]; if (!interpretation) return null;
  const height = interpretation.height;
  const totalBeads = interpretation.totalBeads ?? (laterTotal ? Number(laterTotal[0]) : null);
  return width >= 4 && width <= 128 && height >= 4 && height <= 128 ? { width, height, totalBeads, words: words.map((word) => ({ ...word, left: word.left / scale, top: word.top / scale, width: word.width / scale, height: word.height / scale })) } : null;
}

async function existingTemplateToGrid(file: File, progress: (message: string) => void): Promise<{ sourceUrl: string; width: number; height: number; cells: Array<string | null>; labelsRead: number; occupied: number }> {
  const sourceUrl = URL.createObjectURL(file); const image = new Image(); image.src = sourceUrl; await image.decode();
  progress("Reading the printed template size…");
  const printedPage = await readTemplatePage(image).catch(() => null); const printedSize = printedPage ? { width: printedPage.width, height: printedPage.height } : null;
  progress("Detecting the complete printed grid…");
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true })!; context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const sampleCanvas = document.createElement("canvas"); sampleCanvas.width = image.naturalWidth; sampleCanvas.height = image.naturalHeight;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true })!; sampleContext.drawImage(image, 0, 0);
  const samplePixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
  const rawXLines = mergeGridLineCandidates(findGridLines(pixels, "x"), findContrastGridLines(pixels, "x"));
  const rawYLines = mergeGridLineCandidates(findGridLines(pixels, "y"), findContrastGridLines(pixels, "y"));
  const spacingX = gridSpacing(rawXLines); const spacingY = gridSpacing(rawYLines);
  const photographedX = printedSize ? [] : photographedGridLines(pixels, "x"); const photographedY = printedSize ? [] : photographedGridLines(pixels, "y");
  const photographedXBottom = printedSize ? [] : photographedGridLines(pixels, "x", .95);
  const photographedYRight = printedSize ? [] : photographedGridLines(pixels, "y", .975);
  let xLines = printedSize ? fitPrintedGridLines(rawXLines, printedSize.width, canvas.width) : photographedX.length ? photographedX : regularGridLines(rawXLines, spacingX);
  const fittedSpacingX = xLines.length > 1 ? (xLines.at(-1)! - xLines[0]) / (xLines.length - 1) : undefined;
  let yLines = printedSize ? fitPrintedGridLines(rawYLines, printedSize.height, canvas.height, fittedSpacingX) : photographedY.length ? photographedY : regularGridLines(rawYLines, spacingY);
  if (printedPage?.totalBeads && file.type === "image/png") {
    const countOccupied = (candidateX: number[], candidateY: number[]) => {
      let count = 0;
      for (let row = 0; row < candidateY.length - 1; row += 1) for (let column = 0; column < candidateX.length - 1; column += 1) {
        const x1 = candidateX[column] / scale; const x2 = candidateX[column + 1] / scale; const y1 = candidateY[row] / scale; const y2 = candidateY[row + 1] / scale;
        const marginX = Math.max(2, Math.round((x2 - x1) * .28)); const marginY = Math.max(2, Math.round((y2 - y1) * .28)); const colors = new Map<number, WeightedRgb>(); let dark = 0; let sampled = 0;
        for (let y = Math.ceil(y1 + marginY); y < Math.floor(y2 - marginY); y += 2) for (let x = Math.ceil(x1 + marginX); x < Math.floor(x2 - marginX); x += 2) {
          const offset = (y * samplePixels.width + x) * 4; const red = samplePixels.data[offset]; const green = samplePixels.data[offset + 1]; const blue = samplePixels.data[offset + 2]; const key = (red >> 3) << 10 | (green >> 3) << 5 | (blue >> 3);
          const color = colors.get(key) ?? { red: 0, green: 0, blue: 0, count: 0 }; color.red += red; color.green += green; color.blue += blue; color.count += 1; colors.set(key, color); sampled += 1; if (Math.max(red, green, blue) < 130) dark += 1;
        }
        const dominant = [...colors.values()].sort((left, right) => right.count - left.count)[0] ?? { red: 255, green: 255, blue: 255, count: 1 };
        const background = [dominant.red / dominant.count, dominant.green / dominant.count, dominant.blue / dominant.count];
        if (!(Math.min(...background) > 245 && Math.max(...background) - Math.min(...background) < 8 && dark / Math.max(1, sampled) < .012)) count += 1;
      }
      return count;
    };
    if (countOccupied(xLines, yLines) !== printedPage.totalBeads) {
      const alternatives: Array<{ x: number[]; y: number[]; distance: number }> = [];
      for (let width = Math.max(4, printedPage.width - 2); width <= Math.min(128, printedPage.width + 2); width += 1) for (let height = Math.max(4, printedPage.height - 3); height <= Math.min(128, printedPage.height + 3); height += 1) {
        const candidateX = fitPrintedGridLines(rawXLines, width, canvas.width); const candidateSpacing = candidateX.length > 1 ? (candidateX.at(-1)! - candidateX[0]) / width : undefined;
        const candidateY = fitPrintedGridLines(rawYLines, height, canvas.height, candidateSpacing); if (candidateX.length !== width + 1 || candidateY.length !== height + 1) continue;
        if (countOccupied(candidateX, candidateY) === printedPage.totalBeads) alternatives.push({ x: candidateX, y: candidateY, distance: Math.abs(width - printedPage.width) + Math.abs(height - printedPage.height) });
      }
      const exact = alternatives.sort((left, right) => left.distance - right.distance)[0]; if (exact) { xLines = exact.x; yLines = exact.y; }
    }
  }
  const width = xLines.length - 1; const height = yLines.length - 1;
  if (width < 4 || height < 4 || width > 128 || height > 128) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("We could not detect a 4–128 cell grid. Use a clear, straight-on template with visible grid lines.");
  }

  // Detect the grid on a smaller canvas, but read cell fills from the untouched
  // source pixels. Scaling blends label ink and grid lines into the fill color.

  const bottomXLines = alignPerspectiveLines(xLines, photographedXBottom, canvas.width);
  const rightYLines = alignPerspectiveLines(yLines, photographedYRight, canvas.height);
  const perspectivePhoto = !printedSize && photographedX.length >= 5 && photographedY.length >= 5;
  type CellSample = { index: number; row: number; column: number; bounds: [number, number, number, number]; background: [number, number, number]; darkRatio: number; contrastRatio: number };
  type Occupied = Omit<CellSample, "row" | "column" | "darkRatio">;
  const samples: CellSample[] = [];
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const verticalProgress = ((yLines[row] + yLines[row + 1]) / 2) / canvas.height; const horizontalProgress = ((xLines[column] + xLines[column + 1]) / 2) / canvas.width;
    const lineX = (index: number) => perspectivePhoto ? xLines[index] * (1 - verticalProgress) + bottomXLines[index] * verticalProgress : xLines[index];
    const lineY = (index: number) => perspectivePhoto ? yLines[index] * (1 - horizontalProgress) + rightYLines[index] * horizontalProgress : yLines[index];
    const [x1, x2, y1, y2] = [lineX(column) / scale, lineX(column + 1) / scale, lineY(row) / scale, lineY(row + 1) / scale];
    // Sample only the center of each printed square. Thick 10 × 10 guide lines sit
    // close to cell edges and must never be mistaken for a dark bead label.
    const marginX = Math.max(2, Math.round((x2 - x1) * .28)); const marginY = Math.max(2, Math.round((y2 - y1) * .28));
    const colors = new Map<number, WeightedRgb>(); let dark = 0; let sampledPixels = 0;
    for (let y = Math.ceil(y1 + marginY); y < Math.floor(y2 - marginY); y += 1) for (let x = Math.ceil(x1 + marginX); x < Math.floor(x2 - marginX); x += 1) {
      const offset = (y * samplePixels.width + x) * 4; const red = samplePixels.data[offset]; const green = samplePixels.data[offset + 1]; const blue = samplePixels.data[offset + 2];
      const key = (red >> 3) << 10 | (green >> 3) << 5 | (blue >> 3); const color = colors.get(key) ?? { red: 0, green: 0, blue: 0, count: 0 };
      color.red += red; color.green += green; color.blue += blue; color.count += 1; colors.set(key, color); sampledPixels += 1;
      if (Math.max(red, green, blue) < 130) dark += 1;
    }
    const dominant = [...colors.values()].sort((left, right) => right.count - left.count)[0] ?? { red: 255, green: 255, blue: 255, count: 1 };
    const background: [number, number, number] = [dominant.red / dominant.count, dominant.green / dominant.count, dominant.blue / dominant.count];
    const contrasting = [...colors.values()].reduce((sum, color) => {
      const average = [color.red / color.count, color.green / color.count, color.blue / color.count];
      return sum + (average.reduce((distance, value, channel) => distance + (value - background[channel]) ** 2, 0) > 28 ** 2 * 3 ? color.count : 0);
    }, 0);
    samples.push({ index: row * width + column, row, column, bounds: [x1, x2, y1, y2], background, darkRatio: dark / Math.max(1, sampledPixels), contrastRatio: contrasting / Math.max(1, sampledPixels) });
  }
  const borderSamples = samples.filter((cell) => cell.row < 2 || cell.column < 2 || cell.row >= height - 2 || cell.column >= width - 2);
  const paperCandidates = [...borderSamples].sort((left, right) => {
    const lightness = (cell: CellSample) => cell.background[0] + cell.background[1] + cell.background[2] - (Math.max(...cell.background) - Math.min(...cell.background)) * 2;
    return lightness(right) - lightness(left);
  }).slice(0, Math.max(4, Math.ceil(borderSamples.length / 2)));
  const paper: [number, number, number] = [0, 1, 2].map((channel) => median(paperCandidates.map((cell) => cell.background[channel]))) as [number, number, number];
  const cleanDigitalExport = Math.min(...paper) > 245 && Math.max(...paper) - Math.min(...paper) < 8;
  const pixelBeadsExport = Boolean(printedPage?.words.some((word) => /^MARD\d/i.test(word.text.replace(/[^A-Z0-9]/gi, ""))));
  const occupied: Occupied[] = samples.filter((cell) => {
    if (cleanDigitalExport) return !(Math.min(...cell.background) > 245 && Math.max(...cell.background) - Math.min(...cell.background) < 8 && cell.darkRatio < .012);
    if (perspectivePhoto) return cell.darkRatio > .55 || cell.contrastRatio >= .018;
    const colorDistance = cell.background.reduce((sum, value, channel) => sum + (value - paper[channel]) ** 2, 0);
    return colorDistance > 26 ** 2 * 3 || cell.darkRatio >= .01;
  }).map(({ index, bounds, background, contrastRatio }) => ({ index, bounds, background, contrastRatio }));
  if (!occupied.length) { URL.revokeObjectURL(sourceUrl); throw new Error("We found grid lines but could not reliably locate the pattern. Make sure the full grid is visible and photographed straight on."); }
  if (printedPage?.totalBeads && occupied.length !== printedPage.totalBeads) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error(`This import was stopped because it did not exactly match the source. The source says ${printedPage.totalBeads.toLocaleString()} beads, but ${occupied.length.toLocaleString()} cells were detected.`);
  }

  const gridBottom = yLines.at(-1)! / scale;
  const legendCounts = new Map<string, number>();
  for (const word of printedPage?.words ?? []) {
    const code = word.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!paletteByCode.has(code) || word.top < gridBottom) continue;
    const centerY = word.top + word.height / 2;
    const countWord = printedPage!.words.filter((candidate) => {
      const digits = candidate.text.replace(/[^0-9]/g, ""); const candidateY = candidate.top + candidate.height / 2;
      return candidate.left > word.left + word.width && candidate.left - word.left < 600 && Math.abs(candidateY - centerY) <= Math.max(word.height, candidate.height) * 1.25 && digits.length > 0;
    }).sort((left, right) => left.left - right.left)[0];
    const count = Number(countWord?.text.replace(/[^0-9]/g, ""));
    if (Number.isInteger(count) && count > 0) legendCounts.set(code, count);
  }

  progress(`Reading ${occupied.length} printed bead labels locally…`);
  const recognized = new Map<number, string>(); const recognitionConfidence = new Map<number, number>(); const pageRecognitions: Array<{ index: number; code: string }> = []; const occupiedByCell = new Map(occupied.map((cell, index) => [cell.index, index]));
  const saveRecognition = (index: number, code: string, confidence: number) => { if (confidence > (recognitionConfidence.get(index) ?? -1)) { recognized.set(index, code); recognitionConfidence.set(index, confidence); } };
  for (const word of printedPage?.words ?? []) {
    const code = word.text.toUpperCase().replace(/[^A-Z0-9]/g, ""); if (word.confidence < 30 || !paletteByCode.has(code)) continue;
    const centerX = (word.left + word.width / 2) * scale; const centerY = (word.top + word.height / 2) * scale;
    const column = xLines.findIndex((line, index) => index < xLines.length - 1 && centerX >= line && centerX < xLines[index + 1]);
    const row = yLines.findIndex((line, index) => index < yLines.length - 1 && centerY >= line && centerY < yLines[index + 1]);
    const occupiedIndex = column >= 0 && row >= 0 ? occupiedByCell.get(row * width + column) : undefined;
    if (occupiedIndex !== undefined) { saveRecognition(occupiedIndex, code, word.confidence); pageRecognitions.push({ index: occupiedIndex, code }); }
  }
  const batchSize = perspectivePhoto ? 96 : 250; const columns = perspectivePhoto ? 8 : 10; const slotWidth = perspectivePhoto ? 150 : 120; const slotHeight = perspectivePhoto ? 140 : 90;
  for (let start = 0; start < occupied.length; start += batchSize) {
    const batch = occupied.slice(start, start + batchSize); const sheet = document.createElement("canvas"); sheet.width = columns * slotWidth; sheet.height = Math.ceil(batch.length / columns) * slotHeight;
    const sheetContext = sheet.getContext("2d", { willReadFrequently: true })!; sheetContext.fillStyle = "white"; sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    batch.forEach((cell, slot) => {
      const [x1, x2, y1, y2] = cell.bounds; const cropMargin = perspectivePhoto ? .22 : .1; const cropX = x1 + (x2 - x1) * cropMargin; const cropY = y1 + (y2 - y1) * cropMargin; const cropWidth = (x2 - x1) * (1 - cropMargin * 2); const cropHeight = (y2 - y1) * (1 - cropMargin * 2);
      const destWidth = perspectivePhoto ? 112 : 76; const destHeight = perspectivePhoto ? 112 : 76; const destX = slot % columns * slotWidth + (slotWidth - destWidth) / 2; const destY = Math.floor(slot / columns) * slotHeight + (slotHeight - destHeight) / 2;
      sheetContext.drawImage(image, cropX, cropY, cropWidth, cropHeight, destX, destY, destWidth, destHeight);
      const cellPixels = sheetContext.getImageData(destX, destY, destWidth, destHeight); const channels = [[], [], []] as [number[], number[], number[]];
      for (let index = 0; index < cellPixels.data.length; index += 4) { channels[0].push(cellPixels.data[index]); channels[1].push(cellPixels.data[index + 1]); channels[2].push(cellPixels.data[index + 2]); }
      const background = channels.map(median);
      for (let index = 0; index < cellPixels.data.length; index += 4) {
        const distance = Math.sqrt((cellPixels.data[index] - background[0]) ** 2 + (cellPixels.data[index + 1] - background[1]) ** 2 + (cellPixels.data[index + 2] - background[2]) ** 2);
        const value = distance > 45 ? 0 : 255; cellPixels.data[index] = value; cellPixels.data[index + 1] = value; cellPixels.data[index + 2] = value; cellPixels.data[index + 3] = 255;
      }
      sheetContext.putImageData(cellPixels, destX, destY);
    });
    const blob = await new Promise<Blob>((resolve, reject) => sheet.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare labels for reading.")), "image/png"));
    const body = new FormData(); body.append("image", blob, "labels.png");
    const { words } = await api<{ words: OcrWord[] }>("/api/ocr-template", { method: "POST", body });
    for (const word of words) {
      const slot = Math.floor((word.top + word.height / 2) / slotHeight) * columns + Math.floor((word.left + word.width / 2) / slotWidth);
      const code = paletteCodesFromText(word.text)[0] ?? "";
      // A valid code printed in a cell is the source of truth. The legend is useful for
      // color fallback, but a partial legend read must never reject a valid cell label.
      if (batch[slot] && word.confidence >= 30 && paletteByCode.has(code)) saveRecognition(start + slot, code, word.confidence);
    }
    progress(`Read labels ${Math.min(start + batch.length, occupied.length)} of ${occupied.length}…`);
  }

  // Group cells by their fill as printed in this document. Codes are chosen by a vote
  // of the labels read from that group, so one OCR typo cannot recolor an isolated cell.
  type FillCluster = WeightedRgb & { members: number[] };
  const clusters: FillCluster[] = [];
  const clusterTolerance = cleanDigitalExport ? 10 : perspectivePhoto ? 24 : 16;
  occupied.forEach((cell, index) => {
    const match = clusters.reduce<{ cluster: FillCluster | null; distance: number }>((best, cluster) => {
      const red = cluster.red / cluster.count; const green = cluster.green / cluster.count; const blue = cluster.blue / cluster.count;
      const distance = (cell.background[0] - red) ** 2 + (cell.background[1] - green) ** 2 + (cell.background[2] - blue) ** 2;
      return distance < best.distance ? { cluster, distance } : best;
    }, { cluster: null, distance: Infinity });
    const cluster = match.cluster && match.distance <= clusterTolerance ** 2 * 3 ? match.cluster : { red: 0, green: 0, blue: 0, count: 0, members: [] };
    if (!match.cluster || match.distance > clusterTolerance ** 2 * 3) clusters.push(cluster);
    cluster.red += cell.background[0]; cluster.green += cell.background[1]; cluster.blue += cell.background[2]; cluster.count += 1; cluster.members.push(index);
  });
  const clusterVotes = clusters.map(() => new Map<string, number>());
  const verifiedPhotoClusters = new Set<number>();
  // Images exported by this app contain the palette's exact RGB fills. Preserve
  // those codes directly; tiny printed labels can otherwise turn A25 into A2.
  if (cleanDigitalExport) clusters.forEach((cluster, clusterIndex) => {
    const red = cluster.red / cluster.count; const green = cluster.green / cluster.count; const blue = cluster.blue / cluster.count;
    const code = nearestColor(red, green, blue); const color = paletteByCode.get(code);
    if (!color || color.transparent) return;
    const hex = color.hex.slice(1); const paletteRed = parseInt(hex.slice(0, 2), 16); const paletteGreen = parseInt(hex.slice(2, 4), 16); const paletteBlue = parseInt(hex.slice(4, 6), 16);
    const distance = (red - paletteRed) ** 2 + (green - paletteGreen) ** 2 + (blue - paletteBlue) ** 2;
    // App exports use this app's exact palette RGB and need the direct match for
    // very small labels. Pixel Beads exports use a different color chart, so their
    // printed codes and material legend must override a visually similar swatch.
    if (distance <= 6 ** 2 * 3) clusterVotes[clusterIndex].set(code, pixelBeadsExport ? 1 : 2000);
  });
  clusters.forEach((cluster, clusterIndex) => legendCounts.forEach((count, code) => {
    if (cluster.members.length === count) clusterVotes[clusterIndex].set(code, 1000);
  }));
  clusters.forEach((cluster, clusterIndex) => cluster.members.forEach((index) => { const code = recognized.get(index); if (code) { clusterVotes[clusterIndex].set(code, (clusterVotes[clusterIndex].get(code) ?? 0) + 1); if (perspectivePhoto) verifiedPhotoClusters.add(clusterIndex); } }));
  const clusterByMember = new Map<number, number>(); clusters.forEach((cluster, clusterIndex) => cluster.members.forEach((member) => clusterByMember.set(member, clusterIndex)));
  pageRecognitions.forEach(({ index, code }) => { const clusterIndex = clusterByMember.get(index); if (clusterIndex !== undefined) clusterVotes[clusterIndex].set(code, (clusterVotes[clusterIndex].get(code) ?? 0) + 2); });

  // Give every fill group a few large, isolated label samples. This recovers colors
  // whose tiny labels were missed in the general pass, especially white-on-dark codes.
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex];
    // Camera focus and perspective are strongest near the middle of the photo. Read
    // several central examples instead of the first/last cells at the soft edges.
    const picks = perspectivePhoto ? [...cluster.members].sort((left, right) => {
      const center = (index: number) => { const [x1, x2, y1, y2] = occupied[index].bounds; return ((x1 + x2) / 2 - image.naturalWidth / 2) ** 2 + ((y1 + y2) / 2 - image.naturalHeight / 2) ** 2; };
      return center(left) - center(right);
    }).slice(0, 8) : [...new Set([cluster.members[0], cluster.members[Math.floor(cluster.members.length / 2)], cluster.members.at(-1)!])];
    const sampleWidth = 500; const sampleHeight = 500; const labelSize = 304;
    for (const cellIndex of picks) {
      const sheet = document.createElement("canvas"); sheet.width = sampleWidth; sheet.height = sampleHeight;
      const sheetContext = sheet.getContext("2d")!; sheetContext.fillStyle = "white"; sheetContext.fillRect(0, 0, sheet.width, sheet.height);
      const [x1, x2, y1, y2] = occupied[cellIndex].bounds;
      for (const cropMargin of perspectivePhoto ? [.12, .2, .28] : [.1]) {
        sheetContext.fillStyle = "white"; sheetContext.fillRect(0, 0, sheet.width, sheet.height);
        const cropX = x1 + (x2 - x1) * cropMargin; const cropY = y1 + (y2 - y1) * cropMargin;
        sheetContext.imageSmoothingEnabled = false;
        sheetContext.drawImage(image, cropX, cropY, (x2 - x1) * (1 - cropMargin * 2), (y2 - y1) * (1 - cropMargin * 2), 98, 98, labelSize, labelSize);
        const blob = await new Promise<Blob>((resolve, reject) => sheet.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare color labels.")), "image/png"));
        const body = new FormData(); body.append("image", blob, "color-label.png");
        const { text } = await api<{ text: string }>("/api/ocr-template?mode=line", { method: "POST", body });
        for (const code of paletteCodesFromText(text)) { clusterVotes[clusterIndex].set(code, (clusterVotes[clusterIndex].get(code) ?? 0) + 5); if (perspectivePhoto) verifiedPhotoClusters.add(clusterIndex); }
      }
      if (perspectivePhoto) {
        const segmented = await recognizeSegmentedCode(image, occupied[cellIndex].bounds);
        if (segmented) { clusterVotes[clusterIndex].set(segmented, (clusterVotes[clusterIndex].get(segmented) ?? 0) + 80); verifiedPhotoClusters.add(clusterIndex); }
      }
    }
    // Some pale fills have so little contrast that Tesseract drops the label entirely.
    // For those groups only, compare the isolated printed glyph against our code list.
    // Restricting this fallback to groups without OCR evidence keeps a weak shape match
    // from overriding a label that the document actually supplied.
    if (!clusterVotes[clusterIndex].size) {
      const glyphVotes = new Map<string, number>();
      for (const cellIndex of picks) {
        const code = recognizePrintedGlyph(image, occupied[cellIndex].bounds);
        if (code) glyphVotes.set(code, (glyphVotes.get(code) ?? 0) + 1);
      }
      const code = [...glyphVotes].sort((left, right) => right[1] - left[1])[0]?.[0];
      if (code) clusterVotes[clusterIndex].set(code, 8);
    }
    progress(`Confirmed color labels ${clusterIndex + 1} of ${clusters.length}…`);
  }
  if (perspectivePhoto && verifiedPhotoClusters.size !== clusters.length) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("Template uploaded is unclear and some color labels are difficult to recognize. Please either switch to a higher resolution image or draw this template manually.");
  }
  // Pixel Beads exports repeat each code in a large swatch below the grid. When that
  // legend is present, its label is the clearest and most authoritative OCR sample.
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
    const cluster = clusters[clusterIndex]; const target = [cluster.red / cluster.count, cluster.green / cluster.count, cluster.blue / cluster.count];
    const matches = (x: number, y: number) => { const offset = (y * pixels.width + x) * 4; return (pixels.data[offset] - target[0]) ** 2 + (pixels.data[offset + 1] - target[1]) ** 2 + (pixels.data[offset + 2] - target[2]) ** 2 <= 10 ** 2 * 3; };
    let bestRun: { x: number; y: number; length: number } | null = null;
    for (let y = Math.min(pixels.height - 1, yLines.at(-1)! + 8); y < pixels.height; y += 2) {
      let x = 0;
      while (x < pixels.width) {
        if (!matches(x, y)) { x += 1; continue; }
        const start = x; while (x < pixels.width && matches(x, y)) x += 1; const length = x - start;
        if (length >= Math.max(14, spacingX * 1.4) && length < pixels.width * .24 && (!bestRun || length > bestRun.length)) bestRun = { x: start, y, length };
      }
    }
    if (!bestRun) continue;
    const coverage = (y: number) => { let count = 0; for (let x = bestRun!.x; x < bestRun!.x + bestRun!.length; x += 1) if (matches(x, y)) count += 1; return count / bestRun!.length; };
    let top = bestRun.y; let bottom = bestRun.y;
    while (top > yLines.at(-1)! && coverage(top - 1) > .45) top -= 1;
    while (bottom < pixels.height - 1 && coverage(bottom + 1) > .45) bottom += 1;
    if (bottom - top < 4) continue;
    const cropX = bestRun.x / scale; const cropY = top / scale; const cropWidth = bestRun.length / scale; const cropHeight = (bottom - top + 1) / scale;
    const sheet = document.createElement("canvas"); sheet.width = 600; sheet.height = 400;
    const sheetContext = sheet.getContext("2d")!; sheetContext.fillStyle = "white"; sheetContext.fillRect(0, 0, sheet.width, sheet.height); sheetContext.imageSmoothingEnabled = false;
    const destinationWidth = 420; const destinationHeight = Math.min(260, Math.max(120, destinationWidth * cropHeight / cropWidth));
    sheetContext.drawImage(image, cropX, cropY, cropWidth, cropHeight, 90, (sheet.height - destinationHeight) / 2, destinationWidth, destinationHeight);
    const blob = await new Promise<Blob>((resolve, reject) => sheet.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare legend label.")), "image/png"));
    const body = new FormData(); body.append("image", blob, "legend-label.png");
    const { text } = await api<{ text: string }>("/api/ocr-template?mode=line", { method: "POST", body });
    const code = (text.toUpperCase().match(/[A-Z]\d{1,2}/g) ?? []).find((value) => paletteByCode.has(value));
    if (code) clusterVotes[clusterIndex].set(code, (clusterVotes[clusterIndex].get(code) ?? 0) + 100);
  }
  // A printed palette assigns one code to one fill. OCR can occasionally read the
  // neighboring legend label for two similar fills, so assign the strongest group
  // first and let the other group use its next supported label.
  const rankedVotes = clusterVotes.map((votes) => [...votes].sort((left, right) => right[1] - left[1]));
  const assignmentOrder = clusters.map((_, index) => index).sort((left, right) => {
    const leftTop = rankedVotes[left][0]?.[1] ?? 0; const rightTop = rankedVotes[right][0]?.[1] ?? 0;
    const leftMargin = leftTop - (rankedVotes[left][1]?.[1] ?? 0); const rightMargin = rightTop - (rankedVotes[right][1]?.[1] ?? 0);
    return rightTop - leftTop || rightMargin - leftMargin;
  });
  const usedCodes = new Set<string>(); const clusterCodes = Array<string>(clusters.length);
  for (const index of assignmentOrder) {
    const supported = perspectivePhoto ? rankedVotes[index][0]?.[0] : rankedVotes[index].find(([code]) => !usedCodes.has(code))?.[0];
    const cluster = clusters[index];
    const nearestUnused = perspectivePhoto ? nearestColor(cluster.red / cluster.count, cluster.green / cluster.count, cluster.blue / cluster.count) : nearestColor(cluster.red / cluster.count, cluster.green / cluster.count, cluster.blue / cluster.count, new Set(PALETTE.map((color) => color.code).filter((code) => !usedCodes.has(code))));
    const code = supported ?? nearestUnused;
    clusterCodes[index] = code; usedCodes.add(code);
  }
  const cells: Array<string | null> = Array(width * height).fill(null);
  clusters.forEach((cluster, clusterIndex) => cluster.members.forEach((index) => { cells[occupied[index].index] = clusterCodes[clusterIndex]; }));
  if (legendCounts.size) {
    const legendTotal = [...legendCounts.values()].reduce((sum, count) => sum + count, 0); const importedCounts = countBeads(cells);
    if ((!printedPage?.totalBeads || legendTotal === printedPage.totalBeads) && [...legendCounts].some(([code, count]) => importedCounts[code] !== count)) {
      URL.revokeObjectURL(sourceUrl);
      throw new Error("This import was stopped because its color totals did not exactly match the source legend.");
    }
  }
  return { sourceUrl, width, height, cells, labelsRead: recognized.size, occupied: occupied.length };
}

function BeadGrid({ draft, onPaint, compact = false, dragEnabled = true, zoom = 100, showEmptyMark = true, majorGrid = false, selectedIndices, selectionMode = false, onSelectRange }: { draft: Draft; onPaint?: (indices: number[]) => void; compact?: boolean; dragEnabled?: boolean; zoom?: number; showEmptyMark?: boolean; majorGrid?: boolean; selectedIndices?: Set<number>; selectionMode?: boolean; onSelectRange?: (indices: number[], baseSelection: Set<number>) => void }) {
  const gesture = useRef<{ pointerId: number; pointerType: string; startIndex: number; lastIndex: number; x: number; y: number; drawing: boolean; scrolling: boolean; baseSelection: Set<number>; holdTimer?: number; scrollTarget: HTMLElement | null; scrollLeft: number; scrollTop: number; pageX: number; pageY: number } | null>(null);
  const activeTouches = useRef(new Set<number>());
  const [touchDrawing, setTouchDrawing] = useState(false);
  const cellSize = compact ? 5 : Math.max(majorGrid ? 1 : 6, Math.round(22 * zoom / 100));
  const cancelHold = (current: typeof gesture.current) => {
    if (current?.holdTimer !== undefined) window.clearTimeout(current.holdTimer);
  };
  useEffect(() => () => cancelHold(gesture.current), []);
  const cellFromPoint = (x: number, y: number, grid: HTMLDivElement) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cell-index]");
    return target && grid.contains(target) ? Number(target.dataset.cellIndex) : null;
  };
  const finishGesture = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (event.pointerType === "touch") activeTouches.current.delete(event.pointerId);
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    cancelHold(current);
    if (!cancelled && !current.drawing && !current.scrolling && (current.pointerType !== "touch" || !dragEnabled)) onPaint?.([current.startIndex]);
    setTouchDrawing(false);
    gesture.current = null;
  };
  return <div className={`bead-grid ${onPaint ? "editable" : ""} ${dragEnabled && onPaint ? "continuous-draw" : ""} ${selectionMode ? "selection-mode" : ""} ${touchDrawing ? "touch-drawing" : ""} ${compact ? "compact-grid" : ""} ${majorGrid && cellSize < 12 ? "fine-grid" : ""}`} style={{ gridTemplateColumns: `repeat(${draft.width}, ${cellSize}px)` }} onPointerDown={(event) => {
    if (!onPaint || event.button !== 0) return;
    const index = cellFromPoint(event.clientX, event.clientY, event.currentTarget); if (index === null) return;
    if (event.pointerType === "touch") {
      activeTouches.current.add(event.pointerId);
      if (activeTouches.current.size > 1) { cancelHold(gesture.current); gesture.current = null; setTouchDrawing(false); return; }
    }
    const scrollTarget = event.currentTarget.closest<HTMLElement>(".grid-scroll");
    gesture.current = { pointerId: event.pointerId, pointerType: event.pointerType, startIndex: index, lastIndex: index, x: event.clientX, y: event.clientY, drawing: !selectionMode && event.pointerType !== "touch", scrolling: false, baseSelection: new Set(selectedIndices), scrollTarget, scrollLeft: scrollTarget?.scrollLeft ?? 0, scrollTop: scrollTarget?.scrollTop ?? 0, pageX: window.scrollX, pageY: window.scrollY };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch" && dragEnabled) {
      const pointerId = event.pointerId;
      gesture.current.holdTimer = window.setTimeout(() => {
        const current = gesture.current;
        if (!current || current.pointerId !== pointerId || current.scrolling || activeTouches.current.size > 1) return;
        current.drawing = true;
        setTouchDrawing(true);
        onPaint([current.startIndex]);
      }, 240);
    } else if (!selectionMode && event.pointerType !== "touch") onPaint([index]);
  }} onPointerMove={(event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !dragEnabled || !onPaint || activeTouches.current.size > 1) return;
    if (current.pointerType === "touch" && !current.drawing) {
      const horizontalDistance = event.clientX - current.x;
      const verticalDistance = event.clientY - current.y;
      if (!current.scrolling && Math.hypot(horizontalDistance, verticalDistance) < 8) return;
      if (!current.scrolling) { current.scrolling = true; cancelHold(current); }
      const target = current.scrollTarget;
      const scrollHorizontally = Boolean(target && target.scrollWidth > target.clientWidth + 1);
      const scrollVertically = Boolean(target && target.scrollHeight > target.clientHeight + 1);
      if (target && scrollHorizontally) target.scrollLeft = current.scrollLeft - horizontalDistance;
      if (target && scrollVertically) target.scrollTop = current.scrollTop - verticalDistance;
      if (!scrollHorizontally || !scrollVertically) window.scrollTo(!scrollHorizontally ? current.pageX - horizontalDistance : window.scrollX, !scrollVertically ? current.pageY - verticalDistance : window.scrollY);
      return;
    }
    const index = cellFromPoint(event.clientX, event.clientY, event.currentTarget); if (index === null) return;
    if (selectionMode) {
      if (!current.drawing && index === current.startIndex && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
      current.drawing = true; current.lastIndex = index;
      onSelectRange?.(rectangleCellIndices(current.startIndex, index, draft.width), current.baseSelection);
      return;
    }
    if (index === current.lastIndex) return;
    const indices = lineCellIndices(current.lastIndex, index, draft.width).slice(1);
    if (indices.length) onPaint(indices);
    current.lastIndex = index;
  }} onPointerUp={(event) => finishGesture(event)} onPointerCancel={(event) => finishGesture(event, true)}>
    {draft.cells.map((code, index) => {
      const color = code ? paletteByCode.get(code) : undefined;
      return <button key={index} type="button" data-cell-index={index} aria-label={`Cell ${index + 1}: ${color?.name ?? "empty"}`} title={`${index % draft.width + 1}, ${Math.floor(index / draft.width) + 1}: ${color?.name ?? "empty"}`} disabled={!onPaint}
        className={`bead-cell ${selectedIndices?.has(index) ? "selected-for-move" : ""} ${color?.transparent ? "transparent-bead" : ""} ${majorGrid && (index % draft.width + 1) % 10 === 0 ? "major-column" : ""} ${majorGrid && (Math.floor(index / draft.width) + 1) % 10 === 0 ? "major-row" : ""}`} style={{ width: cellSize, height: cellSize, fontSize: compact || (majorGrid && cellSize < 7) ? 0 : Math.max(5, Math.round(7 * zoom / 100)), background: color?.transparent ? undefined : color?.hex ?? "transparent", color: color ? labelColor(color.hex) : "#6e645d" }}>{code ?? (showEmptyMark ? "×" : "")}</button>;
    })}
  </div>;
}

function TemplateThumbnail({ template }: { template: Template }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const filled = template.cells.flatMap((code, index) => code ? [index] : []);
    const columns = filled.map((index) => index % template.width);
    const rows = filled.map((index) => Math.floor(index / template.width));
    const left = filled.length ? Math.max(0, Math.min(...columns) - 2) : 0;
    const top = filled.length ? Math.max(0, Math.min(...rows) - 2) : 0;
    const right = filled.length ? Math.min(template.width - 1, Math.max(...columns) + 2) : template.width - 1;
    const bottom = filled.length ? Math.min(template.height - 1, Math.max(...rows) + 2) : template.height - 1;
    canvas.width = right - left + 1; canvas.height = bottom - top + 1;
    const context = canvas.getContext("2d"); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    template.cells.forEach((code, index) => {
      if (!code) return;
      const color = paletteByCode.get(code);
      context.fillStyle = color?.transparent ? "#d8d8d8" : color?.hex ?? "#fffdf8";
      context.fillRect(index % template.width - left, Math.floor(index / template.width) - top, 1, 1);
    });
  }, [template]);
  return <canvas ref={canvasRef} role="img" aria-label={`Bead template for ${template.title}`} />;
}

async function exportTemplateImage(template: Template): Promise<void> {
  const cellSize = 28; const margin = 36; const header = 94; const legendTop = 62;
  const usage = countBeads(template.cells);
  const colors = Object.entries(usage).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
  const columns = Math.max(1, Math.min(5, Math.floor((template.width * cellSize + margin * 2) / 150)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(760, template.width * cellSize + margin * 2);
  canvas.height = header + template.height * cellSize + legendTop + Math.ceil(colors.length / columns) * 38 + margin;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Could not create template image.");
  const gridLeft = Math.floor((canvas.width - template.width * cellSize) / 2);
  context.fillStyle = "#fffdf8"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#342f2b"; context.font = "bold 30px Georgia, serif";
  context.fillText(template.title, margin, 47, canvas.width - margin * 2);
  context.font = "15px Arial, sans-serif";
  context.fillText(`${template.width} × ${template.height} beads · ${Object.values(usage).reduce((sum, value) => sum + value, 0)} beads total`, margin, 75);
  template.cells.forEach((code, index) => {
    const x = gridLeft + index % template.width * cellSize;
    const y = header + Math.floor(index / template.width) * cellSize;
    const color = code ? paletteByCode.get(code) : undefined;
    context.fillStyle = color?.transparent ? "#e5e1dc" : color?.hex ?? "#fffdf8";
    context.fillRect(x, y, cellSize, cellSize);
    context.strokeStyle = "#c4b9ad"; context.lineWidth = 0.7; context.strokeRect(x + .35, y + .35, cellSize - .7, cellSize - .7);
    if (code) {
      context.fillStyle = labelColor(color?.hex ?? "#fffdf8");
      context.font = "bold 10px Arial, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(code, x + cellSize / 2, y + cellSize / 2);
    }
  });
  context.textAlign = "left"; context.textBaseline = "alphabetic";
  const legendY = header + template.height * cellSize + 35;
  context.fillStyle = "#342f2b"; context.font = "bold 18px Arial, sans-serif"; context.fillText("Colors used", margin, legendY);
  colors.forEach(([code, count], index) => {
    const color = paletteByCode.get(code);
    const x = margin + index % columns * 150; const y = legendY + 24 + Math.floor(index / columns) * 38;
    context.fillStyle = color?.hex ?? "#fffdf8"; context.fillRect(x, y, 24, 24);
    context.strokeStyle = "#bcb3aa"; context.strokeRect(x + .5, y + .5, 23, 23);
    context.fillStyle = "#342f2b"; context.font = "bold 13px Arial, sans-serif"; context.fillText(code, x + 32, y + 17);
    context.font = "13px Arial, sans-serif"; context.fillText(`× ${count}`, x + 72, y + 17);
  });
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not export template image.")), "image/png"));
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${template.title.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 70) || "bead-template"}.png`;
  document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ArtworkTile({ template, artwork, onView, onEdit, onComplete, onExport, onRemove }: {
  template: Template; artwork?: Artwork; onView: () => void; onEdit: () => void; onComplete: () => void; onExport: () => void; onRemove?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showArtwork, setShowArtwork] = useState(Boolean(artwork));
  useEffect(() => setShowArtwork(Boolean(artwork)), [artwork?.id]);
  const usage = countBeads(template.cells); const beadCount = Object.values(usage).reduce((sum, count) => sum + count, 0);
  const board = RESOLUTIONS.find((option) => option.width && option.height && template.width <= option.width && template.height <= option.height);
  const boardLabel = board ? `${board.width} × ${board.height} (${board.label})` : `${template.width} × ${template.height} (Custom)`;
  const runMenuAction = (action: () => void) => { setMenuOpen(false); action(); };
  return <article className="artwork-tile">
    <div className="artwork-tile-image"><button type="button" className="artwork-image-main" aria-label={`Open ${template.title} making view`} onClick={onView}>{artwork && showArtwork ? <img src={artwork.photoUrl} alt={`Completed artwork for ${template.title}`} /> : <TemplateThumbnail template={template} />}<span>Open template</span></button>{artwork && <><button type="button" className="artwork-image-arrow previous" aria-label={`Show template image for ${template.title}`} disabled={!showArtwork} onClick={() => setShowArtwork(false)}>‹</button><button type="button" className="artwork-image-arrow next" aria-label={`Show completed photo for ${template.title}`} disabled={showArtwork} onClick={() => setShowArtwork(true)}>›</button></>}</div>
    <div className="artwork-tile-content">
      <div className="artwork-title-row"><h3>{template.title}</h3><button type="button" className="artwork-menu-trigger" aria-label={`More options for ${template.title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>⋮</button>{menuOpen && <div className="artwork-menu" role="menu"><button type="button" role="menuitem" onClick={() => runMenuAction(onEdit)}>Edit template</button><button type="button" role="menuitem" onClick={() => runMenuAction(onComplete)}>Add completed artwork</button><button type="button" role="menuitem" onClick={() => runMenuAction(onExport)}>Export PNG</button>{onRemove && <button type="button" role="menuitem" className="danger" onClick={() => runMenuAction(onRemove)}>Remove</button>}</div>}</div>
      <p>{boardLabel} · {beadCount} beads · {Object.keys(usage).length} colors</p>
      {artwork?.caption && <p className="artwork-caption">{artwork.caption}</p>}
    </div>
  </article>;
}

function MakingView({ template, onClose }: { template: Template; onClose: () => void }) {
  const [zoom, setZoom] = useState(100); const [fitMode, setFitMode] = useState(true); const [wakeState, setWakeState] = useState<"active" | "unavailable" | "requesting">("requesting");
  const viewportRef = useRef<HTMLDivElement>(null); const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const usage = countBeads(template.cells); const usedColors = PALETTE.filter((color) => usage[color.code]);
  const fitPattern = () => {
    const viewport = viewportRef.current; if (!viewport) return;
    const width = Math.floor((viewport.clientWidth - 56 - template.width - 1) / template.width);
    const height = Math.floor((viewport.clientHeight - 56 - template.height - 1) / template.height);
    const cellSize = Math.max(1, Math.min(width, height));
    setZoom(Math.min(300, Math.max(5, Math.floor(cellSize * 100 / 22))));
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  };
  useEffect(() => {
    if (!fitMode || !viewportRef.current) return;
    const observer = new ResizeObserver(fitPattern); observer.observe(viewportRef.current); fitPattern();
    return () => observer.disconnect();
  }, [fitMode, template.width, template.height]);
  useEffect(() => {
    type WakeSentinel = { released: boolean; release: () => Promise<void> };
    const wakeApi = (navigator as Navigator & { wakeLock?: { request: (kind: "screen") => Promise<WakeSentinel> } }).wakeLock;
    let sentinel: WakeSentinel | null = null; let disposed = false;
    const acquire = async () => {
      if (!wakeApi || document.visibilityState !== "visible") { if (!wakeApi) setWakeState("unavailable"); return; }
      try { sentinel = await wakeApi.request("screen"); if (!disposed) setWakeState("active"); }
      catch { if (!disposed) setWakeState("unavailable"); }
    };
    const handleVisibility = () => { if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) void acquire(); };
    void acquire(); document.addEventListener("visibilitychange", handleVisibility);
    return () => { disposed = true; document.removeEventListener("visibilitychange", handleVisibility); void sentinel?.release(); };
  }, []);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", closeOnEscape); return () => window.removeEventListener("keydown", closeOnEscape); }, [onClose]);
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !viewportRef.current) return; const viewport = viewportRef.current;
    drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId);
  };
  const pan = (event: PointerEvent<HTMLDivElement>) => { if (!drag.current || !viewportRef.current) return; viewportRef.current.scrollLeft = drag.current.left - (event.clientX - drag.current.x); viewportRef.current.scrollTop = drag.current.top - (event.clientY - drag.current.y); };
  return <div className="making-view-backdrop"><section className="making-view" role="dialog" aria-modal="true" aria-label={`${template.title} making view`}>
    <header><div><p className="eyebrow">Creation mode</p><h2>{template.title}</h2><p>{template.width} × {template.height} · {Object.values(usage).reduce((sum, count) => sum + count, 0).toLocaleString()} beads</p></div><div className="making-header-actions"><span className={`wake-status ${wakeState}`}>{wakeState === "active" ? "● Screen stays awake" : wakeState === "requesting" ? "○ Keeping screen awake…" : "○ Keep device awake manually"}</span><button type="button" aria-label="Close making view" onClick={onClose}>×</button></div></header>
    <div className="making-toolbar"><span>Drag to move around the pattern · dark lines mark 10 × 10 blocks</span><div className="zoom-controls" aria-label="Making view zoom controls"><button type="button" onClick={() => { setFitMode(false); setZoom((value) => Math.max(5, value - 25)); }} disabled={zoom === 5} aria-label="Zoom out">−</button><input type="range" min="5" max="300" step="1" value={zoom} onChange={(event) => { setFitMode(false); setZoom(Number(event.target.value)); }} aria-label="Zoom level" /><span>{zoom}%</span><button type="button" onClick={() => { setFitMode(false); setZoom((value) => Math.min(300, value + 25)); }} disabled={zoom === 300} aria-label="Zoom in">+</button><button type="button" className="fit-button" onClick={() => { setFitMode(true); fitPattern(); }}>Fit</button></div></div>
    <div className="making-layout"><div ref={viewportRef} className={`making-viewport ${drag.current ? "dragging" : ""}`} onPointerDown={beginPan} onPointerMove={pan} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><div className="making-board"><BeadGrid draft={{ ...template }} zoom={zoom} showEmptyMark={false} majorGrid /></div></div><aside className="making-legend"><div><strong>Colors used</strong><span>{usedColors.length}</span></div>{usedColors.map((color) => <div className="making-color" key={color.code}><i className={color.transparent ? "transparent-swatch" : ""} style={{ background: color.transparent ? undefined : color.hex }} /><b>{color.code}</b><span>{usage[color.code].toLocaleString()}</span></div>)}</aside></div>
  </section></div>;
}

function ToolIcon({ tool }: { tool: EditorTool }) {
  if (tool === "brush") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 4.5 5 5-8.8 8.8-5.7 1.2 1.2-5.7 8.3-9.3Z" /><path d="m12.5 6.7 4.8 4.8M5 19.5c-1.2 0-2-.8-2-2 0-1.4 1.1-2.5 2.5-2.5" /></svg>;
  if (tool === "bucket") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 7-7 8 8-7 7H4l-1-1 1-7Z" /><path d="m7 8 8 8M4 19h8M19 16s2 2.1 2 3.4A2 2 0 0 1 17 19.4C17 18.1 19 16 19 16Z" /></svg>;
  if (tool === "eraser") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5-5 8 6 6h7l5-8-6-6H8Z" /><path d="m8 19 8-9M12 8l6 6" /></svg>;
  if (tool === "eyedropper") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 3 7 7-9.5 9.5a3.5 3.5 0 0 1-5-5L16 5" /><path d="m12 7 5 5M4 21h8" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" /></svg>;
}

function InventoryActionIcon({ action }: { action: "refill" | "use" | "history" | "status" }) {
  if (action === "refill") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h10M8 5v3L6.5 10v10h11V10L16 8V5" /><path d="M12 11v6M9 14h6" /></svg>;
  if (action === "use") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h4a5 5 0 0 0 5-5c0-2.8-4-5-9-5Z" /><circle cx="7.5" cy="9" r=".8" /><circle cx="10.5" cy="6.5" r=".8" /><circle cx="14" cy="6.5" r=".8" /></svg>;
  if (action === "history") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8V4m0 0h4M5 4l3 3a8 8 0 1 1-2 8" /><path d="M12 8v5l3 2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9M12 19V5M19 19v-7" /><path d="M3 19h18" /></svg>;
}

function TemplateEditor({ draft, setDraft, onSave, onCancel, busy }: { draft: Draft; setDraft: (draft: Draft) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const [selected, setSelected] = useState(PALETTE[0].code);
  const [tool, setTool] = useState<EditorTool>("brush");
  const [zoom, setZoom] = useState(100);
  const [colorOpen, setColorOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [colorSeries, setColorSeries] = useState(PALETTE[0].code[0]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [history, setHistory] = useState<Draft[]>([]);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeWidthInput, setResizeWidthInput] = useState(String(draft.width));
  const [resizeHeightInput, setResizeHeightInput] = useState(String(draft.height));
  const [moveSelecting, setMoveSelecting] = useState(false);
  const [moveSelection, setMoveSelection] = useState<Set<number>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [horizontalDirection, setHorizontalDirection] = useState<"left" | "right">("right");
  const [horizontalDistanceInput, setHorizontalDistanceInput] = useState("0");
  const [verticalDirection, setVerticalDirection] = useState<"up" | "down">("down");
  const [verticalDistanceInput, setVerticalDistanceInput] = useState("0");
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const pinchPointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; zoom: number; centerX: number; centerY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const counts = useMemo(() => countBeads(draft.cells), [draft.cells]);
  const smallDraft = useMemo(() => draft.width === 26 && draft.height === 26 ? null : fitArtworkToSmall(draft), [draft]);
  const resizeWidth = Number(resizeWidthInput); const resizeHeight = Number(resizeHeightInput);
  const resizeInputsValid = Number.isInteger(resizeWidth) && resizeWidth >= 4 && resizeWidth <= 128 && Number.isInteger(resizeHeight) && resizeHeight >= 4 && resizeHeight <= 128;
  const resizeResult = useMemo(() => resizeInputsValid ? resizeDraft(draft, resizeWidth, resizeHeight) : { draft: null, cropped: 0 }, [draft, resizeWidth, resizeHeight, resizeInputsValid]);
  const horizontalDistance = Number(horizontalDistanceInput); const verticalDistance = Number(verticalDistanceInput);
  const moveInputsValid = Number.isInteger(horizontalDistance) && horizontalDistance >= 0 && horizontalDistance < draft.width && Number.isInteger(verticalDistance) && verticalDistance >= 0 && verticalDistance < draft.height;
  const moveColumns = (horizontalDirection === "left" ? -1 : 1) * (moveInputsValid ? horizontalDistance : 0);
  const moveRows = (verticalDirection === "up" ? -1 : 1) * (moveInputsValid ? verticalDistance : 0);
  const moveResult = useMemo(() => moveInputsValid ? moveSelectedDraft(draft, moveSelection, moveColumns, moveRows) : { draft: null, cropped: 0, blocked: 0 }, [draft, moveSelection, moveColumns, moveRows, moveInputsValid]);
  const visibleColors = PALETTE.filter((color) => color.code.startsWith(colorSeries) && (color.code.toLowerCase().includes(paletteSearch.toLowerCase()) || color.name.toLowerCase().includes(paletteSearch.toLowerCase())));
  const usedColors = PALETTE.filter((color) => counts[color.code]);
  const commitDraft = (next: Draft) => { setHistory((current) => [...current.slice(-49), draft]); setDraft(next); };
  const undo = () => setHistory((current) => {
    const previous = current.at(-1); if (!previous) return current;
    setDraft(previous); return current.slice(0, -1);
  });
  const applyTool = (indices: number[]) => {
    const index = indices[0]; if (index === undefined) return;
    const current = draft.cells[index];
    if (tool === "eyedropper") { if (current) { setSelected(current); setColorSeries(current[0]); setTool("brush"); } return; }
    if (tool === "replace") {
      if (!current || current === selected) return;
      commitDraft({ ...draft, cells: draft.cells.map((code) => code === current ? selected : code) });
      return;
    }
    const replacement = tool === "eraser" ? null : selected;
    const cells = [...draft.cells];
    if (tool === "bucket" && current === replacement) return;
    if (tool !== "bucket") {
      let changed = false;
      for (const next of indices) if (cells[next] !== replacement) { cells[next] = replacement; changed = true; }
      if (!changed) return;
    }
    else {
      const queue = [index]; const visited = new Set<number>();
      while (queue.length) {
        const next = queue.pop()!; if (visited.has(next) || cells[next] !== current) continue;
        visited.add(next); cells[next] = replacement;
        const row = Math.floor(next / draft.width); const column = next % draft.width;
        if (column > 0) queue.push(next - 1); if (column < draft.width - 1) queue.push(next + 1);
        if (row > 0) queue.push(next - draft.width); if (row < draft.height - 1) queue.push(next + draft.width);
      }
    }
    commitDraft({ ...draft, cells });
  };
  const updateMoveSelection = (indices: number[]) => setMoveSelection((current) => {
    const next = new Set(current);
    for (const index of indices) {
      if (!draft.cells[index]) continue;
      if (next.has(index)) next.delete(index); else next.add(index);
    }
    return next;
  });
  const updateMoveRange = (indices: number[], baseSelection: Set<number>) => {
    const next = new Set(baseSelection);
    indices.forEach((index) => {
      if (draft.cells[index]) next.add(index);
    });
    setMoveSelection(next);
  };
  const selectedColor = paletteByCode.get(selected)!;
  const chooseColor = (code: string) => { setSelected(code); setColorSeries(code[0]); setColorOpen(false); };
  const openResize = () => { setMoveSelecting(false); setMoveSelection(new Set()); setResizeWidthInput(String(draft.width)); setResizeHeightInput(String(draft.height)); setResizeOpen(true); };
  const setHorizontalOffset = (offset: number) => { const limited = Math.max(1 - draft.width, Math.min(draft.width - 1, offset)); setHorizontalDirection(limited < 0 ? "left" : "right"); setHorizontalDistanceInput(String(Math.abs(limited))); };
  const setVerticalOffset = (offset: number) => { const limited = Math.max(1 - draft.height, Math.min(draft.height - 1, offset)); setVerticalDirection(limited < 0 ? "up" : "down"); setVerticalDistanceInput(String(Math.abs(limited))); };
  const startMoveSelection = () => { setMoveOpen(false); setMoveSelection(new Set()); setMoveSelecting(true); };
  const openMove = () => { setHorizontalDirection("right"); setHorizontalDistanceInput("0"); setVerticalDirection("down"); setVerticalDistanceInput("0"); setMoveOpen(true); };
  const fitGrid = () => {
    const viewport = gridScrollRef.current; if (!viewport) return;
    const cellWidth = Math.floor((viewport.clientWidth - 36 - draft.width) / draft.width);
    const cellHeight = Math.floor((viewport.clientHeight - 36 - draft.height) / draft.height);
    setZoom(Math.max(25, Math.min(200, Math.floor(Math.min(cellWidth, cellHeight) * 100 / 22))));
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
  };
  const beginGridGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    pinchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchPointers.current.size === 2) {
      const [first, second] = [...pinchPointers.current.values()];
      const viewport = gridScrollRef.current;
      pinchStart.current = { distance: Math.hypot(second.x - first.x, second.y - first.y), zoom, centerX: (first.x + second.x) / 2, centerY: (first.y + second.y) / 2, scrollLeft: viewport?.scrollLeft ?? 0, scrollTop: viewport?.scrollTop ?? 0 };
    }
  };
  const moveGridGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || !pinchPointers.current.has(event.pointerId)) return;
    pinchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinchStart.current || pinchPointers.current.size < 2) return;
    const [first, second] = [...pinchPointers.current.values()];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const nextZoom = Math.round(pinchStart.current.zoom * distance / Math.max(1, pinchStart.current.distance));
    setZoom(Math.max(25, Math.min(200, nextZoom)));
    if (gridScrollRef.current) {
      gridScrollRef.current.scrollLeft = pinchStart.current.scrollLeft - ((first.x + second.x) / 2 - pinchStart.current.centerX);
      gridScrollRef.current.scrollTop = pinchStart.current.scrollTop - ((first.y + second.y) / 2 - pinchStart.current.centerY);
    }
  };
  const endGridGesture = (event: PointerEvent<HTMLDivElement>) => { pinchPointers.current.delete(event.pointerId); if (pinchPointers.current.size < 2) pinchStart.current = null; };
  const sampleSourceImage = (event: ReactMouseEvent<HTMLImageElement>) => {
    const image = event.currentTarget; const rect = image.getBoundingClientRect(); const imageRatio = image.naturalWidth / image.naturalHeight; const boxRatio = rect.width / rect.height;
    const renderedWidth = imageRatio > boxRatio ? rect.width : rect.height * imageRatio; const renderedHeight = imageRatio > boxRatio ? rect.width / imageRatio : rect.height;
    const localX = event.clientX - rect.left - (rect.width - renderedWidth) / 2; const localY = event.clientY - rect.top - (rect.height - renderedHeight) / 2;
    if (localX < 0 || localY < 0 || localX >= renderedWidth || localY >= renderedHeight) return;
    const sourceX = Math.min(image.naturalWidth - 1, Math.max(0, Math.floor(localX / renderedWidth * image.naturalWidth)));
    const sourceY = Math.min(image.naturalHeight - 1, Math.max(0, Math.floor(localY / renderedHeight * image.naturalHeight)));
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1; const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return;
    context.drawImage(image, sourceX, sourceY, 1, 1, 0, 0, 1, 1); const pixel = context.getImageData(0, 0, 1, 1).data; if (pixel[3] < 40) return;
    const code = nearestColor(pixel[0], pixel[1], pixel[2]); setSelected(code); setColorSeries(code[0]); setTool("brush"); setSourceOpen(false);
  };
  return <section className="editor panel"><div className="editor-top"><div><p className="eyebrow">{draft.id ? "Edit template" : draft.sourceKind === "template" ? "Review imported pattern" : draft.sourceKind === "scratch" ? "Draw a new template" : "Review conversion"}</p><input className="title-input" aria-label="Template title" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div><div className="button-row"><button className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button compact" onClick={onSave} disabled={busy || !draft.title.trim()}>{busy ? "Saving…" : "Save template"}</button></div></div>
    {draft.sourceKind !== "scratch" && <section className="source-strip"><div><strong>Uploaded {draft.sourceKind === "template" ? "template" : "picture"}</strong><span>{tool === "eyedropper" ? "Open the original, then click any point to sample its closest bead color." : `Click the preview to view the high-resolution original${draft.sourceKind === "template" ? " with its legend" : ""}.`}</span></div><button type="button" className="source-preview-button" onClick={() => setSourceOpen(true)} aria-label={tool === "eyedropper" ? "Open original image to sample a color" : "View high-resolution original image"}><img src={draft.sourceUrl} alt="Original uploaded source" /></button></section>}
    <div className="editor-workspace">
      <section className="comparison-pane template-pane">
        <div className="pane-heading"><strong>Edit Template</strong><div className="zoom-controls" aria-label="Template zoom controls"><button type="button" onClick={() => setZoom((value) => Math.max(25, value - 25))} disabled={zoom === 25} aria-label="Zoom out">−</button><input type="range" min="25" max="200" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="Zoom level" /><span>{zoom}%</span><button type="button" onClick={() => setZoom((value) => Math.min(200, value + 25))} disabled={zoom === 200} aria-label="Zoom in">+</button><button type="button" className="fit-button" onClick={fitGrid}>Fit</button></div><span>{draft.width} × {draft.height}</span></div>
        <div ref={gridScrollRef} className="grid-scroll" onPointerDown={beginGridGesture} onPointerMove={moveGridGesture} onPointerUp={endGridGesture} onPointerCancel={endGridGesture}><BeadGrid draft={draft} onPaint={moveSelecting ? updateMoveSelection : applyTool} dragEnabled={moveSelecting || tool === "brush" || tool === "eraser"} zoom={zoom} selectedIndices={moveSelection} selectionMode={moveSelecting} onSelectRange={updateMoveRange} /></div>
      </section>
      <aside className="editor-tools">
        <div className="tools-heading"><strong>Editing tools</strong></div>
        <div className="editor-utility-tools">
          <button type="button" onClick={undo} disabled={!history.length} title="Undo the last template change" aria-label="Undo last action"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg><b>Undo</b></button>
          <button type="button" onClick={openResize} title="Change the board dimensions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 20h5v-5M4 9l6-6M20 15l-6 6"/></svg><b>Resize</b></button>
          <button type="button" className={moveSelecting ? "active" : ""} onClick={() => moveSelecting ? (setMoveSelecting(false), setMoveSelection(new Set())) : startMoveSelection()} title="Select and move a group of beads" aria-pressed={moveSelecting}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3"/></svg><b>Move</b></button>
        </div>
        {moveSelecting ? <div className="move-selection-panel"><strong>Select beads to move</strong><span>With touch, swipe immediately to scroll. Press briefly until the board highlights, then drag corner-to-corner to select a range.</span><b>{moveSelection.size.toLocaleString()} selected</b><div><button type="button" className="secondary-button" onClick={() => setMoveSelection(new Set(draft.cells.flatMap((code, index) => code ? [index] : [])))} disabled={!draft.cells.some(Boolean)}>Select all</button><button type="button" className="secondary-button" onClick={() => setMoveSelection(new Set())} disabled={!moveSelection.size}>Clear</button><button type="button" className="primary-button move-selection-apply" onClick={openMove} disabled={!moveSelection.size}>Move selected</button></div></div> : <><div className="tool-grid">{([['brush','Brush'],['bucket','Bucket'],['eraser','Eraser'],['eyedropper','Eyedropper'],['replace','Replace all']] as Array<[EditorTool,string]>).map(([id, label]) => <button type="button" key={id} className={`${tool === id ? "active" : ""} ${id === "replace" ? "replace-tool" : ""}`} aria-pressed={tool === id} onClick={() => { setTool(id); setMoveSelection(new Set()); }}><ToolIcon tool={id} /><b>{label}</b></button>)}</div>
        <button type="button" className="selected-color-button" onClick={() => setColorOpen(true)}><i className={selectedColor.transparent ? "transparent-swatch" : ""} style={{ background: selectedColor.transparent ? undefined : selectedColor.hex }} /><span><small>{tool === "replace" ? "Replacement color" : "Paint color"}</small><b>{selectedColor.code}</b></span><em>Choose →</em></button><p className="tool-help">{tool === "brush" ? "Mouse or pen: tap or drag to paint. Touch: swipe immediately to scroll, or press briefly until the board highlights and then drag to paint." : tool === "bucket" ? "Fill a connected section with the selected color." : tool === "eraser" ? "Mouse or pen: tap or drag to erase. Touch: swipe immediately to scroll, or press briefly until the board highlights and then drag to erase." : tool === "replace" ? "Choose the replacement color, then tap any bead to change every bead of that color." : "Tap a bead or open the original upload to sample a color."}</p></>}
      </aside>
    </div>
    <section className="used-colors"><div><strong>Colors used</strong><span>{draft.cells.filter(Boolean).length.toLocaleString()} beads · {usedColors.length} {usedColors.length === 1 ? "color" : "colors"}</span></div><div className="used-color-list">{usedColors.length ? usedColors.map((color) => <span key={color.code}><i className={color.transparent ? "transparent-swatch" : ""} style={{ background: color.transparent ? undefined : color.hex }} /><b>{color.code}</b><em>{counts[color.code]}</em></span>) : <p>No colors used yet. Choose a color and start drawing.</p>}</div></section>
    {resizeOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setResizeOpen(false); }}><section className="gallery-modal resize-template-modal" role="dialog" aria-modal="true" aria-label="Resize template"><header><div><p className="eyebrow">Template tool</p><h2>Resize template</h2><p>Change the board dimensions. Existing beads keep their current row and column.</p></div><button type="button" aria-label="Close resize template" onClick={() => setResizeOpen(false)}>×</button></header>{smallDraft && <div className="resize-shortcut"><div><strong>Fit artwork to Small</strong><span>Trim empty outer space and center every drawn bead on a 26 × 26 board.</span></div><button type="button" className="fit-small-button" onClick={() => { commitDraft(smallDraft); setResizeOpen(false); }}>Fit to 26 × 26</button></div>}<div className="resize-fields"><label>Width<input aria-label="Width" type="number" min="4" max="128" value={resizeWidthInput} onChange={(event) => setResizeWidthInput(event.target.value)} /></label><span>×</span><label>Height<input aria-label="Height" type="number" min="4" max="128" value={resizeHeightInput} onChange={(event) => setResizeHeightInput(event.target.value)} /></label></div><div className={`resize-status ${!resizeInputsValid || resizeResult.cropped ? "warning" : ""}`}>{!resizeInputsValid ? "Enter a complete width and height from 4 to 128." : resizeResult.cropped ? `This size would cut off ${resizeResult.cropped.toLocaleString()} drawn ${resizeResult.cropped === 1 ? "bead" : "beads"}. Increase the dimensions before applying.` : <><strong>All drawn beads will be preserved</strong><span>{draft.width} × {draft.height} becomes {resizeWidth} × {resizeHeight}</span></>}</div><div className="button-row resize-actions"><button type="button" className="secondary-button" onClick={() => setResizeOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={!resizeInputsValid || !resizeResult.draft || (resizeWidth === draft.width && resizeHeight === draft.height)} onClick={() => { if (resizeResult.draft) commitDraft(resizeResult.draft); setResizeOpen(false); }}>Apply resize</button></div></section></div>}
    {moveOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setMoveOpen(false); }}><section className="gallery-modal resize-template-modal move-template-modal" role="dialog" aria-modal="true" aria-label="Move selected beads"><header><div><p className="eyebrow">Template tool</p><h2>Move selected beads</h2><p>Shift the {moveSelection.size.toLocaleString()} selected {moveSelection.size === 1 ? "bead" : "beads"} without changing the board size.</p></div><button type="button" aria-label="Close move selected beads" onClick={() => setMoveOpen(false)}>×</button></header><div className="move-fields"><label>Horizontal<div className="move-direction-input"><select aria-label="Horizontal direction" value={horizontalDirection} onChange={(event) => setHorizontalDirection(event.target.value as "left" | "right")}><option value="left">Left</option><option value="right">Right</option></select><input aria-label="Horizontal distance" inputMode="numeric" type="number" min="0" max={draft.width - 1} value={horizontalDistanceInput} onChange={(event) => setHorizontalDistanceInput(event.target.value)} /><span>cells</span></div></label><label>Vertical<div className="move-direction-input"><select aria-label="Vertical direction" value={verticalDirection} onChange={(event) => setVerticalDirection(event.target.value as "up" | "down")}><option value="up">Up</option><option value="down">Down</option></select><input aria-label="Vertical distance" inputMode="numeric" type="number" min="0" max={draft.height - 1} value={verticalDistanceInput} onChange={(event) => setVerticalDistanceInput(event.target.value)} /><span>cells</span></div></label></div><div className="move-stepper" aria-label="Move selected beads one cell"><span /><button type="button" aria-label="Move up one row" onClick={() => setVerticalOffset(moveRows - 1)}>↑</button><span /><button type="button" aria-label="Move left one column" onClick={() => setHorizontalOffset(moveColumns - 1)}>←</button><button type="button" aria-label="Reset move" onClick={() => { setHorizontalDirection("right"); setHorizontalDistanceInput("0"); setVerticalDirection("down"); setVerticalDistanceInput("0"); }}>•</button><button type="button" aria-label="Move right one column" onClick={() => setHorizontalOffset(moveColumns + 1)}>→</button><span /><button type="button" aria-label="Move down one row" onClick={() => setVerticalOffset(moveRows + 1)}>↓</button></div><div className={`resize-status ${!moveInputsValid || moveResult.cropped || moveResult.blocked ? "warning" : ""}`}>{!moveInputsValid ? `Enter horizontal and vertical distances within this ${draft.width} × ${draft.height} board.` : moveResult.cropped ? `This move would push ${moveResult.cropped.toLocaleString()} selected ${moveResult.cropped === 1 ? "bead" : "beads"} outside the board. Choose a smaller distance.` : moveResult.blocked ? `This move would overlap ${moveResult.blocked.toLocaleString()} unselected ${moveResult.blocked === 1 ? "bead" : "beads"}. Choose another offset.` : <><strong>Selected beads will stay on the board</strong><span>{moveColumns === 0 && moveRows === 0 ? "Choose how far to move the selection" : `${horizontalDistance || "No"} ${horizontalDistance === 1 ? "cell" : "cells"}${horizontalDistance ? ` ${horizontalDirection}` : " horizontally"}; ${verticalDistance || "no"} ${verticalDistance === 1 ? "cell" : "cells"}${verticalDistance ? ` ${verticalDirection}` : " vertically"}`}</span></>}</div><div className="button-row resize-actions"><button type="button" className="secondary-button" onClick={() => setMoveOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={!moveInputsValid || !moveResult.draft || (moveColumns === 0 && moveRows === 0)} onClick={() => { if (moveResult.draft) commitDraft(moveResult.draft); setMoveOpen(false); setMoveSelecting(false); setMoveSelection(new Set()); }}>Apply move</button></div></section></div>}
    {colorOpen && <div className="color-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setColorOpen(false); }}><section className="color-dialog" role="dialog" aria-modal="true" aria-label="Choose a bead color"><header><div><p className="eyebrow">264-color palette</p><h2>Choose a color</h2></div><button type="button" aria-label="Close color selection" onClick={() => setColorOpen(false)}>×</button></header><input className="palette-search" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} placeholder="Find a code or color" aria-label="Find a palette color" /><div className="series-tabs" role="tablist" aria-label="Color series">{SERIES.map((series) => { const colors = PALETTE.filter((color) => color.code.startsWith(series)); const swatches = colors.filter((_, index) => index % Math.max(1, Math.floor(colors.length / 3)) === 0).slice(0, 3); return <button type="button" role="tab" aria-label={`${series}, ${SERIES_NAMES[series]}`} aria-selected={colorSeries === series} className={colorSeries === series ? "active" : ""} key={series} onClick={() => setColorSeries(series)}><b>{series}</b><span className="color-series-swatches" aria-hidden="true">{swatches.map((color) => <i key={color.code} className={color.transparent ? "transparent-swatch" : ""} style={{ background: color.transparent ? undefined : color.hex }} />)}</span></button>; })}</div><div className="series-selected-detail" aria-live="polite"><b>{colorSeries}</b><span>{SERIES_NAMES[colorSeries]}</span></div><div className="color-picker-grid">{visibleColors.map((color) => <button type="button" key={color.code} className={selected === color.code ? "active" : ""} onClick={() => chooseColor(color.code)}><i className={color.transparent ? "transparent-swatch" : ""} style={{ background: color.transparent ? undefined : color.hex }} /><b>{color.code}</b></button>)}{visibleColors.length === 0 && <p>No colors match your search in this series.</p>}</div></section></div>}
    {sourceOpen && <div className="source-image-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setSourceOpen(false); }}><section className="source-image-dialog" role="dialog" aria-modal="true" aria-label="High-resolution original image"><header><div><p className="eyebrow">{tool === "eyedropper" ? "Sample from original" : "Original upload"}</p><h2>{draft.title}</h2>{tool === "eyedropper" && <p className="source-sample-help">Click a point in the image to select its closest bead color.</p>}</div><button type="button" aria-label="Close original image" onClick={() => setSourceOpen(false)}>×</button></header><img className={tool === "eyedropper" ? "sampling" : ""} onClick={tool === "eyedropper" ? sampleSourceImage : undefined} src={draft.sourceUrl} alt={`High-resolution original for ${draft.title}`} /></section></div>}
  </section>;
}

function App() {
  const [view, setView] = useState<View>("home"); const [templates, setTemplates] = useState<Template[]>([]); const [artworks, setArtworks] = useState<Artwork[]>([]); const [inventory, setInventory] = useState<Inventory[]>([]);
  const [gallerySearch, setGallerySearch] = useState("");
  const [uploadMode, setUploadMode] = useState<UploadMode>("photo");
  const [draft, setDraft] = useState<Draft | null>(null); const [sourceFile, setSourceFile] = useState<File | null>(null); const [sourcePreview, setSourcePreview] = useState(""); const [sourceTitle, setSourceTitle] = useState("");
  const [sizePreset, setSizePreset] = useState<SizePreset>("medium"); const [customWidth, setCustomWidth] = useState(52); const [customLength, setCustomLength] = useState(52);
  const [completionOpen, setCompletionOpen] = useState(false); const [completionFile, setCompletionFile] = useState<File | null>(null); const [completionPreview, setCompletionPreview] = useState("");
  const [completionTemplate, setCompletionTemplate] = useState(""); const [completionCaption, setCompletionCaption] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null); const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const [inventoryEditTarget, setInventoryEditTarget] = useState<Inventory | null>(null); const [inventoryEditQuantity, setInventoryEditQuantity] = useState(0);
  const [inventoryDetailTarget, setInventoryDetailTarget] = useState<Inventory | null>(null);
  const [templateColorTarget, setTemplateColorTarget] = useState<Inventory | null>(null);
  const [lowStockOpen, setLowStockOpen] = useState(false); const [globalThreshold, setGlobalThreshold] = useState(100);
  const [refillOpen, setRefillOpen] = useState(false); const [refillSeries, setRefillSeries] = useState(SERIES[0]);
  const [refillMode, setRefillMode] = useState<"series" | "colors">("series");
  const [refillSearch, setRefillSearch] = useState(""); const [refillSelected, setRefillSelected] = useState<Set<string>>(new Set()); const [refillAmount, setRefillAmount] = useState(1200);
  const [useOpen, setUseOpen] = useState(false); const [useSeries, setUseSeries] = useState(SERIES[0]);
  const [useSearch, setUseSearch] = useState(""); const [useSelected, setUseSelected] = useState<Set<string>>(new Set()); const [useAmounts, setUseAmounts] = useState<Record<string, number>>({});
  const [useMode, setUseMode] = useState<"template" | "colors">("template"); const [useTemplateId, setUseTemplateId] = useState("");
  const [useTemplateSearch, setUseTemplateSearch] = useState(""); const [useTemplatePage, setUseTemplatePage] = useState(0);
  const [stockHistoryOpen, setStockHistoryOpen] = useState(false); const [stockTransactions, setStockTransactions] = useState<StockTransaction[]>([]); const [stockDeleteTarget, setStockDeleteTarget] = useState<StockTransaction | null>(null);
  const [viewerTemplate, setViewerTemplate] = useState<Template | null>(null);
  const templateInput = useRef<HTMLInputElement>(null); const artworkInput = useRef<HTMLInputElement>(null); const featuredScroller = useRef<HTMLDivElement>(null);
  const scrollFeatured = (direction: -1 | 1) => {
    const scroller = featuredScroller.current; if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(280, scroller.clientWidth * .9), behavior: "smooth" });
  };
  const totalBeadsOnHand = inventory.reduce((sum, item) => sum + item.quantity, 0);
  const galleryQuery = gallerySearch.trim().toLowerCase();
  const matchingGalleryTemplates = templates.filter((template) => {
    if (!galleryQuery) return true;
    if (template.title.toLowerCase().includes(galleryQuery)) return true;
    return Object.keys(countBeads(template.cells)).some((code) => {
      const color = paletteByCode.get(code);
      return code.toLowerCase().includes(galleryQuery) || color?.name.toLowerCase().includes(galleryQuery);
    });
  });
  const useTransactions = stockTransactions.filter((transaction) => transaction.type === "use");
  const completedUsage = useTransactions.reduce<Record<string, number>>((totals, transaction) => {
    for (const [code, change] of Object.entries(transaction.changes)) if (change < 0) totals[code] = (totals[code] ?? 0) - change;
    return totals;
  }, {});
  const completedPieces = useTransactions.filter((transaction) => transaction.label.startsWith("Use beads for artwork: ") || transaction.label.startsWith("Gallery template: ")).length;
  const totalBeadsUsed = Object.values(completedUsage).reduce((sum, count) => sum + count, 0);
  const topUsedColors = Object.entries(completedUsage).sort((left, right) => right[1] - left[1]).slice(0, 4);
  const topUsedColorCount = topUsedColors[0]?.[1] ?? 1;
  const usageBySeries = Object.entries(completedUsage).reduce<Record<string, number>>((totals, [code, count]) => {
    const series = code.charAt(0);
    totals[series] = (totals[series] ?? 0) + count;
    return totals;
  }, {});
  const mostUsedSeries = Object.entries(usageBySeries).sort((left, right) => right[1] - left[1])[0];
  const lowColors = inventory.filter((item) => item.isLow);
  const visibleInventory = inventory.filter((item) => item.code.startsWith(selectedSeries ?? ""));
  const templatesUsingColor = templateColorTarget ? templates.filter((template) => template.cells.includes(templateColorTarget.code)) : [];
  const refillColors = inventory.filter((item) => item.code.startsWith(refillSeries) && (item.code.toLowerCase().includes(refillSearch.toLowerCase()) || item.name.toLowerCase().includes(refillSearch.toLowerCase())));
  const useColors = inventory.filter((item) => item.code.startsWith(useSeries) && (item.code.toLowerCase().includes(useSearch.toLowerCase()) || item.name.toLowerCase().includes(useSearch.toLowerCase())));
  const useSelectedColors = inventory.filter((item) => useSelected.has(item.code));
  const useIndividualUsage = Object.fromEntries(useSelectedColors.map((item) => [item.code, useAmounts[item.code] ?? 1]));
  const useIndividualHasShortage = useSelectedColors.some((item) => (useAmounts[item.code] ?? 1) > item.quantity);
  const matchingUseTemplates = templates.filter((template) => template.title.toLowerCase().includes(useTemplateSearch.trim().toLowerCase()));
  const useTemplatePageCount = Math.max(1, Math.ceil(matchingUseTemplates.length / 4));
  const shownUseTemplates = matchingUseTemplates.slice(useTemplatePage * 4, useTemplatePage * 4 + 4);
  const selectedUseTemplate = templates.find((item) => item.id === useTemplateId);
  const selectedUseTemplateUsage = selectedUseTemplate ? countBeads(selectedUseTemplate.cells) : {};
  const selectedUseTemplateHasShortage = Object.entries(selectedUseTemplateUsage).some(([code, count]) => (inventory.find((item) => item.code === code)?.quantity ?? 0) < count);
  const latestArtworkByTemplate = new Map<string, Artwork>();
  for (const artwork of artworks) if (artwork.templateId && !latestArtworkByTemplate.has(artwork.templateId)) latestArtworkByTemplate.set(artwork.templateId, artwork);
  const featuredTemplates = [...templates].sort((left, right) => {
    const leftArtwork = latestArtworkByTemplate.get(left.id); const rightArtwork = latestArtworkByTemplate.get(right.id);
    if (Boolean(leftArtwork) !== Boolean(rightArtwork)) return rightArtwork ? 1 : -1;
    if (left.sourceKind !== right.sourceKind) return left.sourceKind === "photo" ? -1 : 1;
    return (rightArtwork?.createdAt ?? right.updatedAt).localeCompare(leftArtwork?.createdAt ?? left.updatedAt);
  }).slice(0, 10);
  const refresh = async () => { try { const [nextTemplates, nextArtworks, nextInventory, nextTransactions] = await Promise.all([api<Template[]>("/api/templates"), api<Artwork[]>("/api/artworks"), api<Inventory[]>("/api/inventory"), api<StockTransaction[]>("/api/inventory/transactions")]); setTemplates(nextTemplates); setArtworks(nextArtworks); setInventory(nextInventory); setStockTransactions(nextTransactions); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the app."); } };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setError(""); setMessage(""); }, [view]);
  useEffect(() => { if (!message) return; const timeout = window.setTimeout(() => setMessage(""), 3000); return () => window.clearTimeout(timeout); }, [message]);
  useEffect(() => { if (!sourceFile) { setSourcePreview(""); return; } const url = URL.createObjectURL(sourceFile); setSourcePreview(url); return () => URL.revokeObjectURL(url); }, [sourceFile]);
  useEffect(() => { if (!completionFile) { setCompletionPreview(""); return; } const url = URL.createObjectURL(completionFile); setCompletionPreview(url); return () => URL.revokeObjectURL(url); }, [completionFile]);
  const notify = (text: string, isError = false) => { setMessage(isError ? "" : text); setError(isError ? text : ""); };
  const chooseSourceFile = (file: File | null) => {
    if (!file) { setSourceFile(null); return; }
    if (file.size > MAX_UPLOAD_BYTES) {
      setSourceFile(null);
      notify(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Choose an image that is 25 MB or smaller.`, true);
      if (templateInput.current) templateInput.current.value = "";
      return;
    }
    setError(""); setSourceFile(file);
  };

  const prepareTemplate = async (event: FormEvent) => {
    event.preventDefault(); if (uploadMode !== "scratch" && !sourceFile) { templateInput.current?.click(); return; }
    setBusy(true); setAnalysisStatus(uploadMode === "template" ? "Opening the existing template…" : uploadMode === "scratch" ? "Preparing a blank bead board…" : "Pixelating picture…");
    try {
      const preset = RESOLUTIONS.find((option) => option.id === sizePreset)!;
      const width = sizePreset === "custom" ? customWidth : preset.width!; const height = sizePreset === "custom" ? customLength : preset.height!;
      const title = sourceTitle.trim() || (sourceFile ? sourceFile.name.replace(/\.[^.]+$/, "") : "Untitled template");
      if (uploadMode === "photo") {
        const grid = await pictureToGrid(sourceFile!, width, height); setDraft({ title, sourceKind: "photo", sourceFile: sourceFile!, ...grid });
      } else if (uploadMode === "template") {
        const grid = await existingTemplateToGrid(sourceFile!, setAnalysisStatus); setDraft({ title, sourceKind: "template", sourceFile: sourceFile!, sourceUrl: grid.sourceUrl, width: grid.width, height: grid.height, cells: grid.cells });
      } else {
        const sourceFile = await scratchSource(width, height);
        setDraft({ title, sourceKind: "scratch", sourceFile, sourceUrl: "", width, height, cells: Array(width * height).fill(null) });
      }
    } catch (cause) { notify(cause instanceof Error ? cause.message : "This image could not be analyzed.", true); }
    finally { setBusy(false); setAnalysisStatus(""); }
  };
  const saveTemplate = async () => {
    if (!draft) return;
    const cells = draft.cells.map((cell) => cell ?? null);
    const expectedCells = draft.width * draft.height;
    if (!Number.isInteger(draft.width) || !Number.isInteger(draft.height) || draft.width < 4 || draft.width > 128 || draft.height < 4 || draft.height > 128) { notify("Template dimensions must be whole numbers from 4 to 128.", true); return; }
    if (cells.length !== expectedCells) { notify(`This ${draft.width} × ${draft.height} template needs ${expectedCells.toLocaleString()} cells, but has ${cells.length.toLocaleString()}.`, true); return; }
    const invalidCodes = [...new Set(cells.filter((cell): cell is string => cell !== null && !paletteByCode.has(cell)))];
    if (invalidCodes.length) { notify(`Template contains unrecognized bead ${invalidCodes.length === 1 ? "color" : "colors"}: ${invalidCodes.slice(0, 5).join(", ")}.`, true); return; }
    const grid = { title: draft.title.trim(), sourceKind: draft.sourceKind, width: draft.width, height: draft.height, cells };
    setBusy(true);
    try {
      if (draft.id) await api(`/api/templates/${draft.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grid) });
      else { const body = new FormData(); body.append("grid", JSON.stringify(grid)); body.append("photo", draft.sourceFile!); await api("/api/templates", { method: "POST", body }); }
      if (!draft.id && draft.sourceUrl.startsWith("blob:")) URL.revokeObjectURL(draft.sourceUrl);
      setDraft(null); setSourceFile(null); setSourceTitle(""); await refresh(); setView("gallery");
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not save template.", true); }
    finally { setBusy(false); }
  };
  const editTemplate = (template: Template) => { setView("upload"); setDraft({ ...template }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const exportTemplate = async (template: Template) => { try { await exportTemplateImage(template); notify("Image exported."); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not export template.", true); } };
  const logCompletion = (template: Template) => { setView("gallery"); setCompletionTemplate(template.id); setCompletionOpen(true); };
  const closeCompletion = () => { setCompletionOpen(false); setCompletionFile(null); setCompletionTemplate(""); setCompletionCaption(""); if (artworkInput.current) artworkInput.current.value = ""; };
  const removeTemplate = async () => { if (!deleteTarget || deleteStep !== 2) return; setBusy(true); try { await api(`/api/templates/${deleteTarget.id}`, { method: "DELETE" }); setDeleteTarget(null); setDeleteStep(1); await refresh(); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not remove template.", true); } finally { setBusy(false); } };
  const saveInventory = async (item: Inventory, quantity: number) => { try { const updated = await api<Inventory>(`/api/inventory/${item.code}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantity, lowThreshold: item.lowThreshold }) }); setInventory((current) => current.map((color) => color.code === updated.code ? updated : color)); return true; } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not update inventory.", true); return false; } };
  const openInventoryEdit = (item: Inventory) => { setInventoryEditTarget(item); setInventoryEditQuantity(item.quantity); };
  const saveInventoryEdit = async (event: FormEvent) => { event.preventDefault(); if (!inventoryEditTarget) return; setBusy(true); const saved = await saveInventory(inventoryEditTarget, inventoryEditQuantity); setBusy(false); if (saved) setInventoryEditTarget(null); };
  const openLowStock = () => { setGlobalThreshold(inventory[0]?.lowThreshold ?? 100); setLowStockOpen(true); };
  const saveGlobalThreshold = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const updated = await api<Inventory[]>("/api/inventory/threshold", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lowThreshold: globalThreshold }) }); setInventory(updated); setLowStockOpen(false); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not update the low-stock threshold.", true); } finally { setBusy(false); } };
  const openRefill = () => { setRefillSeries(selectedSeries ?? SERIES[0]); setRefillMode("series"); setRefillSearch(""); setRefillSelected(new Set()); setRefillAmount(1200); setRefillOpen(true); };
  const toggleRefillColor = (code: string) => setRefillSelected((current) => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  const selectRefillSeries = () => setRefillSelected((current) => new Set([...current, ...inventory.filter((item) => item.code.startsWith(refillSeries)).map((item) => item.code)]));
  const clearRefillSeries = () => setRefillSelected((current) => new Set([...current].filter((code) => !code.startsWith(refillSeries))));
  const toggleRefillSeries = (series: string) => { const codes = inventory.filter((item) => item.code.startsWith(series)).map((item) => item.code); setRefillSelected((current) => { const next = new Set(current); const allSelected = codes.every((code) => next.has(code)); for (const code of codes) if (allSelected) next.delete(code); else next.add(code); return next; }); setRefillSeries(series); setRefillSearch(""); };
  const refillInventory = async (event: FormEvent) => { event.preventDefault(); if (!refillSelected.size) return; setBusy(true); try { const updated = await api<Inventory[]>("/api/inventory/refill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes: [...refillSelected], amount: refillAmount }) }); const byCode = new Map(updated.map((item) => [item.code, item])); setInventory((current) => current.map((item) => byCode.get(item.code) ?? item)); setRefillOpen(false); setRefillSelected(new Set()); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not refill beads.", true); } finally { setBusy(false); } };
  const openUse = () => { setUseMode(templates.length ? "template" : "colors"); setUseTemplateId(templates[0]?.id ?? ""); setUseTemplateSearch(""); setUseTemplatePage(0); setUseSeries(selectedSeries ?? SERIES[0]); setUseSearch(""); setUseSelected(new Set()); setUseAmounts({}); setUseOpen(true); };
  const toggleUseColor = (code: string) => setUseSelected((current) => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  const deductInventory = async (event: FormEvent) => {
    event.preventDefault(); const template = templates.find((item) => item.id === useTemplateId);
    if (useMode === "template" ? !template : !useSelected.size || useIndividualHasShortage) return;
    const usage = template ? countBeads(template.cells) : null;
    setBusy(true);
    try {
      const payload = useMode === "template" ? { usage, label: `Use beads for artwork: ${template!.title}` } : { usage: useIndividualUsage, label: `Used ${useSelected.size} individual ${useSelected.size === 1 ? "color" : "colors"}` };
      const updated = await api<Inventory[]>("/api/inventory/use", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const byCode = new Map(updated.map((item) => [item.code, item])); setInventory((current) => current.map((item) => byCode.get(item.code) ?? item)); setUseOpen(false); setUseSelected(new Set());
      setStockTransactions(await api<StockTransaction[]>("/api/inventory/transactions"));
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not use beads.", true); } finally { setBusy(false); }
  };
  const openStockHistory = async () => { setStockHistoryOpen(true); try { setStockTransactions(await api<StockTransaction[]>("/api/inventory/transactions")); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not load recent stock changes.", true); } };
  const deleteStockTransaction = async (transaction: StockTransaction) => { setBusy(true); try { await api(`/api/inventory/transactions/${transaction.id}`, { method: "DELETE" }); const [nextTransactions] = await Promise.all([api<StockTransaction[]>("/api/inventory/transactions"), refresh()]); setStockTransactions(nextTransactions); setStockDeleteTarget(null); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not reverse this stock change.", true); } finally { setBusy(false); } };
  const completeArtwork = async (event: FormEvent) => { event.preventDefault(); if (!completionFile) { artworkInput.current?.click(); return; } setBusy(true); try { const body = new FormData(); body.append("photo", completionFile); body.append("templateId", completionTemplate); body.append("caption", completionCaption); await api("/api/artworks", { method: "POST", body }); closeCompletion(); await refresh(); } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not complete artwork.", true); } finally { setBusy(false); } };
  return <main><header className="app-header"><div className="brand"><div className="brand-mark" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div><div><p className="eyebrow">My collection</p><h1>拼豆Pro</h1></div></div><nav aria-label="Main navigation">{(["home", "upload", "gallery", "inventory"] as View[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => { setView(item); setDraft(null); if (item === "inventory") setSelectedSeries(null); }}>{item === "inventory" && lowColors.length > 0 && <b>{lowColors.length}</b>}{NAV_LABELS[item]}</button>)}</nav></header>
    {error && <div className="notice error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}{message && <div className="notice success" role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}{lowColors.length > 0 && view === "inventory" && <button className="low-banner" onClick={openLowStock}>⚠ {lowColors.length} bead {lowColors.length === 1 ? "color is" : "colors are"} running low. Review threshold and refill as needed. →</button>}

    {view === "home" && <>
      <section className="home-hero panel"><div><p className="eyebrow">我的拼豆神器</p><h2>今天你拼豆了吗？</h2><p>Turn pictures into bead patterns, keep your favorite work together, and see what colors you have on hand.</p><div className="button-row"><button className="primary-button" onClick={() => setView("upload")}>Upload a template</button><button className="secondary-button" onClick={() => setView("gallery")}>Explore Gallery</button></div></div><div className="home-stats"><div className="finished-pieces-stat"><strong>{artworks.length}</strong><span>Finished pieces</span></div><div className="templates-stat"><strong>{templates.length}</strong><span>Templates</span></div><div className="beads-on-hand-stat"><strong>{totalBeadsOnHand.toLocaleString()}</strong><span>Beads on hand</span></div></div></section>
      <section className="content-section"><div className="section-heading"><div><p className="eyebrow">From your collection</p><h2>Featured Artwork</h2></div><div className="featured-heading-actions"><div className="featured-scroll-buttons" aria-label="Featured artwork controls"><button type="button" aria-label="Previous featured artwork" onClick={() => scrollFeatured(-1)}>‹</button><button type="button" aria-label="Next featured artwork" onClick={() => scrollFeatured(1)}>›</button></div><button className="text-button" onClick={() => setView("gallery")}>More</button></div></div>{featuredTemplates.length ? <div ref={featuredScroller} className="artwork-tiles featured-artwork-scroller">{featuredTemplates.map((template) => <ArtworkTile key={template.id} template={template} artwork={latestArtworkByTemplate.get(template.id)} onView={() => setViewerTemplate(template)} onEdit={() => editTemplate(template)} onComplete={() => logCompletion(template)} onExport={() => void exportTemplate(template)} />)}</div> : <Empty title="Your featured artwork starts here" text="Upload a picture or pattern to create your first featured template." />}</section>
    </>}

    {view === "upload" && (draft ? <TemplateEditor draft={draft} setDraft={setDraft} onSave={() => void saveTemplate()} onCancel={() => setDraft(null)} busy={busy} /> : <>
      <section className="panel create-panel upload-panel">
        <div className="upload-intro">
          <p className="eyebrow">New template</p>
          <div className="mode-switch" role="group" aria-label="Template upload type">
            <button type="button" className={uploadMode === "photo" ? "active" : ""} onClick={() => { setUploadMode("photo"); setSourceFile(null); }}>Photo or picture</button>
            <button type="button" className={uploadMode === "template" ? "active" : ""} onClick={() => { setUploadMode("template"); setSourceFile(null); }}>Existing template</button>
            <button type="button" className={uploadMode === "scratch" ? "active" : ""} onClick={() => { setUploadMode("scratch"); setSourceFile(null); }}>Draw from scratch</button>
          </div>
          <h2>{uploadMode === "photo" ? "Turn a picture into beads" : uploadMode === "template" ? "Import a finished pattern" : "Draw a pattern from scratch"}</h2>
          <p>{uploadMode === "photo" ? "Choose the level of pixelation based on how large and detailed you want the artwork." : uploadMode === "template" ? "The app detects the existing grid and reads its printed color codes without pixelating the pattern again." : "Start with a blank bead board, then use the editor tools to draw your own pattern."}</p>
          {uploadMode === "photo" && <p className="development-note">Photo conversion is under development.</p>}
        </div>
        <form onSubmit={prepareTemplate} className="create-form">
          {uploadMode !== "scratch" && <label className={`file-drop upload-file-drop ${sourcePreview ? "has-preview" : ""}`}><input key={uploadMode} ref={templateInput} type="file" accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => chooseSourceFile(e.target.files?.[0] ?? null)} />{sourcePreview && <img src={sourcePreview} alt="Preview of image to upload" />}<span>{sourceFile ? sourceFile.name : uploadMode === "photo" ? "Choose a photo or picture" : "Choose an existing template"}</span><small>{sourceFile ? "Click to choose a different image" : "JPG, PNG, WebP, GIF, or HEIC · up to 25 MB"}</small></label>}
          <label>Template name<input value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} placeholder="Rainbow mushroom" /></label>
          {uploadMode !== "template" && <fieldset className="resolution-picker"><legend>Artwork size</legend><div className="resolution-options">{RESOLUTIONS.map((option) => <label key={option.id} className={sizePreset === option.id ? "active" : ""}><input type="radio" name="resolution" value={option.id} checked={sizePreset === option.id} onChange={() => setSizePreset(option.id)} /><b>{option.label}</b><span>{option.id === "custom" ? "Choose width × length" : `${option.width} × ${option.height} beads`}</span></label>)}</div>{sizePreset === "custom" && <div className="custom-size"><label>Width<input aria-label="Custom artwork width" type="number" min="4" max="128" step="1" value={customWidth} onChange={(event) => setCustomWidth(Math.min(128, Math.max(4, Math.round(Number(event.target.value) || 4))))} /></label><span aria-hidden="true">×</span><label>Length<input aria-label="Custom artwork length" type="number" min="4" max="128" step="1" value={customLength} onChange={(event) => setCustomLength(Math.min(128, Math.max(4, Math.round(Number(event.target.value) || 4))))} /></label><small>4–128 beads per side</small></div>}</fieldset>}
          {analysisStatus && <p className="analysis-status" role="status"><span />{analysisStatus}</p>}
          <button className="primary-button" disabled={busy}>{busy ? "Preparing…" : uploadMode === "scratch" ? "Start drawing" : uploadMode === "photo" ? "Pixelate" : "Upload"}</button>
        </form>
      </section>
      <p className="upload-gallery-link"><button className="text-button" onClick={() => setView("gallery")}>Go to Gallery →</button></p>
    </>)}

    {view === "gallery" && <>
      <section className="gallery-section"><div className="section-heading"><div><p className="eyebrow">Your collection</p><h2>Gallery</h2><p>Finished photos appear here when attached; otherwise you see the bead template.</p></div><span className="count">{galleryQuery ? `${matchingGalleryTemplates.length} of ${templates.length}` : templates.length} {templates.length === 1 ? "template" : "templates"}</span></div>
        {templates.length > 0 && <label className="gallery-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input type="search" value={gallerySearch} onChange={(event) => setGallerySearch(event.target.value)} placeholder="Search by template name or color" aria-label="Search Gallery by template name or color" /></label>}
        {matchingGalleryTemplates.length ? <div className="artwork-tiles">{matchingGalleryTemplates.map((template) => <ArtworkTile key={template.id} template={template} artwork={latestArtworkByTemplate.get(template.id)} onView={() => setViewerTemplate(template)} onEdit={() => editTemplate(template)} onComplete={() => logCompletion(template)} onExport={() => void exportTemplate(template)} onRemove={latestArtworkByTemplate.has(template.id) ? undefined : () => { setDeleteTarget(template); setDeleteStep(1); }} />)}</div> : templates.length ? <div className="gallery-search-empty"><strong>No templates found</strong><span>Try a template name, color code, or color name.</span><button type="button" className="text-button" onClick={() => setGallerySearch("")}>Clear search</button></div> : <Empty title="No artwork templates yet" text="Upload a picture, existing pattern, or draw one from scratch to start your gallery." />}</section>
    </>}

    {viewerTemplate && <MakingView template={viewerTemplate} onClose={() => setViewerTemplate(null)} />}
    {completionOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) closeCompletion(); }}><section className="gallery-modal completion-modal" role="dialog" aria-modal="true" aria-label="Add completed artwork"><header><div><p className="eyebrow">Finished piece</p><h2>Add completed artwork</h2></div><button type="button" aria-label="Close completed artwork" onClick={closeCompletion} disabled={busy}>×</button></header><p className="completion-template-name">Template: <strong>{templates.find((template) => template.id === completionTemplate)?.title}</strong></p><form className="create-form completion-form" onSubmit={completeArtwork}><label className={`file-drop completion-file-drop ${completionPreview ? "has-preview" : ""}`}><input ref={artworkInput} type="file" accept="image/*" onChange={(event) => setCompletionFile(event.target.files?.[0] ?? null)} />{completionPreview && <img src={completionPreview} alt="Preview of completed artwork to upload" />}<span>{completionFile?.name ?? "Choose completed artwork photo"}</span>{completionFile && <small>Click to choose a different photo</small>}</label><label>Caption <small>optional</small><input value={completionCaption} onChange={(event) => setCompletionCaption(event.target.value)} placeholder="Made for the game room" /></label><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={closeCompletion} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || !completionTemplate}>{busy ? "Saving…" : "Complete artwork"}</button></div></form></section></div>}

    {deleteTarget && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null); }}><section className="gallery-modal delete-modal" role="alertdialog" aria-modal="true" aria-label={deleteStep === 1 ? "Confirm template removal" : "Final template removal confirmation"}><header><div><p className="eyebrow">{deleteStep === 1 ? "Remove template" : "Final confirmation"}</p><h2>{deleteStep === 1 ? `Remove “${deleteTarget.title}”?` : "Delete this template permanently?"}</h2></div><button type="button" aria-label="Cancel template removal" onClick={() => setDeleteTarget(null)} disabled={busy}>×</button></header><p>{deleteStep === 1 ? "This will remove the saved bead pattern and its original upload." : `This is your second confirmation. “${deleteTarget.title}” cannot be recovered after deletion.`}</p><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={busy}>Cancel</button>{deleteStep === 1 ? <button type="button" className="primary-button" onClick={() => setDeleteStep(2)}>Continue</button> : <button type="button" className="primary-button delete-confirm-button" onClick={() => void removeTemplate()} disabled={busy}>{busy ? "Deleting…" : "Delete template"}</button>}</div></section></div>}

    {view === "inventory" && <section className="inventory-section"><div className="section-heading"><div><p className="eyebrow">Bead box</p><h2>Inventory</h2><p>Open a series to check individual bead colors and stock levels.</p></div><div className="inventory-heading-actions"><button className="primary-button compact inventory-action-button" onClick={openRefill}><InventoryActionIcon action="refill" /><span>Bead Refill</span></button><button className="primary-button compact inventory-action-button" onClick={openUse}><InventoryActionIcon action="use" /><span>Use Beads</span></button><button type="button" className="primary-button compact inventory-action-button" onClick={() => void openStockHistory()}><InventoryActionIcon action="history" /><span>Stock Changes</span></button><button type="button" className="primary-button compact count-button inventory-action-button" aria-label={`Stock Status${lowColors.length ? `, ${lowColors.length} colors low` : ", all colors stocked"}`} onClick={openLowStock}><InventoryActionIcon action="status" /><span>Stock Status</span></button></div></div>
      <section className="inventory-insights panel" aria-label="Inventory usage summary"><div className="insights-intro"><p className="eyebrow">Inventory summary</p><h3>Your bead usage</h3><p>Calculated from bead-use entries in Stock Changes.</p></div><div className="insight-stats"><div><strong>{totalBeadsUsed.toLocaleString()}</strong><span>Beads used</span></div><div className="on-hand-stat"><strong>{totalBeadsOnHand.toLocaleString()}</strong><span>Beads on hand</span></div><div><strong>{completedPieces.toLocaleString()}</strong><span>Completed pieces</span></div><div className="series-stat"><strong>{mostUsedSeries ? `${mostUsedSeries[0]} series` : "—"}</strong><span>{mostUsedSeries ? `Most-used series · ${mostUsedSeries[1].toLocaleString()}` : "No usage yet"}</span></div></div>{topUsedColors.length ? <div className="top-colors"><div className="top-colors-heading"><strong>Most-used colors</strong><span>Total beads across use entries</span></div>{topUsedColors.map(([code, count]) => { const color = paletteByCode.get(code); return <div className="usage-bar" key={code}><i className={code === "H1" ? "transparent-swatch" : ""} style={{ background: code === "H1" ? undefined : color?.hex }} /><b>{code}</b><span><i style={{ width: `${Math.max(8, count / topUsedColorCount * 100)}%` }} /></span><em>{count.toLocaleString()}</em></div>; })}</div> : <div className="insights-empty"><strong>No bead usage yet</strong><span>Use beads to see your most-used colors.</span></div>}</section>
      <div className="series-grid">{SERIES.map((series) => { const items = inventory.filter((item) => item.code.startsWith(series)); const low = items.filter((item) => item.isLow).length; return <button type="button" className={`series-tile ${low ? "series-low" : ""}`} key={series} onClick={() => setSelectedSeries(series)}><span className="series-tile-top"><strong>{series} series</strong><span>{items.length} {items.length === 1 ? "color" : "colors"}</span></span><span className="series-swatches" aria-hidden="true">{items.slice(0, 8).map((item) => <i key={item.code} style={{ background: item.hex }} />)}</span><span className="series-status">{low ? `${low} ${low === 1 ? "color" : "colors"} running low` : "All colors stocked"}<span aria-hidden="true">→</span></span></button>; })}</div>
    </section>}

    {view === "inventory" && selectedSeries && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setSelectedSeries(null); }}><section className="gallery-modal inventory-series-modal" role="dialog" aria-modal="true" aria-label={`${selectedSeries} series inventory`}><header><div><p className="eyebrow">Inventory</p><h2>{selectedSeries} series</h2><p>{SERIES_NAMES[selectedSeries]} · {visibleInventory.length} colors</p></div><button type="button" aria-label="Close series inventory" onClick={() => setSelectedSeries(null)}>×</button></header><div className="inventory-color-grid">{visibleInventory.map((item) => <InventoryTile key={item.code} item={item} onTemplates={() => setTemplateColorTarget(item)} onEdit={() => openInventoryEdit(item)} onDetails={() => setInventoryDetailTarget(item)} />)}</div></section></div>}

    {inventoryEditTarget && <div className="gallery-modal-backdrop inventory-submodal" onClick={(event) => { if (event.target === event.currentTarget && !busy) setInventoryEditTarget(null); }}><section className="gallery-modal compact-inventory-modal" role="dialog" aria-modal="true" aria-label={`Edit ${inventoryEditTarget.code} inventory`}><header><div><p className="eyebrow">Edit inventory</p><h2>{inventoryEditTarget.code}</h2></div><button type="button" aria-label="Close inventory editor" onClick={() => setInventoryEditTarget(null)} disabled={busy}>×</button></header><form onSubmit={saveInventoryEdit}><label className="inventory-edit-field">Beads on hand<input type="number" min="0" step="1" value={inventoryEditQuantity} onChange={(event) => setInventoryEditQuantity(Math.max(0, Math.floor(Number(event.target.value) || 0)))} /></label><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setInventoryEditTarget(null)} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div></form></section></div>}

    {inventoryDetailTarget && <div className="gallery-modal-backdrop inventory-submodal" onClick={(event) => { if (event.target === event.currentTarget) setInventoryDetailTarget(null); }}><section className="gallery-modal compact-inventory-modal" role="dialog" aria-modal="true" aria-label={`${inventoryDetailTarget.code} color details`}><header><div><p className="eyebrow">Color details</p><h2>{inventoryDetailTarget.code}</h2></div><button type="button" aria-label="Close color details" onClick={() => setInventoryDetailTarget(null)}>×</button></header><div className="color-detail-hero"><i className={inventoryDetailTarget.code === "H1" ? "transparent-swatch" : ""} style={{ background: inventoryDetailTarget.code === "H1" ? undefined : inventoryDetailTarget.hex }} /><div><strong>{inventoryDetailTarget.name}</strong><span>{inventoryDetailTarget.isLow ? "Low stock" : "Stocked"}</span></div></div><dl className="color-detail-list"><div><dt>MARD code</dt><dd>{inventoryDetailTarget.code}</dd></div><div><dt>COCO code</dt><dd>{COCO_BY_MARD[inventoryDetailTarget.code] ?? "Not listed"}</dd></div><div><dt>Screen color</dt><dd>{inventoryDetailTarget.hex.toUpperCase()}</dd></div><div><dt>Beads on hand</dt><dd>{inventoryDetailTarget.quantity.toLocaleString()}</dd></div></dl></section></div>}

    {templateColorTarget && <div className="gallery-modal-backdrop inventory-submodal" onClick={(event) => { if (event.target === event.currentTarget) setTemplateColorTarget(null); }}><section className="gallery-modal color-template-modal" role="dialog" aria-modal="true" aria-label={`Templates using ${templateColorTarget.code}`}><header><div><p className="eyebrow">Gallery</p><h2>Templates using {templateColorTarget.code}</h2><p>{templatesUsingColor.length} {templatesUsingColor.length === 1 ? "template uses" : "templates use"} this color.</p></div><button type="button" aria-label="Close template list" onClick={() => setTemplateColorTarget(null)}>×</button></header><div className="color-template-list">{templatesUsingColor.map((template) => { const count = template.cells.filter((code) => code === templateColorTarget.code).length; return <article key={template.id}><div><strong>{template.title}</strong><span>{template.width} × {template.height} · {count.toLocaleString()} {templateColorTarget.code} beads</span></div><button type="button" className="text-button" onClick={() => { setTemplateColorTarget(null); setSelectedSeries(null); setView("gallery"); }}>View in Gallery →</button></article>; })}{!templatesUsingColor.length && <p className="no-results">No Gallery templates currently use this color.</p>}</div></section></div>}

    {lowStockOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setLowStockOpen(false); }}><section className="gallery-modal low-stock-modal" role="dialog" aria-modal="true" aria-label="Low-stock review"><header><div><p className="eyebrow">Inventory</p><h2>Low-stock review</h2><p>{lowColors.length ? `${lowColors.length} colors are at or below the current threshold.` : "Every color is above the current threshold."}</p></div><button type="button" aria-label="Close low-stock review" onClick={() => setLowStockOpen(false)} disabled={busy}>×</button></header><form onSubmit={saveGlobalThreshold}><label className="global-threshold">Low-stock threshold for every color<input type="number" min="0" max="1000000" step="1" value={globalThreshold} onChange={(event) => setGlobalThreshold(Math.min(1_000_000, Math.max(0, Math.floor(Number(event.target.value) || 0))))} /><small>A color is marked low when its inventory is at or below this amount.</small></label><div className="low-stock-groups">{SERIES.map((series) => { const colors = lowColors.filter((item) => item.code.startsWith(series)); if (!colors.length) return null; return <section key={series}><header><strong>Series {series}</strong><span>{SERIES_NAMES[series]} · {colors.length} low</span></header><div>{colors.map((item) => <span key={item.code}><i className={item.code === "H1" ? "transparent-swatch" : ""} style={{ background: item.code === "H1" ? undefined : item.hex }} /><b>{item.code}</b><em>{item.quantity.toLocaleString()} on hand</em></span>)}</div></section>; })}{!lowColors.length && <p className="no-results">No colors are currently running low.</p>}</div><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setLowStockOpen(false)} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Apply"}</button></div></form></section></div>}

    {refillOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setRefillOpen(false); }}><section className="gallery-modal refill-modal" role="dialog" aria-modal="true" aria-label="Bead Refill"><header><div><p className="eyebrow">Inventory</p><h2>Bead Refill</h2><p>Choose full series or individual colors, then enter the refill amount.</p></div><button type="button" aria-label="Close bead refill" onClick={() => setRefillOpen(false)} disabled={busy}>×</button></header><form onSubmit={refillInventory}>
      <div className="refill-mode-switch" role="group" aria-label="Refill selection mode"><button type="button" aria-pressed={refillMode === "series"} className={refillMode === "series" ? "active" : ""} onClick={() => { setRefillMode("series"); setRefillSelected(new Set()); }}>By series</button><button type="button" aria-pressed={refillMode === "colors"} className={refillMode === "colors" ? "active" : ""} onClick={() => { setRefillMode("colors"); setRefillSelected(new Set()); }}>Individual colors</button></div>
      {refillMode === "series" ? <section className="refill-series-section"><div className="refill-section-heading"><div><strong>Select series</strong><span>Each selection refills every color in that series</span></div><div><button type="button" className="text-button" onClick={() => setRefillSelected(new Set(inventory.map((item) => item.code)))}>Select all</button><button type="button" className="text-button" onClick={() => setRefillSelected(new Set())}>Clear all</button></div></div><div className="refill-series-grid">{SERIES.map((series) => { const items = inventory.filter((item) => item.code.startsWith(series)); const selectedCount = items.filter((item) => refillSelected.has(item.code)).length; const status = selectedCount === items.length ? "selected" : selectedCount ? "partial" : ""; return <button type="button" aria-pressed={selectedCount === items.length} className={status} key={series} onClick={() => toggleRefillSeries(series)}><span><i aria-hidden="true">{selectedCount === items.length ? "✓" : selectedCount ? "−" : ""}</i><b>Series {series}</b><small>{SERIES_NAMES[series]}</small></span><span className="refill-series-swatches" aria-hidden="true">{items.filter((_, index) => index % Math.max(1, Math.floor(items.length / 6)) === 0).slice(0, 6).map((item) => <i key={item.code} style={{ background: item.hex }} />)}</span></button>; })}</div></section> : <section className="refill-individual-section"><div className="refill-color-series-tabs" aria-label="Color series">{SERIES.map((series) => <button type="button" className={refillSeries === series ? "active" : ""} key={series} onClick={() => { setRefillSeries(series); setRefillSearch(""); }}>{series}</button>)}</div><div className="refill-toolbar"><input value={refillSearch} onChange={(event) => setRefillSearch(event.target.value)} placeholder={`Find a ${refillSeries} series color`} aria-label="Find a refill color" /><button type="button" className="text-button" onClick={selectRefillSeries}>Select all in {refillSeries}</button><button type="button" className="text-button" onClick={clearRefillSeries}>Clear {refillSeries}</button></div><div className="refill-color-grid">{refillColors.map((item) => <label key={item.code} className={refillSelected.has(item.code) ? "selected" : ""}><input type="checkbox" checked={refillSelected.has(item.code)} onChange={() => toggleRefillColor(item.code)} /><i className={item.code === "H1" ? "transparent-swatch" : ""} style={{ background: item.code === "H1" ? undefined : item.hex }} /><span><b>{item.code}</b><small>{item.quantity.toLocaleString()} on hand</small></span></label>)}{refillColors.length === 0 && <p className="no-results">No colors match that search.</p>}</div></section>}
      <div className="refill-footer"><label>Beads Refilled<input type="number" min="1" max="1000000" step="1" value={refillAmount} onChange={(event) => setRefillAmount(Math.min(1_000_000, Math.max(1, Math.floor(Number(event.target.value) || 1))))} /></label><span><strong>{refillSelected.size}</strong> {refillSelected.size === 1 ? "color" : "colors"} selected</span></div><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setRefillOpen(false)} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || !refillSelected.size}>{busy ? "Updating…" : "Add"}</button></div></form></section></div>}

    {stockHistoryOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setStockHistoryOpen(false); }}><section className="gallery-modal stock-history-modal" role="dialog" aria-modal="true" aria-label="Recent stock changes"><header><div><p className="eyebrow">Inventory</p><h2>Recent Stock Changes</h2><p>Deleting a change reverses its effect on your current inventory.</p></div><button type="button" aria-label="Close stock changes" onClick={() => setStockHistoryOpen(false)} disabled={busy}>×</button></header><div className="stock-transaction-list">{stockTransactions.map((transaction) => { const total = Object.values(transaction.changes).reduce((sum, change) => sum + change, 0); const label = transaction.label.startsWith("Gallery template: ") ? `Use beads for artwork: ${transaction.label.slice("Gallery template: ".length)}` : transaction.label; return <article key={transaction.id} className={`stock-transaction ${transaction.type}`}><div className="stock-transaction-icon" aria-hidden="true">{transaction.type === "refill" ? "+" : transaction.type === "use" ? "−" : "±"}</div><div><strong>{label}</strong><span>{new Date(transaction.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div><div className="stock-transaction-total"><b>{total > 0 ? "+" : ""}{total.toLocaleString()}</b><span>beads</span></div><button type="button" className="stock-delete-button" aria-label={`Delete and reverse ${label}`} title="Delete and reverse this stock change" onClick={() => setStockDeleteTarget(transaction)} disabled={busy}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg></button></article>; })}{!stockTransactions.length && <div className="stock-history-empty"><strong>No stock changes yet</strong><span>Refills, bead usage, and manual inventory edits will appear here.</span></div>}</div></section></div>}
    {stockDeleteTarget && <div className="gallery-modal-backdrop inventory-submodal" onClick={(event) => { if (event.target === event.currentTarget && !busy) setStockDeleteTarget(null); }}><section className="gallery-modal compact-inventory-modal" role="alertdialog" aria-modal="true" aria-label="Confirm stock change deletion"><header><div><p className="eyebrow">Delete stock change</p><h2>Are you sure you would like to delete this stock change?</h2></div><button type="button" aria-label="Cancel stock change deletion" onClick={() => setStockDeleteTarget(null)} disabled={busy}>×</button></header><p className="stock-delete-warning">Deleting it will reverse its effect on your current inventory.</p><div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setStockDeleteTarget(null)} disabled={busy}>Cancel</button><button type="button" className="primary-button delete-confirm-button" onClick={() => void deleteStockTransaction(stockDeleteTarget)} disabled={busy}>{busy ? "Deleting…" : "Delete stock change"}</button></div></section></div>}

    {useOpen && <div className="gallery-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) setUseOpen(false); }}><section className="gallery-modal use-beads-modal" role="dialog" aria-modal="true" aria-label="Use Beads"><header><div><p className="eyebrow">Inventory</p><h2>Use Beads</h2><p>Deduct a complete Gallery template or choose individual bead colors.</p></div><button type="button" aria-label="Close use beads" onClick={() => setUseOpen(false)} disabled={busy}>×</button></header><form onSubmit={deductInventory}>
      <div className="refill-mode-switch" role="group" aria-label="Use beads method"><button type="button" aria-pressed={useMode === "template"} className={useMode === "template" ? "active" : ""} onClick={() => { setUseMode("template"); setUseSelected(new Set()); }}>Gallery template</button><button type="button" aria-pressed={useMode === "colors"} className={useMode === "colors" ? "active" : ""} onClick={() => { setUseMode("colors"); setUseSelected(new Set()); }}>Individual colors</button></div>
      {useMode === "template" ? <section className="use-template-section">
        <div><strong>Select a Gallery template</strong><span>The exact bead counts in that pattern will be deducted.</span></div>
        <input className="use-template-search" type="search" value={useTemplateSearch} onChange={(event) => { setUseTemplateSearch(event.target.value); setUseTemplatePage(0); setUseTemplateId(""); }} placeholder="Search Gallery templates" aria-label="Search Gallery templates" />
        <div className="use-template-grid">{shownUseTemplates.map((template) => { const usage = countBeads(template.cells); const beadCount = Object.values(usage).reduce((sum, count) => sum + count, 0); const unavailable = Object.entries(usage).some(([code, count]) => (inventory.find((item) => item.code === code)?.quantity ?? 0) < count); return <label key={template.id} className={`${useTemplateId === template.id ? "selected" : ""} ${unavailable ? "unavailable" : ""}`}><input type="radio" name="use-template" value={template.id} checked={useTemplateId === template.id} onChange={() => setUseTemplateId(template.id)} /><TemplateThumbnail template={template} /><span><b>{template.title}</b><small>{beadCount.toLocaleString()} beads · {Object.keys(usage).length} colors</small><em>{unavailable ? "Insufficient inventory" : "Ready to use"}</em></span></label>; })}{!matchingUseTemplates.length && <p className="no-results">{templates.length ? "No templates match that search." : "Add a Gallery template before using this option."}</p>}</div>
        <div className="use-template-pagination"><span>{matchingUseTemplates.length} {matchingUseTemplates.length === 1 ? "template" : "templates"}</span>{useTemplatePageCount > 1 && <div><button type="button" className="text-button" disabled={useTemplatePage === 0} onClick={() => setUseTemplatePage((page) => page - 1)}>Previous</button><span>Page {useTemplatePage + 1} of {useTemplatePageCount}</span><button type="button" className="text-button" disabled={useTemplatePage + 1 >= useTemplatePageCount} onClick={() => setUseTemplatePage((page) => page + 1)}>Next</button></div>}</div>
      </section> : <section className="refill-individual-section">
        <div className="refill-color-series-tabs" aria-label="Color series">{SERIES.map((series) => <button type="button" className={useSeries === series ? "active" : ""} key={series} onClick={() => { setUseSeries(series); setUseSearch(""); }}>{series}</button>)}</div>
        <div className="refill-toolbar"><input value={useSearch} onChange={(event) => setUseSearch(event.target.value)} placeholder={`Find a ${useSeries} series color`} aria-label="Find a color to use" /><button type="button" className="text-button" onClick={() => setUseSelected((current) => new Set([...current, ...inventory.filter((item) => item.code.startsWith(useSeries)).map((item) => item.code)]))}>Select all in {useSeries}</button><button type="button" className="text-button" onClick={() => setUseSelected(new Set())}>Clear all</button></div>
        <div className="refill-color-grid">{useColors.map((item) => <label key={item.code} className={useSelected.has(item.code) ? "selected" : ""}><input type="checkbox" checked={useSelected.has(item.code)} onChange={() => toggleUseColor(item.code)} /><i className={item.code === "H1" ? "transparent-swatch" : ""} style={{ background: item.code === "H1" ? undefined : item.hex }} /><span><b>{item.code}</b><small>{item.quantity.toLocaleString()} on hand</small></span></label>)}{useColors.length === 0 && <p className="no-results">No colors match that search.</p>}</div>
        <div className="use-selected-amounts"><div className="use-selected-heading"><strong>Beads to use by color</strong><span>{useSelected.size} {useSelected.size === 1 ? "color" : "colors"} selected</span></div>{useSelectedColors.length ? <div className="use-selected-grid">{useSelectedColors.map((item) => <label key={item.code} className="use-selected-item"><i className={item.code === "H1" ? "transparent-swatch" : ""} style={{ background: item.code === "H1" ? undefined : item.hex }} /><span><b>{item.code}</b><small>{item.quantity.toLocaleString()} on hand</small></span><input type="number" min="1" max={Math.min(item.quantity, 1_000_000)} step="1" value={useAmounts[item.code] ?? 1} onChange={(event) => setUseAmounts((current) => ({ ...current, [item.code]: Math.min(1_000_000, Math.max(1, Math.floor(Number(event.target.value) || 1))) }))} aria-label={`Beads to use for ${item.code}`} /></label>)}</div> : <p>Select colors above to enter a separate amount for each one.</p>}{useIndividualHasShortage && <p className="use-shortage">One or more amounts exceed the beads on hand.</p>}</div>
      </section>}
      <div className="gallery-modal-actions"><button type="button" className="secondary-button" onClick={() => setUseOpen(false)} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || (useMode === "template" ? !selectedUseTemplate || selectedUseTemplateHasShortage : !useSelected.size || useIndividualHasShortage)}>{busy ? "Updating…" : "Use beads"}</button></div></form></section></div>}
  </main>;
}

function InventoryTile({ item, onTemplates, onEdit, onDetails }: { item: Inventory; onTemplates: () => void; onEdit: () => void; onDetails: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const choose = (action: () => void) => { setMenuOpen(false); action(); };
  return <article className={`inventory-color-tile simple ${item.isLow ? "low" : ""}`}><i className={`inventory-tile-swatch ${item.code === "H1" ? "transparent-swatch" : ""}`} style={{ background: item.code === "H1" ? undefined : item.hex }} /><div className="inventory-color-summary"><b>{item.code}</b><strong>{item.quantity.toLocaleString()}</strong><span>beads on hand</span></div><span className="inventory-status">{item.isLow ? "Low stock" : "Stocked"}</span><div className="inventory-card-menu"><button type="button" className="icon-menu-button" aria-label={`More options for ${item.code}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>⋮</button>{menuOpen && <div role="menu"><button type="button" role="menuitem" onClick={() => choose(onTemplates)}>Gallery templates using {item.code}</button><button type="button" role="menuitem" onClick={() => choose(onEdit)}>Edit beads on hand</button><button type="button" role="menuitem" onClick={() => choose(onDetails)}>View full color details</button></div>}</div></article>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty-state"><div className="empty-beads">● ● ●</div><h3>{title}</h3><p>{text}</p></div>; }
export default App;
