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

// ── llamada paginada a la API ────────────────────────────────
async function descargarInventario() {
  let lastId = 0;
  let pagina = 1;
  const piezas   = new Map(); // refLocal → objeto
  const vehiculos = new Map(); // idLocal → objeto

  console.log(`Descargando inventario Metasync (idEmpresa ${IDEMPRESA}, desde ${FECHA})…`);

  while (pagina <= MAX_PAGES) {
    const res = await fetch(`${API_BASE}/Almacen/RecuperarCambiosCanalEmpresa`, {
      headers: {
        apikey:    APIKEY,
        fecha:     FECHA,
        lastid:    String(lastId),
        offset:    String(OFFSET),
        idempresa: IDEMPRESA,
      },
    });

    if (!res.ok) {
      console.error(`  API error ${res.status}: ${await res.text()}`);
      process.exit(1);
    }

    const json = await res.json();
    const items = json?.listaCambios ?? json?.ListaCambios ?? [];
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

// ── main ──────────────────────────────────────────────────────
async function main() {
  const { piezas, vehiculos } = await descargarInventario();

  const mapaVehiculos = new Map(vehiculos.map(v => [String(v.idLocal ?? '').trim(), v]));

  const stockCsv = generarStockCsv(piezas, mapaVehiculos);
  const vehCsv   = generarVehiculosCsv(vehiculos);

  const stockPath = path.join(DATA_DIR, 'stock.csv');
  const vehPath   = path.join(DATA_DIR, 'vehiculos.csv');

  fs.writeFileSync(stockPath, stockCsv, 'utf8');
  fs.writeFileSync(vehPath, vehCsv, 'utf8');

  const piezasValidas = stockCsv.split('\n').length - 1;
  const vehValidos    = vehCsv.split('\n').length - 1;

  console.log(`stock.csv: ${piezasValidas} piezas (${(fs.statSync(stockPath).size / 1024).toFixed(0)} KB)`);
  console.log(`vehiculos.csv: ${vehValidos} vehículos`);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
