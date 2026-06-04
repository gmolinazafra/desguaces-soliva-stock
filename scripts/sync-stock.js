// scripts/sync-stock.js
// Descarga los CSV desde el FTP de CRVNET y los deja en data/:
//   FTP_REMOTE_PATH      -> data/stock.csv      (obligatorio)
//   FTP_REMOTE_PATH_VEH  -> data/vehiculos.csv  (opcional: si no está, se omite
//                                                 y el build se hace sin vehículo
//                                                 de origen, sin romper nada)
//
// Requiere la dependencia 'basic-ftp'. Si no la tienes en package.json:
//   npm install basic-ftp
//
// Variables de entorno (secrets del repo):
//   FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD, FTP_SECURE,
//   FTP_REMOTE_PATH, FTP_REMOTE_PATH_VEH

const fs   = require("fs");
const path = require("path");
const ftp  = require("basic-ftp");

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const {
  FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD, FTP_SECURE,
  FTP_REMOTE_PATH, FTP_REMOTE_PATH_VEH,
} = process.env;

if (!FTP_HOST || !FTP_USER || !FTP_PASSWORD || !FTP_REMOTE_PATH) {
  console.error("Faltan variables FTP obligatorias (FTP_HOST / FTP_USER / FTP_PASSWORD / FTP_REMOTE_PATH).");
  process.exit(1);
}

const secureStr = String(FTP_SECURE || "").toLowerCase().trim();
const isSecure  = secureStr === "true" || secureStr === "1" || secureStr === "yes" || secureStr === "si";

async function descargar(client, remote, localName, obligatorio) {
  const local = path.join(DATA_DIR, localName);
  try {
    console.log(`Descargando ${localName}: ${remote}`);
    await client.downloadTo(local, remote);
    const mb = (fs.statSync(local).size / 1024 / 1024).toFixed(1);
    console.log(`  OK (${mb} MB)`);
  } catch (e) {
    if (obligatorio) {
      console.error(`  ERROR descargando ${localName}: ${e.message}`);
      throw e;
    }
    console.warn(`  AVISO: no se pudo descargar ${localName} (${e.message}). Se continúa sin él.`);
  }
}

async function main() {
  const client = new ftp.Client(30000); // timeout 30 s
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      port: FTP_PORT ? parseInt(FTP_PORT, 10) : 21,
      user: FTP_USER,
      password: FTP_PASSWORD,
      secure: isSecure,                          // FTPS explícito (AUTH TLS) si FTP_SECURE=true
      secureOptions: { rejectUnauthorized: false }, // tolera certificados autofirmados
    });

    await descargar(client, FTP_REMOTE_PATH, "stock.csv", true);

    if (FTP_REMOTE_PATH_VEH) {
      await descargar(client, FTP_REMOTE_PATH_VEH, "vehiculos.csv", false);
    } else {
      console.warn("FTP_REMOTE_PATH_VEH no definido: se omite el CSV de vehículos (build sin vehículo de origen).");
    }
  } catch (e) {
    console.error("Fallo de sincronización FTP:", e.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

main();
