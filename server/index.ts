import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, PSM } from "tesseract.js";
import { PALETTE, PALETTE_CODES, countBeads } from "../shared/palette.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? path.join(projectRoot, "data");
const uploadDir = path.join(dataDir, "uploads");
const distDir = path.join(projectRoot, "dist");
await mkdir(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, "fuse-beads.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source_filename TEXT NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, cells_json TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'photo', content_cropped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inventory (
    code TEXT PRIMARY KEY, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
    low_threshold INTEGER NOT NULL DEFAULT 100 CHECK(low_threshold >= 0)
  );
  CREATE TABLE IF NOT EXISTS artworks (
    id TEXT PRIMARY KEY, template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
    template_title TEXT NOT NULL, photo_filename TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL,
    inventory_deducted INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inventory_transactions (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
    changes_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const templateColumns = db.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>;
if (!templateColumns.some((column) => column.name === "source_kind"))
  db.exec("ALTER TABLE templates ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'photo'");
if (!templateColumns.some((column) => column.name === "content_cropped"))
  db.exec("ALTER TABLE templates ADD COLUMN content_cropped INTEGER NOT NULL DEFAULT 0");
const artworkColumns = db.prepare("PRAGMA table_info(artworks)").all() as Array<{ name: string }>;
if (!artworkColumns.some((column) => column.name === "inventory_deducted"))
  db.exec("ALTER TABLE artworks ADD COLUMN inventory_deducted INTEGER NOT NULL DEFAULT 1");
const insertInventory = db.prepare("INSERT OR IGNORE INTO inventory (code) VALUES (?)");
for (const color of PALETTE) insertInventory.run(color.code);

// Migrate data saved with the original 20-color starter palette.
const legacyColors: Record<string, string> = {
  WHT: "#F7F5EB", CRM: "#EADCB8", TAN: "#C99B72", BRN: "#87543D", BLK: "#28292C",
  GRY: "#90949A", PNK: "#F6A7C3", RED: "#D94B4B", COR: "#EE8068", ORG: "#ED913F",
  YLW: "#F5D54B", LME: "#B7D85B", GRN: "#4E9D61", MNT: "#8BD8B6", TEA: "#3B9E9F",
  SKY: "#8DC9E8", BLU: "#477DBF", NAV: "#344D82", LAV: "#B8A4D9", PUR: "#805BA3",
};
const matchablePalette = PALETTE.filter((color) => !color.transparent && color.code !== "T1");
const nearestPaletteCode = (hex: string) => {
  if (hex === legacyColors.WHT) return "H2";
  if (hex === legacyColors.BLK) return "H7";
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return matchablePalette.reduce((best, color) => {
    const next = [1, 3, 5].map((start) => parseInt(color.hex.slice(start, start + 2), 16));
    const distance = next.reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0);
    return distance < best.distance ? { code: color.code, distance } : best;
  }, { code: "H2", distance: Infinity }).code;
};
const legacyMap = Object.fromEntries(Object.entries(legacyColors).map(([code, hex]) => [code, nearestPaletteCode(hex)]));
db.transaction(() => {
  for (const row of db.prepare("SELECT * FROM inventory").all() as InventoryRow[]) {
    if (PALETTE_CODES.has(row.code)) continue;
    const target = legacyMap[row.code];
    if (target) db.prepare("UPDATE inventory SET quantity = quantity + ?, low_threshold = MAX(low_threshold, ?) WHERE code = ?").run(row.quantity, row.low_threshold, target);
    db.prepare("DELETE FROM inventory WHERE code = ?").run(row.code);
  }
  for (const row of db.prepare("SELECT id, cells_json FROM templates").all() as Array<{ id: string; cells_json: string }>) {
    const cells = JSON.parse(row.cells_json) as Array<string | null>;
    if (cells.some((code) => code && legacyMap[code])) db.prepare("UPDATE templates SET cells_json = ? WHERE id = ?").run(JSON.stringify(cells.map((code) => code ? legacyMap[code] ?? code : null)), row.id);
  }
  for (const row of db.prepare("SELECT id, usage_json FROM artworks").all() as Array<{ id: string; usage_json: string }>) {
    const usage = JSON.parse(row.usage_json) as Record<string, number>; const migrated: Record<string, number> = {};
    for (const [code, count] of Object.entries(usage)) { const target = legacyMap[code] ?? code; migrated[target] = (migrated[target] ?? 0) + count; }
    if (Object.keys(usage).some((code) => legacyMap[code])) db.prepare("UPDATE artworks SET usage_json = ? WHERE id = ?").run(JSON.stringify(migrated), row.id);
  }
})();

// Preserve uploads made with the original gallery scaffold.
const hasLegacyPhotos = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photos'").get());
if (hasLegacyPhotos) db.exec(`
  INSERT OR IGNORE INTO artworks
    (id, template_id, template_title, photo_filename, caption, usage_json, created_at)
  SELECT id, NULL, 'Original gallery', filename, caption, '{}', created_at FROM photos
`);

type TemplateRow = { id: string; title: string; source_filename: string; source_kind: "photo" | "template" | "scratch"; width: number; height: number; cells_json: string; created_at: string; updated_at: string };
type ArtworkRow = { id: string; template_id: string | null; template_title: string; photo_filename: string; caption: string; usage_json: string; inventory_deducted: number; created_at: string };
type InventoryRow = { code: string; quantity: number; low_threshold: number };
type InventoryTransactionRow = { id: string; type: string; label: string; changes_json: string; created_at: string };
type Grid = { title: string; sourceKind: "photo" | "template" | "scratch"; width: number; height: number; cells: Array<string | null> };

const templateDto = (row: TemplateRow) => ({ id: row.id, title: row.title, sourceKind: row.source_kind, sourceUrl: `/uploads/${row.source_filename}`, width: row.width, height: row.height, cells: JSON.parse(row.cells_json) as Array<string | null>, createdAt: row.created_at, updatedAt: row.updated_at });
const artworkDto = (row: ArtworkRow) => ({ id: row.id, templateId: row.template_id, templateTitle: row.template_title, photoUrl: `/uploads/${row.photo_filename}`, caption: row.caption, usage: JSON.parse(row.usage_json) as Record<string, number>, inventoryDeducted: Boolean(row.inventory_deducted), createdAt: row.created_at });
const inventoryDto = (row: InventoryRow) => {
  const color = PALETTE.find((item) => item.code === row.code)!;
  return { ...color, quantity: row.quantity, lowThreshold: row.low_threshold, isLow: row.quantity <= row.low_threshold };
};
const transactionDto = (row: InventoryTransactionRow) => ({ id: row.id, type: row.type, label: row.label, changes: JSON.parse(row.changes_json) as Record<string, number>, createdAt: row.created_at });
const recordInventoryTransaction = (type: string, label: string, changes: Record<string, number>) => {
  if (!Object.values(changes).some(Boolean)) return;
  db.prepare("INSERT INTO inventory_transactions (id, type, label, changes_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), type, label.slice(0, 140), JSON.stringify(changes), new Date().toISOString());
};

function parseGrid(value: unknown): { grid: Grid | null; error: string | null } {
  if (!value || typeof value !== "object") return { grid: null, error: "Template data is missing." };
  const input = value as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const sourceKind = input.sourceKind === "template" || input.sourceKind === "scratch" ? input.sourceKind : "photo";
  const width = input.width; const height = input.height; const cells = input.cells;
  if (!title) return { grid: null, error: "Enter a template name." };
  if (title.length > 100) return { grid: null, error: "Template names must be 100 characters or fewer." };
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 4 || (width as number) > 128 || (height as number) < 4 || (height as number) > 128)
    return { grid: null, error: "Template dimensions must be whole numbers from 4 to 128." };
  if (!Array.isArray(cells)) return { grid: null, error: "Template cell data is missing." };
  const expectedCells = (width as number) * (height as number);
  if (cells.length !== expectedCells)
    return { grid: null, error: `This ${width} × ${height} template needs ${expectedCells.toLocaleString()} cells, but received ${cells.length.toLocaleString()}.` };
  const invalidCodes = [...new Set(cells.filter((cell): cell is string => cell !== null && (typeof cell !== "string" || !PALETTE_CODES.has(cell))).map(String))];
  if (invalidCodes.length)
    return { grid: null, error: `Template contains unrecognized bead ${invalidCodes.length === 1 ? "color" : "colors"}: ${invalidCodes.slice(0, 5).join(", ")}.` };
  return { grid: { title, sourceKind, width: width as number, height: height as number, cells }, error: null };
}
function formText(value: unknown): string {
  if (!value || typeof value !== "object" || !("value" in value)) return "";
  return String(value.value);
}
const imageExtensions: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif" };

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const app = Fastify({ logger: true, bodyLimit: 28 * 1024 * 1024 });
await app.register(multipart, {
  limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
  // Let each upload route return a useful, product-specific message instead
  // of Fastify's generic "request file too large" response.
  throwFileSizeLimit: false,
});
await app.register(fastifyStatic, { root: uploadDir, prefix: "/uploads/", decorateReply: true });
app.get("/api/health", async () => ({ ok: true }));
app.get("/api/palette", async () => PALETTE);

let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker("eng", 1, {
    langPath: path.join(projectRoot, "node_modules", "@tesseract.js-data", "eng", "4.0.0"),
    cacheMethod: "none",
  });
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: "ABCDEFGHMPRQTY0123456789",
  });
  return ocrWorker;
}

app.post("/api/ocr-template", async (request, reply) => {
  const part = await request.file();
  if (!part || part.mimetype !== "image/png") {
    part?.file.resume();
    return reply.code(415).send({ message: "Template analysis requires a PNG label sheet." });
  }
  const image = await part.toBuffer();
  if (part.file.truncated) return reply.code(413).send({ message: "Template image must be 25 MB or smaller." });
  const worker = await getOcrWorker();
  const query = request.query as { mode?: string; kind?: string }; const lineMode = query.mode === "line"; const characterMode = query.mode === "char";
  await worker.setParameters({
    tessedit_pageseg_mode: characterMode ? PSM.SINGLE_CHAR : lineMode ? PSM.SINGLE_LINE : PSM.SPARSE_TEXT,
    tessedit_char_whitelist: characterMode ? query.kind === "letter" ? "ABCDEFGHMPRQTY" : "0123456789" : "ABCDEFGHMPRQTYXx0123456789×|",
  });
  const result = await worker.recognize(image, {}, { tsv: true });
  const words = (result.data.tsv ?? "").split("\n").flatMap((line) => {
    const fields = line.split("\t");
    if (fields[0] !== "5" || !fields[11]?.trim()) return [];
    return [{
      text: fields[11].trim(), left: Number(fields[6]), top: Number(fields[7]),
      width: Number(fields[8]), height: Number(fields[9]), confidence: Number(fields[10]),
    }];
  });
  return { words, text: result.data.text ?? "" };
});

app.get("/api/templates", async () => (db.prepare("SELECT * FROM templates ORDER BY updated_at DESC").all() as TemplateRow[]).map(templateDto));
app.post("/api/templates", async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ message: "Choose a source picture." });
  const extension = imageExtensions[part.mimetype];
  if (!extension) { part.file.resume(); return reply.code(415).send({ message: "Unsupported image type." }); }
  const id = randomUUID(); const filename = `${id}${extension}`; const destination = path.join(uploadDir, filename);
  try { await pipeline(part.file, createWriteStream(destination)); }
  catch (error) { await unlink(destination).catch(() => undefined); throw error; }
  if (part.file.truncated) { await unlink(destination).catch(() => undefined); return reply.code(413).send({ message: "Picture must be 25 MB or smaller." }); }
  let parsed: ReturnType<typeof parseGrid>;
  try { parsed = parseGrid(JSON.parse(formText(part.fields.grid))); }
  catch { parsed = { grid: null, error: "Template data could not be read." }; }
  if (!parsed.grid) { await unlink(destination).catch(() => undefined); return reply.code(400).send({ message: parsed.error }); }
  const grid = parsed.grid;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO templates (id, title, source_filename, source_kind, width, height, cells_json, content_cropped, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").run(id, grid.title, filename, grid.sourceKind, grid.width, grid.height, JSON.stringify(grid.cells), now, now);
  return reply.code(201).send(templateDto(db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow));
});
app.put<{ Params: { id: string }; Body: unknown }>("/api/templates/:id", async (request, reply) => {
  const parsed = parseGrid(request.body);
  if (!parsed.grid) return reply.code(400).send({ message: parsed.error });
  const grid = parsed.grid;
  const result = db.prepare("UPDATE templates SET title = ?, width = ?, height = ?, cells_json = ?, updated_at = ? WHERE id = ?").run(grid.title, grid.width, grid.height, JSON.stringify(grid.cells), new Date().toISOString(), request.params.id);
  if (!result.changes) return reply.code(404).send({ message: "Template not found." });
  return templateDto(db.prepare("SELECT * FROM templates WHERE id = ?").get(request.params.id) as TemplateRow);
});
app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
  const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(request.params.id) as TemplateRow | undefined;
  if (!row) return reply.code(404).send({ message: "Template not found." });
  if (db.prepare("SELECT 1 FROM artworks WHERE template_id = ? LIMIT 1").get(row.id)) return reply.code(409).send({ message: "This template has completed artwork and cannot be removed." });
  db.prepare("DELETE FROM templates WHERE id = ?").run(row.id);
  await unlink(path.join(uploadDir, row.source_filename)).catch(() => undefined);
  return reply.code(204).send();
});

app.get("/api/inventory", async () => (db.prepare("SELECT * FROM inventory").all() as InventoryRow[])
  .sort((a, b) => PALETTE.findIndex((color) => color.code === a.code) - PALETTE.findIndex((color) => color.code === b.code)).map(inventoryDto));
app.put<{ Body: { lowThreshold?: unknown } }>("/api/inventory/threshold", async (request, reply) => {
  const lowThreshold = request.body?.lowThreshold;
  if (!Number.isSafeInteger(lowThreshold) || (lowThreshold as number) < 0 || (lowThreshold as number) > 1_000_000)
    return reply.code(400).send({ message: "Enter a low-stock threshold from 0 to 1,000,000." });
  db.prepare("UPDATE inventory SET low_threshold = ?").run(lowThreshold);
  return (db.prepare("SELECT * FROM inventory").all() as InventoryRow[])
    .sort((a, b) => PALETTE.findIndex((color) => color.code === a.code) - PALETTE.findIndex((color) => color.code === b.code)).map(inventoryDto);
});
app.put<{ Params: { code: string }; Body: { quantity?: unknown; lowThreshold?: unknown } }>("/api/inventory/:code", async (request, reply) => {
  if (!PALETTE_CODES.has(request.params.code)) return reply.code(404).send({ message: "Unknown bead color." });
  const { quantity, lowThreshold } = request.body ?? {};
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 0 || !Number.isSafeInteger(lowThreshold) || (lowThreshold as number) < 0) return reply.code(400).send({ message: "Enter nonnegative whole numbers." });
  const current = db.prepare("SELECT * FROM inventory WHERE code = ?").get(request.params.code) as InventoryRow;
  db.transaction(() => {
    db.prepare("UPDATE inventory SET quantity = ?, low_threshold = ? WHERE code = ?").run(quantity, lowThreshold, request.params.code);
    recordInventoryTransaction("adjustment", `Updated ${request.params.code} beads on hand`, { [request.params.code]: (quantity as number) - current.quantity });
  })();
  return inventoryDto(db.prepare("SELECT * FROM inventory WHERE code = ?").get(request.params.code) as InventoryRow);
});
app.post<{ Body: unknown }>("/api/inventory/refill", async (request, reply) => {
  const input = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const codes = Array.isArray(input.codes) ? [...new Set(input.codes)] : [];
  const amount = input.amount;
  if (!codes.length || codes.length > PALETTE.length || !codes.every((code) => typeof code === "string" && PALETTE_CODES.has(code)) ||
      !Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 1_000_000)
    return reply.code(400).send({ message: "Choose valid colors and enter a refill amount from 1 to 1,000,000." });
  db.transaction(() => {
    for (const code of codes as string[]) db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE code = ?").run(amount, code);
    recordInventoryTransaction("refill", `Refilled ${(codes as string[]).length} ${(codes as string[]).length === 1 ? "color" : "colors"}`, Object.fromEntries((codes as string[]).map((code) => [code, amount as number])));
  })();
  return (codes as string[]).map((code) => inventoryDto(db.prepare("SELECT * FROM inventory WHERE code = ?").get(code) as InventoryRow));
});
app.post<{ Body: unknown }>("/api/inventory/use", async (request, reply) => {
  const input = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
  const requestedUsage = input.usage && typeof input.usage === "object" && !Array.isArray(input.usage) ? input.usage as Record<string, unknown> : null;
  const codes = Array.isArray(input.codes) ? [...new Set(input.codes)] : [];
  const amount = input.amount;
  const usage: Record<string, number> = requestedUsage
    ? Object.fromEntries(Object.entries(requestedUsage).filter(([code, count]) => PALETTE_CODES.has(code) && Number.isSafeInteger(count) && (count as number) > 0 && (count as number) <= 1_000_000)) as Record<string, number>
    : Object.fromEntries(codes.map((code) => [code, amount])) as Record<string, number>;
  if (!Object.keys(usage).length || Object.keys(usage).length > PALETTE.length ||
      (requestedUsage ? Object.keys(usage).length !== Object.keys(requestedUsage).length : !codes.every((code) => typeof code === "string" && PALETTE_CODES.has(code)) || !Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 1_000_000))
    return reply.code(400).send({ message: "Choose valid colors and enter bead amounts from 1 to 1,000,000." });
  const usedCodes = Object.keys(usage);
  const shortages = usedCodes.flatMap((code) => {
    const row = db.prepare("SELECT quantity FROM inventory WHERE code = ?").get(code) as Pick<InventoryRow, "quantity">;
    return row.quantity < usage[code] ? [{ code, needed: usage[code], available: row.quantity }] : [];
  });
  if (shortages.length) return reply.code(409).send({ message: "There are not enough beads for this update.", shortages });
  db.transaction(() => {
    for (const code of usedCodes) db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE code = ?").run(usage[code], code);
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : `Used beads from ${usedCodes.length} ${usedCodes.length === 1 ? "color" : "colors"}`;
    recordInventoryTransaction("use", label, Object.fromEntries(usedCodes.map((code) => [code, -usage[code]])));
  })();
  return usedCodes.map((code) => inventoryDto(db.prepare("SELECT * FROM inventory WHERE code = ?").get(code) as InventoryRow));
});

app.get("/api/inventory/transactions", async () => (db.prepare("SELECT * FROM inventory_transactions ORDER BY created_at DESC LIMIT 50").all() as InventoryTransactionRow[]).map(transactionDto));
app.delete<{ Params: { id: string } }>("/api/inventory/transactions/:id", async (request, reply) => {
  const row = db.prepare("SELECT * FROM inventory_transactions WHERE id = ?").get(request.params.id) as InventoryTransactionRow | undefined;
  if (!row) return reply.code(404).send({ message: "Stock change not found." });
  const changes = JSON.parse(row.changes_json) as Record<string, number>;
  const impossible = Object.entries(changes).flatMap(([code, change]) => {
    const current = db.prepare("SELECT quantity FROM inventory WHERE code = ?").get(code) as Pick<InventoryRow, "quantity"> | undefined;
    return !current || current.quantity - change < 0 ? [code] : [];
  });
  if (impossible.length) return reply.code(409).send({ message: `This change cannot be reversed because ${impossible.join(", ")} no longer has enough beads.` });
  db.transaction(() => {
    for (const [code, change] of Object.entries(changes)) db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE code = ?").run(change, code);
    db.prepare("DELETE FROM inventory_transactions WHERE id = ?").run(row.id);
  })();
  return reply.code(204).send();
});

app.get("/api/artworks", async () => (db.prepare("SELECT * FROM artworks ORDER BY created_at DESC").all() as ArtworkRow[]).map(artworkDto));
app.post("/api/artworks", async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ message: "Choose a completed-artwork photo." });
  const extension = imageExtensions[part.mimetype];
  if (!extension) { part.file.resume(); return reply.code(415).send({ message: "Unsupported image type." }); }
  const id = randomUUID(); const filename = `${id}${extension}`; const destination = path.join(uploadDir, filename);
  try { await pipeline(part.file, createWriteStream(destination)); }
  catch (error) { await unlink(destination).catch(() => undefined); throw error; }
  if (part.file.truncated) { await unlink(destination).catch(() => undefined); return reply.code(413).send({ message: "Photo must be 25 MB or smaller." }); }
  const templateId = formText(part.fields.templateId); const caption = formText(part.fields.caption).trim().slice(0, 200);
  const template = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId) as TemplateRow | undefined;
  if (!template) { await unlink(destination).catch(() => undefined); return reply.code(404).send({ message: "Choose a saved template." }); }
  const usage = countBeads(JSON.parse(template.cells_json) as Array<string | null>);
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO artworks (id, template_id, template_title, photo_filename, caption, usage_json, inventory_deducted, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)").run(id, template.id, template.title, filename, caption, JSON.stringify(usage), new Date().toISOString());
    })();
  } catch (error) { await unlink(destination).catch(() => undefined); throw error; }
  return reply.code(201).send(artworkDto(db.prepare("SELECT * FROM artworks WHERE id = ?").get(id) as ArtworkRow));
});
app.delete<{ Params: { id: string } }>("/api/artworks/:id", async (request, reply) => {
  const row = db.prepare("SELECT * FROM artworks WHERE id = ?").get(request.params.id) as ArtworkRow | undefined;
  if (!row) return reply.code(404).send({ message: "Artwork not found." });
  const usage = JSON.parse(row.usage_json) as Record<string, number>;
  db.transaction(() => {
    if (row.inventory_deducted) for (const [code, used] of Object.entries(usage)) db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE code = ?").run(used, code);
    db.prepare("DELETE FROM artworks WHERE id = ?").run(row.id);
    if (hasLegacyPhotos) db.prepare("DELETE FROM photos WHERE id = ?").run(row.id);
  })();
  await unlink(path.join(uploadDir, row.photo_filename)).catch(() => undefined);
  return reply.code(204).send();
});

if (process.env.NODE_ENV === "production") {
  await app.register(fastifyStatic, { root: distDir, prefix: "/", decorateReply: false });
  app.setNotFoundHandler((request, reply) => request.method === "GET" && request.headers.accept?.includes("text/html") ? reply.sendFile("index.html", distDir) : reply.code(404).send({ message: "Not found." }));
}
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
const close = async () => { await app.close(); if (ocrWorker) await ocrWorker.terminate(); db.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
