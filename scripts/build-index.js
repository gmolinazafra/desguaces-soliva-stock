// scripts/build-index.js
// Lee data/stock.csv (piezas) y data/vehiculos.csv (vehículos de origen),
// ambos descargados por sync-stock.js, y genera:
//   data/meta.json                      → catálogos para selectores (≈ 24 KB / 8 KB gz)
//   data/index/all.json                 → índice global (≈ 28 MB / 3.3 MB gz)
//   data/familias/<slug>.json           → fichas completas por familia (carga bajo demanda)
//   data/vehiculos.json                 → vehículos de origen indexados por codvehiculo
//                                         (carga bajo demanda al abrir una ficha)
//
// Cada pieza con vehículo de origen guarda su 'cv' (codvehiculo). El front lo
// usa para mostrar el bloque "Vehículo de origen" en la ficha, igual que en
// Red Desguace (tabla vehiculos aparte, bastidor anonimizado a 10 caracteres).
//
// Diseñado para que GitHub Pages lo sirva gzip por defecto.

const fs   = require("fs");
const path = require("path");

const SRC     = path.join(process.cwd(), "data", "stock.csv");
const SRC_VEH = path.join(process.cwd(), "data", "vehiculos.csv");
const OUT_FAM = path.join(process.cwd(), "data", "familias");
const OUT_IDX = path.join(process.cwd(), "data", "index");

if (!fs.existsSync(SRC)) {
  console.error(`No existe ${SRC}. ¿Se ha ejecutado sync-stock primero?`);
  process.exit(1);
}

fs.mkdirSync(OUT_FAM, { recursive: true });
fs.mkdirSync(OUT_IDX, { recursive: true });

// ---------- utilidades ----------
function stripBOM(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function slug(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "otros";
}

// Normaliza texto para el índice de búsqueda: minúsculas, sin acentos y
// unificando decimales con coma a punto (1,5 -> 1.5). DEBE coincidir con la
// misma función del front (app.js) para que las consultas casen con el índice.
function normSearch(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .trim();
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

// Anonimiza el bastidor dejando solo los primeros 10 caracteres (igual que el
// trigger trg_recortar_bastidor de Red Desguace). El front añade el "…".
function anonBastidor(x) {
  const s = String(x ?? "").trim().toUpperCase();
  if (!s) return undefined;
  return s.slice(0, 10);
}

// Convierte una fecha del CSV a un número entero comparable (timestamp en segundos).
// Acepta los formatos más típicos que pueden venir de CRVNET:
//   2026-05-20 12:34:56  ·  2026-05-20  ·  20/05/2026 12:34  ·  20/05/2026  ·  20-05-2026
function toTimestamp(x) {
  const s = String(x ?? "").trim();
  if (!s) return 0;
  // ISO: 2026-05-20[ T]hh:mm[:ss]
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0));
    return Math.floor(d.getTime() / 1000);
  }
  // DD/MM/YYYY o DD-MM-YYYY [hh:mm[:ss]]
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4]||0), +(m[5]||0), +(m[6]||0));
    return Math.floor(d.getTime() / 1000);
  }
  return 0;
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

// ---------- vehículos de origen ----------
// Mapa codvehiculo -> objeto compacto del vehículo donante.
// Se cruza por la columna 'codvehiculo' de cada pieza.
const vehiclesAll = new Map();
if (fs.existsSync(SRC_VEH)) {
  console.log("Leyendo CSV de vehículos…");
  const vtext = stripBOM(fs.readFileSync(SRC_VEH, "utf-8"));
  const { header: vheader, rows: vrows } = parseCSV(vtext);
  console.log(`  Filas vehículos: ${vrows.length.toLocaleString("es-ES")}`);
  const vcol = Object.fromEntries(vheader.map((h, i) => [h, i]));
  const vneed = ["codvehiculo","marca","modelo","motorversion","cambioversion",
                 "anoversion","bastidor","color","puertas","kilometraje",
                 "tipocombustible","codigomotor","imgs"];
  for (const k of vneed) {
    if (!(k in vcol)) console.warn(`  AVISO: falta columna '${k}' en el CSV de vehículos`);
  }

  for (const r of vrows) {
    const cod = (r[vcol.codvehiculo] || "").trim();
    if (!cod || cod === "0") continue;

    const km   = toInt(r[vcol.kilometraje]);
    const pu   = toInt(r[vcol.puertas]);
    const vimgsRaw = (r[vcol.imgs] || "").trim();
    const vimgs = vimgsRaw
      ? vimgsRaw.split(",").map(s => s.trim()).filter(s => /^https?:\/\//.test(s)).slice(0, 4)
      : [];

    vehiclesAll.set(cod, {
      ma:   (r[vcol.marca] || "").trim().toUpperCase() || undefined,
      mo:   (r[vcol.modelo] || "").trim() || undefined,
      ver:  (r[vcol.motorversion] || "").trim() || undefined,
      cam:  (r[vcol.cambioversion] || "").trim() || undefined,
      an:   toInt(r[vcol.anoversion]) || undefined,
      bas:  anonBastidor(r[vcol.bastidor]),
      col:  (r[vcol.color] || "").trim() || undefined,
      pu:   (pu && pu > 0) ? pu : undefined,
      km:   (km && km > 0) ? km : undefined,
      comb: (r[vcol.tipocombustible] || "").trim() || undefined,
      cm:   (r[vcol.codigomotor] || "").trim() || undefined,
      im:   vimgs.length ? vimgs : undefined,
    });
  }
  console.log(`  Vehículos cargados: ${vehiclesAll.size.toLocaleString("es-ES")}`);
} else {
  console.warn(`  AVISO: no existe ${SRC_VEH}. Se construye el catálogo SIN vehículo de origen.`);
}

// ---------- lectura piezas ----------
console.log("\nLeyendo CSV de piezas…");
const text = stripBOM(fs.readFileSync(SRC, "utf-8"));
const { header, rows } = parseCSV(text);
console.log(`  Filas crudas: ${rows.length.toLocaleString("es-ES")}`);
console.log(`  Cabeceras: ${header.join(", ")}`);

const col = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ["refid","familia","articulo","marca","modelo","modeloinicio","modelofin",
              "motorversion","precio","notapublica","refvisual","refcatalogo","factualiza",
              "codvehiculo","imgs"];
for (const k of need) {
  if (!(k in col)) console.warn(`  AVISO: falta columna '${k}' en el CSV`);
}

// ---------- normalización ----------
const families = new Map();        // familia → array de piezas (ficha completa)
const indexAll = [];               // índice global ligero
const brandsModels = new Map();    // marca → Set(modelos)
const usedVehicles = new Set();    // codvehiculos realmente referenciados por piezas
let yearMin = Infinity, yearMax = -Infinity;
let skipped = 0, withImg = 0, withVeh = 0;

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
  const ts     = toTimestamp(r[col.factualiza]); // fecha de actualización en CRVNET (timestamp en segundos)
  const imgsRaw = (r[col.imgs] || "").trim();
  const imgs = imgsRaw
    ? imgsRaw.split(",").map(s => s.trim()).filter(s => /^https?:\/\//.test(s))
    : [];
  // Antes filtrábamos las piezas sin foto, ahora se incluyen TODAS.
  // Las sin foto NO aparecerán en el grid (filtro hasImg=1 en el front),
  // pero SÍ se podrán encontrar por el buscador y los filtros.
  if (imgs.length) withImg++;

  // Vehículo de origen: solo si la pieza referencia un codvehiculo válido que
  // exista en el CSV de vehículos (evitamos referencias colgantes).
  const cvRaw = (col.codvehiculo != null ? (r[col.codvehiculo] || "") : "").trim();
  let cv, vehForTxt = null;
  if (cvRaw && cvRaw !== "0" && vehiclesAll.has(cvRaw)) {
    cv = cvRaw;
    vehForTxt = vehiclesAll.get(cvRaw);
    usedVehicles.add(cvRaw);
    withVeh++;
  }

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
    u: ts || undefined,
    cv: cv || undefined,
  };
  if (!families.has(familia)) families.set(familia, []);
  families.get(familia).push(pieza);

  // Entrada del índice como ARRAY posicional (ahorra ~30% vs objetos):
  // [id, familia, marca, modelo, y0, y1, precio, hasImg, articulo, textoBusqueda, updatedTs]
  // El texto de búsqueda se ENRIQUECE con los datos del vehículo de origen
  // (cilindrada/versión, combustible y código de motor), que es donde el cliente
  // busca de forma natural ("motor arranque 1.5", "bomba diesel"...). Sin esto,
  // la cilindrada no existe en la pieza (su motorversion es el código de motor).
  const vehTxt = vehForTxt
    ? `${vehForTxt.ver || ""} ${vehForTxt.comb || ""} ${vehForTxt.cm || ""}`
    : "";
  const txt = normSearch(`${refid} ${articulo} ${marca} ${modelo} ${motor} ${rv} ${rc} ${vehTxt}`);
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
    ts,
  ]);

  if (marca) {
    if (!brandsModels.has(marca)) brandsModels.set(marca, new Set());
    if (modelo) brandsModels.get(marca).add(modelo);
  }
  if (y0 != null && y0 >= 1950 && y0 <= 2035) { if (y0 < yearMin) yearMin = y0; if (y0 > yearMax) yearMax = y0; }
  if (y1 != null && y1 >= 1950 && y1 <= 2035) { if (y1 < yearMin) yearMin = y1; if (y1 > yearMax) yearMax = y1; }
}

console.log(`  Procesadas: ${indexAll.length.toLocaleString("es-ES")}  (saltadas ${skipped.toLocaleString("es-ES")} sin refid v\u00e1lido)`);
console.log(`  Con imagen: ${withImg.toLocaleString("es-ES")}  ·  Sin imagen (s\u00f3lo buscables): ${(indexAll.length - withImg).toLocaleString("es-ES")}`);
console.log(`  Con veh\u00edculo de origen: ${withVeh.toLocaleString("es-ES")}  ·  Veh\u00edculos referenciados: ${usedVehicles.size.toLocaleString("es-ES")}`);

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

// 3) Vehículos de origen (solo los referenciados por alguna pieza en stock)
console.log("\nGenerando vehículos de origen…");
const vehiclesOut = {};
for (const cod of usedVehicles) {
  if (vehiclesAll.has(cod)) vehiclesOut[cod] = vehiclesAll.get(cod);
}
const vehSize = writeJSON(path.join(process.cwd(), "data", "vehiculos.json"), vehiclesOut);
console.log(`  data/vehiculos.json: ${Object.keys(vehiclesOut).length.toLocaleString("es-ES")} vehículos · ${(vehSize/1024/1024).toFixed(2)} MB`);

// 4) Meta
console.log("\nGenerando meta…");
const now = new Date();
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
  updated: now.toISOString(),
  buildId: now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14), // YYYYMMDDHHMMSS — cache buster
};
const metaSize = writeJSON(path.join(process.cwd(), "data", "meta.json"), meta);
console.log(`  data/meta.json: ${(metaSize/1024).toFixed(1)} KB`);
console.log(`  Marcas: ${meta.brands.length}, Modelos: ${Object.values(meta.modelsByBrand).reduce((a,b)=>a+b.length,0)}, Años: ${meta.yearMin}-${meta.yearMax}`);

console.log("\n✓ Index build completo.");
