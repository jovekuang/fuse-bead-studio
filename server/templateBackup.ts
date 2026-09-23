import { deflateSync } from "node:zlib";
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

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [number, number, number];
}

export function galleryBackupFilename(template: Pick<GalleryBackupTemplate, "id" | "title">): string {
  const title = template.title.trim().normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bead-template";
  return `${title}-${template.id}.png`;
}

export function renderGalleryBackupPng(template: GalleryBackupTemplate, palette: PaletteColor[]): Buffer {
  const cellSize = 10; const padding = 12;
  const width = template.width * cellSize + padding * 2;
  const height = template.height * cellSize + padding * 2;
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  const colors = new Map(palette.map((color) => [color.code, color]));
  const background: [number, number, number] = [255, 253, 248];
  const empty: [number, number, number] = [247, 243, 237];
  const grid: [number, number, number] = [196, 185, 173];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes; pixels[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      let color = background;
      const gridX = x - padding; const gridY = y - padding;
      if (gridX >= 0 && gridY >= 0 && gridX < template.width * cellSize && gridY < template.height * cellSize) {
        const column = Math.floor(gridX / cellSize); const row = Math.floor(gridY / cellSize);
        if (gridX % cellSize === 0 || gridY % cellSize === 0) color = grid;
        else {
          const code = template.cells[row * template.width + column]; const bead = code ? colors.get(code) : undefined;
          if (bead?.transparent) color = (Math.floor(gridX / 3) + Math.floor(gridY / 3)) % 2 ? [238, 238, 238] : [255, 255, 255];
          else color = bead ? rgb(bead.hex) : empty;
        }
      }
      const offset = rowStart + 1 + x * 4;
      pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const metadata = Buffer.from(JSON.stringify({ format: "fuse-bead-gallery-backup", version: 1, ...template }), "utf8");
  const internationalText = Buffer.concat([
    Buffer.from("fuse-bead-template\0", "ascii"),
    Buffer.from([0, 0, 0, 0]),
    metadata,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("iTXt", internationalText),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND"),
  ]);
}
