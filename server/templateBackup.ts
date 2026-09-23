import { createCanvas } from "@napi-rs/canvas";
import type { PaletteColor } from "../shared/palette.js";

export type GalleryBackupTemplate = {
  id: string;
  title: string;
  sourceKind: "photo" | "template" | "scratch";
  width: number;
  height: number;
  cells: Array<string | null>;
  tags: string[];
  updatedAt: string;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function labelColor(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16); const green = Number.parseInt(hex.slice(3, 5), 16); const blue = Number.parseInt(hex.slice(5, 7), 16);
  return red * .299 + green * .587 + blue * .114 > 165 ? "#342f2b" : "white";
}

export function galleryBackupFilename(template: Pick<GalleryBackupTemplate, "id" | "title">): string {
  const title = template.title.trim().normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bead-template";
  return `${title}-${template.id}.png`;
}

export function renderGalleryBackupPng(template: GalleryBackupTemplate, palette: PaletteColor[]): Buffer {
  const cellSize = 28; const margin = 36; const header = 94; const legendTop = 62;
  const colors = new Map(palette.map((color) => [color.code, color]));
  const usage: Record<string, number> = {};
  for (const code of template.cells) if (code) usage[code] = (usage[code] ?? 0) + 1;
  const usedColors = Object.entries(usage).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
  const columns = Math.max(1, Math.min(5, Math.floor((template.width * cellSize + margin * 2) / 150)));
  const canvas = createCanvas(Math.max(760, template.width * cellSize + margin * 2), header + template.height * cellSize + legendTop + Math.ceil(usedColors.length / columns) * 38 + margin);
  const context = canvas.getContext("2d"); const gridLeft = Math.floor((canvas.width - template.width * cellSize) / 2);
  context.fillStyle = "#fffdf8"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#342f2b"; context.font = "bold 30px Georgia, serif";
  context.fillText(template.title, margin, 47, canvas.width - margin * 2);
  context.font = "15px Arial, sans-serif";
  context.fillText(`${template.width} × ${template.height} beads · ${Object.values(usage).reduce((sum, value) => sum + value, 0)} beads total`, margin, 75);
  template.cells.forEach((code, index) => {
    const x = gridLeft + index % template.width * cellSize; const y = header + Math.floor(index / template.width) * cellSize;
    const color = code ? colors.get(code) : undefined;
    context.fillStyle = color?.transparent ? "#e5e1dc" : color?.hex ?? "#fffdf8"; context.fillRect(x, y, cellSize, cellSize);
    context.strokeStyle = "#c4b9ad"; context.lineWidth = .7; context.strokeRect(x + .35, y + .35, cellSize - .7, cellSize - .7);
    if (code) {
      context.fillStyle = labelColor(color?.hex ?? "#fffdf8"); context.font = "bold 10px Arial, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(code, x + cellSize / 2, y + cellSize / 2);
    }
  });
  context.textAlign = "left"; context.textBaseline = "alphabetic";
  const legendY = header + template.height * cellSize + 35;
  context.fillStyle = "#342f2b"; context.font = "bold 18px Arial, sans-serif"; context.fillText("Colors used", margin, legendY);
  usedColors.forEach(([code, count], index) => {
    const color = colors.get(code); const x = margin + index % columns * 150; const y = legendY + 24 + Math.floor(index / columns) * 38;
    context.fillStyle = color?.hex ?? "#fffdf8"; context.fillRect(x, y, 24, 24);
    context.strokeStyle = "#bcb3aa"; context.strokeRect(x + .5, y + .5, 23, 23);
    context.fillStyle = "#342f2b"; context.font = "bold 13px Arial, sans-serif"; context.fillText(code, x + 32, y + 17);
    context.font = "13px Arial, sans-serif"; context.fillText(`× ${count}`, x + 72, y + 17);
  });
  const metadata = Buffer.from(JSON.stringify({ format: "fuse-bead-gallery-backup", version: 1, ...template }), "utf8");
  const internationalText = Buffer.concat([
    Buffer.from("fuse-bead-template\0", "ascii"),
    Buffer.from([0, 0, 0, 0]),
    metadata,
  ]);
  const png = canvas.toBuffer("image/png"); let insertion = 8;
  while (insertion + 12 <= png.length) {
    const length = png.readUInt32BE(insertion); const type = png.toString("ascii", insertion + 4, insertion + 8);
    if (type === "IDAT") break;
    insertion += length + 12;
  }
  return Buffer.concat([png.subarray(0, insertion), pngChunk("iTXt", internationalText), png.subarray(insertion)]);
}
