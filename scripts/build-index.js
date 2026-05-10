// scripts/build-index.js
// Lee data/stock.csv (descargado por sync-stock.js) y genera:
//   data/meta.json                      → catálogos para selectores (≈ 24 KB / 8 KB gz)
//   data/index/all.json                 → índice global (≈ 28 MB / 3.3 MB gz)
//   data/familias/<slug>.json           → fichas completas por familia (carga bajo demanda)
//
// Diseñado para que GitHub Pages lo sirva gzip por defecto.

const fs   = require("fs");
const path = require("path");

const SRC = path.join(process.cwd(), "data", "stock.csv");
const OUT_FAM = path.join(process.cwd(), "data", "familias");
const OUT_IDX = path.join(process.cwd(), "data", "index");

if (!fs.existsSync(SRC)) {
  console.error(`No existe ${SRC}. ¿Se ha ejecutado sync-stock primero?`);
  process.exit(1);
}

fs.mkdirSync(OUT_FAM, { recursive: true });
fs.mkdirSync(OUT_IDX, { recursive: true });

// ---------- utilidades ----------
function slug(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "otros";
}

function toInt(x) {
  const n = parseInt(String(x ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function toPrice(x) {
  // El CSV viene en formato español: "2.700,00" (punto miles, coma decimales).
  // Hay que quitar los puntos antes de cambiar la coma por punto decimal.
  const s = String(x ?? "").trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Parser CSV con separador ';' que respeta comillas
function parseCSV(text, sep = ";") {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  return { header: rows.shift().map(h => h.trim()), rows };
}

// ---------- lectura ----------
console.log("Leyendo CSV…");
const text = fs.readFileSync(SRC, "utf-8");
const { header, rows } = parseCSV(text);
console.log(`  Filas crudas: ${rows.length.toLocaleString("es-ES")}`);
console.log(`  Cabeceras: ${header.join(", ")}`);

const col = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ["refid","familia","articulo","marca","modelo","modeloinicio","modelofin",
              "motorversion","precio","notapublica","refvisual","refcatalogo","imgs"];
for (const k of need) {
  if (!(k in col)) console.warn(`  AVISO: falta columna '${k}' en el CSV`);
}

// ---------- normalización ----------
const families = new Map();        // familia → array de piezas (ficha completa)
const indexAll = [];               // índice global ligero
const brandsModels = new Map();    // marca → Set(modelos)
let yearMin = Infinity, yearMax = -Infinity;
let skipped = 0, withImg = 0;

for (const r of rows) {
  const refid = (r[col.refid] || "").trim();
  if (!refid) { skipped++; continue; }

  let familia = ((r[col.familia] || "GENERICO").trim()).toUpperCase();
  if (familia === "GENÉRICO") familia = "GENERICO"; // unificar

  const articulo = (r[col.articulo] || "").trim();
  const marca    = (r[col.marca] || "").trim().toUpperCase();
  const modelo   = (r[col.modelo] || "").trim();
  const y0 = toInt(r[col.modeloinicio]);
  const y1 = toInt(r[col.modelofin]);
  const motor = (r[col.motorversion] || "").trim();
  const precio = toPrice(r[col.precio]);
  const nota   = (r[col.notapublica] || "").trim();
  const rv     = (r[col.refvisual] || "").trim();
  const rc     = (r[col.refcatalogo] || "").trim();
  const imgsRaw = (r[col.imgs] || "").trim();
  const imgs = imgsRaw
    ? imgsRaw.split(",").map(s => s.trim()).filter(s => /^https?:\/\//.test(s))
    : [];
  // Política: solo se publican piezas con al menos una foto.
  if (!imgs.length) { skipped++; continue; }
  withImg++;

  // Pieza completa para el JSON de familia (claves cortas → menos peso)
  const pieza = {
    id: refid,
    art: articulo,
    ma: marca,
    mo: modelo,
    y0, y1,
    mt: motor || undefined,
    p: precio,
    im: imgs,
    n: nota || undefined,
    rv: rv || undefined,
    rc: rc || undefined,
  };
  if (!families.has(familia)) families.set(familia, []);
  families.get(familia).push(pieza);

  // Entrada del índice como ARRAY posicional (ahorra ~30% vs objetos):
  // [id, familia, marca, modelo, y0, y1, precio, hasImg, articulo, textoBusqueda]
  const txt = `${articulo} ${marca} ${modelo} ${motor}`.toLowerCase();
  indexAll.push([
    refid,
    familia,
    marca,
    modelo,
    y0,
    y1,
    precio,
    imgs.length ? 1 : 0,
    articulo,
    txt,
  ]);

  if (marca) {
    if (!brandsModels.has(marca)) brandsModels.set(marca, new Set());
    if (modelo) brandsModels.get(marca).add(modelo);
  }
  if (y0 != null && y0 >= 1950 && y0 <= 2035) { if (y0 < yearMin) yearMin = y0; if (y0 > yearMax) yearMax = y0; }
  if (y1 != null && y1 >= 1950 && y1 <= 2035) { if (y1 < yearMin) yearMin = y1; if (y1 > yearMax) yearMax = y1; }
}

console.log(`  Procesadas: ${indexAll.length.toLocaleString("es-ES")}  (saltadas ${skipped.toLocaleString("es-ES")} sin foto)`);
console.log(`  Con imagen: ${withImg.toLocaleString("es-ES")} (100% — política: solo piezas con foto)`);

// ---------- volcado ----------
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj));
  return fs.statSync(p).size;
}

// 1) Familias
console.log("\nGenerando JSONs por familia:");
const familyCounts = {};
let totalFam = 0;
// Vaciar el dir previo para que no queden familias obsoletas
for (const f of fs.readdirSync(OUT_FAM)) fs.unlinkSync(path.join(OUT_FAM, f));
for (const [fam, items] of [...families.entries()].sort()) {
  const fname = `${slug(fam)}.json`;
  const size = writeJSON(path.join(OUT_FAM, fname), items);
  familyCounts[fam] = items.length;
  totalFam += size;
  console.log(`  ${fam.padEnd(28)} ${String(items.length).padStart(6)}  ${(size/1024/1024).toFixed(2)} MB`);
}
console.log(`  Total: ${(totalFam/1024/1024).toFixed(1)} MB (sin gzip)`);

// 2) Índice global (formato compacto: arrays + tabla de marcas/familias para deduplicar)
console.log("\nGenerando índice global…");
// Construir tablas de búsqueda inversa
const familyList = [...families.keys()].sort();
const familyIdx = Object.fromEntries(familyList.map((f, i) => [f, i]));
const brandList = [...brandsModels.keys()].sort();
const brandIdx = Object.fromEntries(brandList.map((b, i) => [b, i]));

// Reemplazar familia y marca por su índice en cada entrada
const indexCompact = indexAll.map(row => {
  // [id, familia, marca, modelo, y0, y1, p, h, t]
  row[1] = familyIdx[row[1]] ?? -1;
  row[2] = brandIdx[row[2]] ?? -1;
  return row;
});

const indexPayload = {
  // Esquema de columnas para que el cliente sepa interpretar los arrays
  cols: ["id", "fIdx", "maIdx", "mo", "y0", "y1", "p", "h", "art", "t"],
  families: familyList,
  brands: brandList,
  rows: indexCompact,
};
const idxSize = writeJSON(path.join(OUT_IDX, "all.json"), indexPayload);
console.log(`  data/index/all.json: ${(idxSize/1024/1024).toFixed(2)} MB (~${(idxSize/1024/1024/8).toFixed(2)} MB gzip estimado)`);

// 3) Meta
console.log("\nGenerando meta…");
const meta = {
  total: indexAll.length,
  families: [...families.keys()].sort(),
  familyCounts,
  brands: [...brandsModels.keys()].sort(),
  modelsByBrand: Object.fromEntries(
    [...brandsModels.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([b, set]) => [b, [...set].sort()])
  ),
  yearMin: Number.isFinite(yearMin) ? yearMin : null,
  yearMax: Number.isFinite(yearMax) ? yearMax : null,
  updated: new Date().toISOString(),
};
const metaSize = writeJSON(path.join(process.cwd(), "data", "meta.json"), meta);
console.log(`  data/meta.json: ${(metaSize/1024).toFixed(1)} KB`);
console.log(`  Marcas: ${meta.brands.length}, Modelos: ${Object.values(meta.modelsByBrand).reduce((a,b)=>a+b.length,0)}, Años: ${meta.yearMin}-${meta.yearMax}`);

console.log("\n✓ Index build completo.");
