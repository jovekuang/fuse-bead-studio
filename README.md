# 拼豆Pro

A private, home-network fuse bead studio built with Vite, React, Fastify, and SQLite.

It converts pictures into labeled pixel templates, lets you paint and edit the grid,
tracks completed artwork, and deducts the template's bead counts from inventory.
The built-in palette follows the supplied **2.6 mm fusion bead 264-color chart**,
including its A–H, M, P, R, Y, Q, and T series labels. Hex colors were sampled from
the photographed swatches and are therefore screen approximations. `H1` is treated
as transparent, `H2` as white, `H7` as black, and `T1` as glow in the dark.

The app has four main pages:

- **Home** features recent templates converted from photos and summarizes the collection.
- **Upload** creates a template from a photo, ingests an existing pattern, or starts with a blank bead board.
- **Gallery** displays every template as a tile, using its latest completed-artwork
  photo when available and a generated template thumbnail otherwise.
- **Inventory** groups colors into series tiles with stock summaries. Opening a
  series shows quantity and low-stock controls for each color. Bead Refill can
  add stock to individual colors or a whole series, and usage insights rank the
  colors and series consumed by completed artwork.

Template creation has three modes:

- **Photo or picture** pixelates an image to Small (26 × 26), Medium (52 × 52),
  Large (104 × 104), or a custom 4–128 bead width and length. The editor shows
  the uploaded picture and editable labeled grid side by side.
- **Existing template** detects a 4–128 cell grid and reads the color codes printed
  in occupied cells with local OCR. It never sends the template to an online OCR
  service. The untouched source sheet, including any material legend, remains
  visible above the editable grid for reference.
- **Draw from scratch** opens a blank Small, Medium, Large, or custom bead board.

The editor includes zoom controls, brush, bucket fill, eraser, and eyedropper tools.
Its color picker groups the full palette by series, and the bar below the board
summarizes every color and bead count currently used in the template.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Other devices on the same Wi-Fi can use the network URL printed by Vite.

Photos and the SQLite database are stored in the directory configured by
`app.config.json`. Copy `app.config.example.json` to `app.config.json` and set
`dataDirectory` to either an absolute path or a path relative to the project root.
The local config is excluded from Git because it can contain a machine-specific path.
If the config is absent, the app uses `data/`. The `DATA_DIR` environment variable
can override both locations. Uploaded images are stored in `uploads/`. Each exported
template PNG is also saved in `downloads/` with a unique timestamped filename while
the browser receives its normal download. Inventory starts at zero with a default
low-stock threshold of 100 beads per color.

## Production

```bash
npm run build
npm start
```

The production app listens on port `3001` by default. Set `PORT` to change it.
