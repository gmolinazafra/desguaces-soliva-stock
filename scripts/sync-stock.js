// scripts/sync-stock.js — Descarga el CSV desde el FTP a data/stock.csv

const ftp  = require("basic-ftp");
const fs   = require("fs");
const path = require("path");

(async () => {
  const {
    FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD, FTP_REMOTE_PATH, FTP_SECURE,
  } = process.env;

  if (!FTP_HOST || !FTP_USER || !FTP_PASSWORD || !FTP_REMOTE_PATH) {
    console.error("Faltan secrets FTP_HOST / FTP_USER / FTP_PASSWORD / FTP_REMOTE_PATH");
    process.exit(1);
  }

  const port = parseInt(FTP_PORT || "21", 10);

  const local = path.join(process.cwd(), "data", "stock.csv");
  fs.mkdirSync(path.dirname(local), { recursive: true });

  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: FTP_HOST,
      port: port,
      user: FTP_USER,
      password: FTP_PASSWORD,
      secure: String(FTP_SECURE).toLowerCase() === "true",
    });
    console.log(`Conectado a ${FTP_HOST}:${port}, descargando ${FTP_REMOTE_PATH} → ${local}`);
    await client.downloadTo(local, FTP_REMOTE_PATH);
    console.log(`OK: ${fs.statSync(local).size.toLocaleString("es-ES")} bytes.`);
  } catch (err) {
    console.error("Error FTP:", err);
    process.exit(1);
  } finally {
    client.close();
  }
})();
