// scripts/sync-metasync.js
// ============================================================
// Descarga el inventario completo desde la API de Metasync y
// genera data/stock.csv y data/vehiculos.csv con el mismo
// formato que consumía sync-stock.js (desde FTP).
//
// Variables de entorno requeridas (secrets del repo):
//   METASYNC_APIKEY     → clave de la API
//   METASYNC_IDEMPRESA  → ID de empresa en Metasync
//   METASYNC_FECHA_INICIO (opcional) → fecha de corte inicial
//                          Por defecto: 2020-01-01 00:00:00
//                          Usar 2000-01-01 en el primer sync completo
//   STOCK_MIN_RATIO (opcional) → proporción mínima respecto al stock
//                          anterior para aceptar una descarga (0.5 = 50 %)
//
// 2026-09-30 — PROTECCIÓN CONTRA CATÁLOGO VACÍO
// La API es diferencial (RecuperarCambiosCanalEmpresa) y puede devolver
// cero cambios o una lista parcial (límite de peticiones, canal sin
// novedades, corte a mitad de descarga). Antes eso se publicaba tal
// cual y la web quedaba con 0 piezas. Ahora:
//  · Si la 1ª página llega vacía o la API da 429/5xx, se reintenta.
//  · Si la descarga trae 0 piezas o muchas menos que la copia anterior
//    (data/stock.csv restaurado de la caché del workflow), se CONSERVA
//    la copia anterior y no se pisa.
//  · El resultado se comunica al workflow (salida "fuente": api | copia
//    | vacio) y se escribe en el resumen de la ejecución.
// ============================================================

const fs   = require('fs');
const path = require('path');

const API_BASE  = 'https://apis.metasync.com';
const DATA_DIR  = path.join(process.cwd(), 'data');
const OFFSET    = 100; // registros por página (máximo API)
const MAX_PAGES = 600;

const APIKEY    = process.env.METASYNC_APIKEY;
const IDEMPRESA = process.env.METASYNC_IDEMPRESA;
const FECHA     = process.env.METASYNC_FECHA_INICIO || '2020-01-01 00:00:00';
const MIN_RATIO = parseFloat(process.env.STOCK_MIN_RATIO || '0.5');
const REINTENTOS = 4;          // por petición (429/5xx/red) y para 1ª página vacía
const ESPERA_MS  = 20000;      // espera base entre reintentos

if (!APIKEY || !IDEMPRESA) {
  console.error('Faltan variables: METASYNC_APIKEY / METASYNC_IDEMPRESA');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── utilidades ──────────────────────────────────────────────
function norm(v) {
  const s = String(v ?? '').trim();
  return s === '' || s === '-1' ? '' : s;
}

function aPrecio(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  return (Math.round(n) / 100).toFixed(2);
}

function aEntero(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function anonBastidor(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return s ? s.slice(0, 10) : '';
}

function escapeCsv(v) {
  const s = String(v ?? '');
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function fila(...cols) {
  return cols.map(escapeCsv).join(';');
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Petición de una página con reintentos ante 429, 5xx o fallo de red.
async function pedirPagina(lastId) {
  let ultimoError = '';
  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await fetch(`${API_BASE}/Almacen/RecuperarCambiosCanalEmpresa`, {
        headers: {
          apikey:    APIKEY,
          fecha:     FECHA,
          lastid:    String(lastId),
          offset:    String(OFFSET),
          idempresa: IDEMPRESA,
        },
      });
      if (res.ok) return await res.json();
      ultimoError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      // 4xx distinto de 429 = error de credenciales o de petición: no tiene sentido reintentar
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      ultimoError = `red: ${e.message}`;
    }
    console.warn(`  Intento ${intento}/${REINTENTOS} fallido (${ultimoError}). Esperando…`);
    if (intento < REINTENTOS) await dormir(ESPERA_MS * intento);
  }
  throw new Error(`API Metasync no disponible (${ultimoError})`);
}

// ── llamada paginada a la API ────────────────────────────────
async function descargarInventario() {
  let lastId = 0;
  let pagina = 1;
  const piezas   = new Map(); // refLocal → objeto
  const vehiculos = new Map(); // idLocal → objeto

  console.log(`Descargando inventario Metasync (idEmpresa ${IDEMPRESA}, desde ${FECHA})…`);

  while (pagina <= MAX_PAGES) {
    let json  = await pedirPagina(lastId);
    let items = json?.listaCambios ?? json?.ListaCambios ?? [];

    // 1ª página vacía: puede ser un límite temporal de la API. Se reintenta
    // antes de dar por bueno que "no hay nada que traer".
    if (pagina === 1 && (!Array.isArray(items) || items.length === 0)) {
      console.warn(`  La API devuelve 0 cambios en la 1ª página. Respuesta: ${JSON.stringify(json).slice(0, 300)}`);
      for (let intento = 1; intento < REINTENTOS && (!Array.isArray(items) || items.length === 0); intento++) {
        console.warn(`  Reintento ${intento}/${REINTENTOS - 1} de la 1ª página en ${ESPERA_MS * intento / 1000} s…`);
        await dormir(ESPERA_MS * intento);
        json  = await pedirPagina(lastId);
        items = json?.listaCambios ?? json?.ListaCambios ?? [];
      }
    }
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      // Vehículos
      if (item.vehiculo) {
        const v = item.vehiculo;
        const id = String(v.idLocal ?? '').trim();
        if (id && id !== '0') vehiculos.set(id, v);
      }

      // Piezas
      const p = item;
      if (p.refLocal != null) {
        const ref = String(p.refLocal).trim();
        if (!ref || ref === '0') continue;
        // La última entrada del mismo refLocal es la que manda
        piezas.set(ref, p);
      }
    }

    const ultimo = items[items.length - 1];
    const nuevoId = parseInt(String(ultimo?.idCambio ?? ultimo?.idLocal ?? '0'), 10);
    console.log(`  Pág ${pagina}: ${items.length} registros | lastId ${lastId} → ${nuevoId}`);
    if (!nuevoId || nuevoId <= lastId) break;
    lastId = nuevoId;
    pagina++;
  }

  console.log(`Descarga completada: ${vehiculos.size} vehículos, ${piezas.size} piezas`);
  return { piezas: [...piezas.values()], vehiculos: [...vehiculos.values()] };
}

// ── generar CSVs ─────────────────────────────────────────────
function generarStockCsv(piezas, mapaVehiculos) {
  const HEADER = 'refid;familia;articulo;marca;modelo;modeloinicio;modelofin;motorversion;precio;notapublica;refvisual;refcatalogo;factualizacion;codvehiculo;imgs';
  const lineas = [HEADER];

  for (const p of piezas) {
    // Solo piezas a la venta
    const estado = String(p.estado ?? p.estadoPieza ?? '').toLowerCase();
    const estaALaVenta = estado === 'disponible' || estado === 'disponibleonline' || estado === '';
    if (!estaALaVenta) continue;

    const precio = aPrecio(p.precio);
    if (!precio) continue;

    const refid        = norm(p.refLocal);
    const familia      = norm(p.descripcionFamilia) || 'SIN CLASIFICAR';
    const articulo     = norm(p.descripcionArticulo) || 'SIN DESCRIPCION';
    const refcatalogo  = norm(p.refPrincipal);
    const notapublica  = norm(p.observaciones);
    const factualizacion = norm(p.fechaModificacion || p.fechaAlta || '');

    // Vehículo de origen
    const idVehiculo = String(p.idVehiculo ?? p.idLocal ?? '').trim();
    const veh = idVehiculo ? mapaVehiculos.get(idVehiculo) : null;
    const marca       = norm(p.marca || veh?.nombreMarca || '');
    const modelo      = norm(p.modelo || veh?.nombreModelo || '');
    const motorversion = norm(p.motorVersion || veh?.motorVersion || '');
    const modeloinicio = aEntero(veh?.anyoVehiculo);
    const modelofin   = '';
    const refvisual   = norm(p.refVisual || '');
    const codvehiculo = veh ? String(veh.idLocal ?? '').trim() : '';

    const imgs = (p.urlsImgs || [])
      .filter(u => u && u.length > 40 && !u.endsWith('/simg'))
      .slice(0, 4)
      .join(',');

    lineas.push(fila(refid, familia, articulo, marca, modelo, modeloinicio, modelofin,
      motorversion, precio, notapublica, refvisual, refcatalogo, factualizacion, codvehiculo, imgs));
  }

  return lineas.join('\n');
}

function generarVehiculosCsv(vehiculos) {
  const HEADER = 'codvehiculo;marca;modelo;motorversion;cambioversion;anoversionr;bastidor;color;puertas;kilometraje;tipocombustible;codigomotor;imgs';
  const lineas = [HEADER];

  for (const v of vehiculos) {
    const cod = String(v.idLocal ?? '').trim();
    if (!cod || cod === '0') continue;

    const imgs = (v.urlsImgs || [])
      .filter(u => u && u.length > 40 && !u.endsWith('/simg'))
      .slice(0, 4)
      .join(',');

    lineas.push(fila(
      cod,
      norm(v.nombreMarca),
      norm(v.nombreModelo),
      norm(v.motorVersion || ''),
      norm(v.cambioVersion || ''),
      aEntero(v.anyoVehiculo),
      anonBastidor(v.bastidor),
      norm(v.color),
      aEntero(v.puertas),
      aEntero(v.kilometraje),
      norm(v.combustible),
      norm(v.codigoMotor),
      imgs,
    ));
  }

  return lineas.join('\n');
}

// ── comunicación con el workflow ──────────────────────────────
function contarLineas(ruta) {
  try {
    const t = fs.readFileSync(ruta, 'utf8');
    return Math.max(0, t.split('\n').filter(l => l.trim() !== '').length - 1);
  } catch { return 0; }
}
function salida(clave, valor) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${clave}=${valor}\n`);
}
function resumen(texto) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto + '\n');
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  const stockPath = path.join(DATA_DIR, 'stock.csv');
  const vehPath   = path.join(DATA_DIR, 'vehiculos.csv');

  // Copia anterior (restaurada de la caché por el workflow), si existe
  const previas = contarLineas(stockPath);
  console.log(previas > 0
    ? `Copia anterior disponible: ${previas} piezas`
    : 'Sin copia anterior del stock');

  let piezas = [], vehiculos = [], errorApi = '';
  try {
    ({ piezas, vehiculos } = await descargarInventario());
  } catch (e) {
    errorApi = e.message;
    console.error(`[API] ${errorApi}`);
  }

  const mapaVehiculos = new Map(vehiculos.map(v => [String(v.idLocal ?? '').trim(), v]));
  const stockCsv = generarStockCsv(piezas, mapaVehiculos);
  const vehCsv   = generarVehiculosCsv(vehiculos);
  const nuevas   = stockCsv.split('\n').length - 1;

  const insuficiente = nuevas === 0 || (previas > 0 && nuevas < previas * MIN_RATIO);

  if (insuficiente && previas > 0) {
    // No se pisa el stock bueno con una descarga vacía o parcial
    const motivo = errorApi || `la API devolvió ${nuevas} piezas a la venta (${piezas.length} registros) frente a ${previas} de la copia anterior`;
    console.log(`::warning title=Stock Metasync no actualizado::Se conserva la copia anterior (${previas} piezas): ${motivo}`);
    resumen(`### ⚠️ Stock NO actualizado\nSe publica la copia anterior (**${previas}** piezas). Motivo: ${motivo}`);
    salida('fuente', 'copia');
    salida('piezas', previas);
    return;
  }

  fs.writeFileSync(stockPath, stockCsv, 'utf8');
  fs.writeFileSync(vehPath, vehCsv, 'utf8');

  if (nuevas === 0) {
    const motivo = errorApi || `la API devolvió ${piezas.length} registros y ninguna pieza a la venta`;
    console.log(`::error title=Catálogo vacío::No hay copia anterior y ${motivo}. La web se publica SIN piezas.`);
    resumen(`### ❌ Catálogo vacío\nNo hay copia anterior y ${motivo}.`);
    salida('fuente', 'vacio');
    salida('piezas', 0);
    return;
  }

  const vehValidos = vehCsv.split('\n').length - 1;
  console.log(`stock.csv: ${nuevas} piezas (${(fs.statSync(stockPath).size / 1024).toFixed(0)} KB)`);
  console.log(`vehiculos.csv: ${vehValidos} vehículos`);
  resumen(`### ✅ Stock actualizado desde Metasync\n**${nuevas}** piezas · **${vehValidos}** vehículos`);
  salida('fuente', 'api');
  salida('piezas', nuevas);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
