# ReciclaCAT — Escaparate de recambios

Sitio estático que muestra el catálogo (177 000+ piezas) servido desde GitHub Pages.
Las consultas se canalizan por WhatsApp; **no es una tienda online**.

- 📦 Stock: descargado del FTP cada 6 h y reindexado automáticamente.
- 🌐 Hosting: GitHub Pages (sin backend).
- 💬 Contacto: enlace WhatsApp con mensaje predefinido por pieza.

---

## Cómo funciona

```
       ┌──────────┐   cada 6 h    ┌──────────────────┐    deploy    ┌──────────────┐
       │   FTP    │ ─────────────►│ GitHub Action    │─────────────►│ GitHub Pages │
       │ stock.csv│               │ sync + build     │              │   (web)      │
       └──────────┘               │ + upload artifact│              └──────────────┘
                                  └──────────────────┘
                                          │
                                          ▼
                                 data/meta.json         (24 KB)  · selectores
                                 data/index/all.json    (~3 MB gz) · búsqueda y filtros
                                 data/familias/*.json   (~1-3 MB gz cada una) · fichas completas

   Los JSONs viven solo en el artifact de Pages, no en el repo (ver .gitignore).
```

El cliente:
1. Descarga `meta.json` + `index/all.json` al cargar (solo una vez, cacheado).
2. Filtra/busca **en local** sobre el índice (instantáneo, ~50 ms para 177 k registros).
3. Cuando abres una ficha, descarga el JSON de **esa familia** bajo demanda y lo cachea.

---

## Estructura

```
.
├─ index.html
├─ assets/
│  ├─ styles.css
│  └─ app.js                  # carga, filtros, modal, WhatsApp
├─ data/
│  ├─ meta.json               # generado: catálogos para selectores
│  ├─ stock.csv               # descargado del FTP (no se commitea, ver .gitignore)
│  ├─ index/
│  │  └─ all.json             # generado: índice ligero (todo el catálogo)
│  └─ familias/
│     ├─ interior.json        # generado: piezas completas por familia
│     ├─ electricidad.json
│     └─ …
├─ scripts/
│  ├─ sync-stock.js           # descarga el CSV del FTP
│  └─ build-index.js          # parte el CSV en JSONs
├─ .github/workflows/
│  └─ sync-stock.yml          # cron 6 h + build + commit
├─ package.json
└─ README.md
```

---

## Configuración inicial

### 1. Personaliza el sitio

Edita `assets/app.js` y cambia el número de WhatsApp:

```js
const CONFIG = {
  whatsappNumber: "34600000000",  // ← formato internacional sin '+', espacios ni guiones
  // …
};
```

### 2. Configura los Secrets del FTP

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret              | Ejemplo                  | Obligatorio |
| ------------------- | ------------------------ | ----------- |
| `FTP_HOST`          | `ftp.midominio.com`      | sí          |
| `FTP_USER`          | `usuario`                | sí          |
| `FTP_PASSWORD`      | `contraseña`             | sí          |
| `FTP_REMOTE_PATH`   | `/exports/stock.csv`     | sí          |
| `FTP_PORT`          | `41` (por defecto: 21)   | opcional    |
| `FTP_SECURE`        | `true` si es FTPS        | opcional    |

### 3. Activa GitHub Pages (modo Actions)

`Settings → Pages → Source: **GitHub Actions**` (no "Deploy from a branch").

> Importante: el sitio **no se sirve desde una rama**. Lo despliega el propio
> workflow tras descargar el CSV y reconstruir los índices. Así los datos
> generados (~70 MB) no engordan el historial del repo.

### 4. Lanza el primer deploy manual

`Actions → Sync stock + deploy to Pages → Run workflow`.

Cuando termine, verás la URL en `Settings → Pages` (típicamente
`https://<usuario>.github.io/<repo>/`).

---

## CSV esperado

El builder está adaptado al export estándar de **CRV NET** (separador `;`):

```
refid;familia;articulo;marca;modelo;modeloinicio;modelofin;motorversion;
cambioversion;refvisual;refcatalogo;attrib1;attrib2;precio;estado;ubicacion;
anopieza;nota;notapublica;ean;peso;fechaentrada;codvehiculo;ordenrevision;
fecharevision;ordenextraccion;fechaextraccion;contenedor;codalmacen;almacen;
fechaalmacen;factualiza;imgs
```

Campos usados en la web: `refid, familia, articulo, marca, modelo, modeloinicio, modelofin, motorversion, precio, notapublica, codalmacen, almacen, imgs`.
El resto se ignora.

`imgs`: lista de URLs separadas por coma. Si está vacío, la pieza se muestra con un placeholder gris ("Sin foto").

---

## Desarrollo local

```bash
npm install
# Pega un stock.csv en data/  (o copia el sample para probar)
npm run build           # genera meta.json + index/ + familias/
npm run serve           # http://localhost:8080
```

> Hay que servirlo con un servidor (Python o `npx serve`); abrir `index.html`
> con doble clic no funciona porque `fetch()` requiere `http://`.

---

## Notas

- El sitio es **informativo**. No hay carrito, ni pagos, ni recogida de datos personales.
- Los precios son orientativos hasta confirmar disponibilidad por WhatsApp.
- El primer arranque del cliente descarga ~3 MB (índice gzip). Las familias se cargan
  bajo demanda solo cuando el usuario interactúa con piezas de esa familia.
- Si el CSV cambia mucho de estructura, basta con tocar `scripts/build-index.js`.
