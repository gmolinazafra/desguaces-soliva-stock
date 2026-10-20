// scripts/sync-reddesguace.js
// ============================================================
// ORIGEN DEL CATÁLOGO DESDE RED DESGUACE (20/10/2026)
//
// REDIA ha parado su sistema y el FTP de CRVNET deja de estar
// disponible. El inventario de Soliva que se ha salvado está en
// Red Desguace (Supabase), con las fotos en el R2 propio
// (fotos.reddesguaces.com), así que la web se alimenta de ahí.
//
// Genera data/stock.csv y data/vehiculos.csv con el MISMO formato
// CRVNET que consumía build-index.js (separador ';', precios con
// coma decimal), para no tocar el build ni el front.
//
// Solo se publican piezas activas y fotos del R2 propio.
//
// PROTECCIÓN: si la descarga trae menos de MIN_PIEZAS piezas o falla,
// el script termina con error y el workflow NO despliega: la web
// sigue con la última versión publicada (nunca se publica vacía).
//
// Variables de entorno (opcionales):
//   RD_SUPABASE_URL  → URL del proyecto (por defecto, Red Desguace)
//   RD_SUPABASE_KEY  → clave publicable (por defecto, la pública de la web)
//   RD_SOCIO_ID      → socio de Red Desguace (por defecto, Desguaces Soliva)
//   MIN_PIEZAS       → mínimo de piezas para aceptar la descarga (20000)
// ============================================================

const fs   = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.RD_SUPABASE_URL || 'https://lkrcksadgiugnmxquuep.supabase.co').replace(/\/+$/, '');
// Clave publicable (la misma que usa la web pública de Red Desguace; solo lee lo que RLS deja ver al público)
const SUPABASE_KEY = process.env.RD_SUPABASE_KEY || 'sb_publishable_lv60wnP0eTQ_7aRCuz9whA_DSohI3SW';
const SOCIO_ID     = process.env.RD_SOCIO_ID || 'f6847540-9195-4f76-9d0f-b3b0883c52fc';
const MIN_PIEZAS   = parseInt(process.env.MIN_PIEZAS || '20000', 10);
const PAGE         = 1000;
const FOTOS_HOST   = /^https:\/\/fotos\.reddesguaces\.com\//;

const DATA_DIR = path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function resumen(texto) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto + '\n');
}

async function getJSON(url) {
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' },
      });
      if (res.ok) return await res.json();
      const txt = await res.text();
      console.warn(`  HTTP ${res.status} (intento ${intento}/4): ${txt.slice(0, 200)}`);
    } catch (e) {
      console.warn(`  ${e.message} (intento ${intento}/4)`);
    }
    await new Promise(r => setTimeout(r, 4000 * intento));
  }
  throw new Error(`No se pudo leer ${url.split('?')[0]}`);
}

// Paginación por clave (id > último) para no depender de OFFSET
async function leerTodo(tabla, select, filtros) {
  const out = [];
  let ultimo = null;
  for (;;) {
    const q = new URLSearchParams();
    q.set('select', select);
    for (const [k, v] of Object.entries(filtros)) q.set(k, v);
    if (ultimo) q.set('id', `gt.${ultimo}`);
    q.set('order', 'id.asc');
    q.set('limit', String(PAGE));
    const filas = await getJSON(`${SUPABASE_URL}/rest/v1/${tabla}?${q.toString()}`);
    out.push(...filas);
    process.stdout.write(`\r  ${tabla}: ${out.length.toLocaleString('es-ES')}`);
    if (filas.length < PAGE) break;
    ultimo = filas[filas.length - 1].id;
  }
  process.stdout.write('\n');
  return out;
}

// Fotos del R2 propio, en orden; versión media (webp) y si no, la original
function fotosR2(lista) {
  return (lista || [])
    .slice()
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map(f => f.url_r2_medium || f.url_r2_original || '')
    .filter(u => FOTOS_HOST.test(u));
}

// CSV con ';' y comillas cuando hace falta
function campo(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function linea(arr) { return arr.map(campo).join(';'); }

// Precio en formato CRVNET: coma decimal, sin separador de miles
// (build-index.js quita los puntos antes de leerlo)
function precioES(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2).replace('.', ',') : '';
}

async function main() {
  console.log(`Leyendo inventario salvado de Red Desguace (socio ${SOCIO_ID}) …`);

  const vehiculos = await leerTodo(
    'vehiculos',
    'id,codvehiculo,marca,modelo,motor_version,cambio_version,ano_version,bastidor_anonimizado,color,puertas,kilometraje,tipo_combustible,codigo_motor,fotos_vehiculos(orden,url_r2_medium,url_r2_original)',
    { socio_id: `eq.${SOCIO_ID}`, activo: 'is.true' }
  );

  const piezas = await leerTodo(
    'piezas',
    'id,refid,familia,articulo,marca,modelo,modelo_inicio,modelo_fin,motor_version,cambio_version,ref_visual,ref_catalogo,precio,ano_pieza,nota_publica,fecha_actualizacion,vehiculo_id,fotos(orden,url_r2_medium,url_r2_original)',
    { socio_id: `eq.${SOCIO_ID}`, activa: 'is.true' }
  );

  if (piezas.length < MIN_PIEZAS) {
    throw new Error(`Solo han llegado ${piezas.length} piezas (mínimo ${MIN_PIEZAS}). No se publica para no vaciar la web.`);
  }

  // ---------- vehiculos.csv ----------
  const codPorId = new Map();
  const vLineas = [linea(['codvehiculo','marca','modelo','motorversion','cambioversion','anoversion','bastidor','color','puertas','kilometraje','tipocombustible','codigomotor','imgs'])];
  for (const v of vehiculos) {
    const cod = (v.codvehiculo || '').trim();
    if (!cod) continue;
    codPorId.set(v.id, cod);
    vLineas.push(linea([
      cod, v.marca, v.modelo, v.motor_version, v.cambio_version, v.ano_version,
      v.bastidor_anonimizado, v.color, v.puertas, v.kilometraje, v.tipo_combustible,
      v.codigo_motor, fotosR2(v.fotos_vehiculos).join(','),
    ]));
  }
  fs.writeFileSync(path.join(DATA_DIR, 'vehiculos.csv'), vLineas.join('\n') + '\n', 'utf-8');

  // ---------- stock.csv ----------
  let conFoto = 0, conVeh = 0;
  const pLineas = [linea(['refid','familia','articulo','marca','modelo','modeloinicio','modelofin','motorversion','cambioversion','refvisual','refcatalogo','precio','anopieza','notapublica','factualiza','codvehiculo','imgs'])];
  for (const p of piezas) {
    const imgs = fotosR2(p.fotos);
    if (imgs.length) conFoto++;
    const cv = p.vehiculo_id ? (codPorId.get(p.vehiculo_id) || '') : '';
    if (cv) conVeh++;
    pLineas.push(linea([
      p.refid, p.familia, p.articulo, p.marca, p.modelo, p.modelo_inicio, p.modelo_fin,
      p.motor_version, p.cambio_version, p.ref_visual, p.ref_catalogo, precioES(p.precio),
      p.ano_pieza, p.nota_publica, (p.fecha_actualizacion || '').replace('T', ' ').slice(0, 19),
      cv, imgs.join(','),
    ]));
  }
  fs.writeFileSync(path.join(DATA_DIR, 'stock.csv'), pLineas.join('\n') + '\n', 'utf-8');

  const msg = `Red Desguace: ${piezas.length} piezas (${conFoto} con foto de R2, ${conVeh} con vehículo) y ${vehiculos.length} vehículos.`;
  console.log(msg);
  resumen(`### ✅ Catálogo desde Red Desguace\n${msg}`);
}

main().catch(e => {
  console.error(`::error title=Red Desguace::${e.message}`);
  resumen(`### ❌ No se publica\n${e.message}. La web sigue con la última versión publicada.`);
  process.exit(1);
});
