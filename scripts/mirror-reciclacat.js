// scripts/mirror-reciclacat.js
// ============================================================
// RESPALDO del catálogo: copia los datos ya publicados por la web de
// ReciclaCAT (mismo inventario y mismo formato: los dos sitios usan el
// mismo scripts/build-index.js) a la carpeta data/ de este sitio.
//
// Se usa SOLO cuando Metasync devuelve 0 piezas y no hay copia anterior
// del stock: así la web no se publica vacía.
//
// Descarga:  data/meta.json · data/index/first.json · data/index/all.json
//            data/vehiculos.json · data/familias/<familia>.json
//
// Variable opcional:
//   MIRROR_URL → origen de los datos (por defecto https://recambios.reciclacat.es)
//
// Si el espejo falla o viene vacío, se ejecuta el build normal
// (scripts/build-index.js) para que el despliegue no se rompa.
// ============================================================

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORIGEN   = (process.env.MIRROR_URL || 'https://recambios.reciclacat.es').replace(/\/+$/, '');
const DATA_DIR = path.join(process.cwd(), 'data');

// Debe coincidir con slug() de assets/app.js y de build-index.js
function slug(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'otros';
}

function salida(clave, valor) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${clave}=${valor}\n`);
}
function resumen(texto) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto + '\n');
}

async function bajar(ruta, { obligatorio = true } = {}) {
  const url = `${ORIGEN}/${ruta}${ruta.includes('?') ? '&' : '?'}t=${Date.now()}`;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404 && !obligatorio) return null;
      console.warn(`  ${ruta}: HTTP ${res.status} (intento ${intento}/3)`);
    } catch (e) {
      console.warn(`  ${ruta}: ${e.message} (intento ${intento}/3)`);
    }
    await new Promise(r => setTimeout(r, 3000 * intento));
  }
  if (obligatorio) throw new Error(`No se pudo descargar ${ruta}`);
  return null;
}

function guardar(ruta, buf) {
  const destino = path.join(DATA_DIR, ruta);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
}

async function espejo() {
  console.log(`Copiando catálogo publicado desde ${ORIGEN} …`);

  const metaBuf = await bajar('data/meta.json');
  const meta = JSON.parse(metaBuf.toString('utf8'));
  if (!meta || !meta.total || !Array.isArray(meta.families) || !meta.families.length) {
    throw new Error('El catálogo de origen está vacío');
  }

  const allBuf = await bajar('data/index/all.json');
  const all = JSON.parse(allBuf.toString('utf8'));
  if (!all || !Array.isArray(all.rows) || !all.rows.length) throw new Error('El índice de origen está vacío');

  const firstBuf = await bajar('data/index/first.json');
  const vehBuf   = await bajar('data/vehiculos.json', { obligatorio: false });

  // Familias: se bajan todas antes de escribir nada, para no dejar data/ a medias
  const familias = [];
  for (const f of meta.families) {
    const ruta = `data/familias/${slug(f)}.json`;
    familias.push([ruta, await bajar(ruta)]);
    console.log(`  ${ruta}`);
  }

  guardar('meta.json', metaBuf);
  guardar('index/all.json', allBuf);
  guardar('index/first.json', firstBuf);
  if (vehBuf) guardar('vehiculos.json', vehBuf);
  for (const [ruta, buf] of familias) guardar(ruta.replace(/^data\//, ''), buf);

  console.log(`Espejo completado: ${meta.total} piezas, ${meta.families.length} familias, ${meta.brands ? meta.brands.length : '?'} marcas`);
  return meta.total;
}

(async () => {
  try {
    const total = await espejo();
    console.log(`::warning title=Catálogo copiado de ReciclaCAT::Metasync no devolvió piezas. Se publican ${total} piezas copiadas de ${ORIGEN}.`);
    resumen(`### ⚠️ Catálogo copiado de ReciclaCAT\nMetasync no devolvió piezas y no había copia anterior. Se publican **${total}** piezas copiadas de ${ORIGEN}.`);
    salida('ok', 'true');
  } catch (e) {
    console.log(`::error title=Respaldo fallido::${e.message}. La web se publica SIN piezas.`);
    resumen(`### ❌ Respaldo fallido\n${e.message}. La web se publica sin piezas.`);
    salida('ok', 'false');
    // build normal con el CSV (vacío) para que el despliegue siga funcionando
    execFileSync(process.execPath, [path.join('scripts', 'build-index.js')], { stdio: 'inherit' });
  }
})();
