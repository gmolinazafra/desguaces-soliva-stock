/* ================== Desguaces Soliva escaparate · app.js ================== */
/* Catálogo de recambios. Diseñado para 170k+ piezas sin backend.        */

const CONFIG = {
  // Número de WhatsApp en formato internacional sin '+', espacios ni guiones
  whatsappNumber: "34649903695",

  metaUrl:       "data/meta.json",
  indexUrl:      "data/index/all.json",
  vehiculosUrl:  "data/vehiculos.json",
  familyUrl:     fam => `data/familias/${slug(fam)}.json`,

  pageSize: 60,        // piezas por "página" en el grid
  searchDebounce: 200, // ms
};

/* ---------- estado global ---------- */
const state = {
  meta: null,            // {families, brands, modelsByBrand, yearMin, yearMax, ...}
  index: null,           // {cols, families, brands, rows: [...]}
  vehiculos: null,       // {codvehiculo: {ma,mo,ver,...}}  — carga diferida (1ª ficha)
  vehiculosPromise: null,// promesa en curso para evitar descargas duplicadas
  filtered: [],          // array de fila-índice (no de objetos) que cumple los filtros
  pageShown: 0,
  filters: {
    q: "",
    family: "",
    brand: "",
    model: "",
    y0: null,
    y1: null,
  },
  sort: "rel",
  familyCache: new Map(), // familia -> array de piezas completas
};

/* ---------- utilidades ---------- */
function slug(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "otros";
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function formatPrice(n) {
  if (!n || n <= 0) return "Consultar";
  return new Intl.NumberFormat("es-ES", {
    style: "currency", currency: "EUR", maximumFractionDigits: 2,
  }).format(n);
}
function formatKm(n) {
  return new Intl.NumberFormat("es-ES").format(n) + " km";
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function whatsappUrl(text) {
  return `https://wa.me/${CONFIG.whatsappNumber}?text=${encodeURIComponent(text)}`;
}
function vehicleString(ma, mo, y0, y1) {
  const yr = (y0 && y1 && y0 !== y1) ? `${y0}-${y1}` : (y0 || y1 || "");
  return [ma, mo, yr].filter(Boolean).join(" · ");
}

// Normaliza la consulta igual que el índice (build-index.js): minúsculas, sin
// acentos y unificando 1,5 -> 1.5. Debe coincidir EXACTAMENTE con normSearch
// del build para que las búsquedas casen.
function normSearch(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\s+/g, " ")
    .trim();
}

// Palabras de relleno que se ignoran en la búsqueda, para que "motor de
// arranque" case con "MOTOR ARRANQUE" y no rompa por los conectores.
const STOPWORDS = new Set([
  "de","del","la","el","los","las","un","una","unos","unas",
  "en","con","para","por","y","o","a","al","su","sus",
]);

/* ---------- carga inicial ---------- */
async function loadAll() {
  const status = document.getElementById("status");
  try {
    status.textContent = "Cargando catálogo…";

    const [meta, index] = await Promise.all([
      fetch(CONFIG.metaUrl,  { cache: "no-cache" }).then(r => r.json()),
      fetch(CONFIG.indexUrl, { cache: "no-cache" }).then(r => r.json()),
    ]);
    state.meta = meta;
    state.index = index;

    // Hero (formato número con separadores en español)
    document.getElementById("hero-count").textContent =
      new Intl.NumberFormat("es-ES").format(meta.total);
    document.getElementById("hero-brands").textContent = meta.brands.length;
    document.getElementById("hero-updated").textContent = formatDate(meta.updated);

    // Selectores
    populateFamilies(meta);
    populateBrands(meta);
    setYearPlaceholders(meta);

    applyFilters();
  } catch (err) {
    console.error(err);
    status.textContent = "No se pudo cargar el catálogo. Vuelve a intentarlo en unos minutos.";
  }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "long" });
  } catch { return "hoy"; }
}

function populateFamilies(meta) {
  const sel = document.getElementById("f-family");
  for (const f of meta.families) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = `${f} (${meta.familyCounts[f].toLocaleString("es-ES")})`;
    sel.appendChild(opt);
  }
}
function populateBrands(meta) {
  const sel = document.getElementById("f-brand");
  for (const b of meta.brands) {
    const opt = document.createElement("option");
    opt.value = b; opt.textContent = b;
    sel.appendChild(opt);
  }
}
function populateModels(brand) {
  const sel = document.getElementById("f-model");
  sel.innerHTML = "";
  if (!brand) {
    sel.disabled = true;
    sel.innerHTML = `<option value="">— elige marca —</option>`;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = `<option value="">Todos los modelos</option>`;
  for (const m of (state.meta.modelsByBrand[brand] || [])) {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  }
}
function setYearPlaceholders(meta) {
  document.getElementById("f-y0").placeholder = meta.yearMin || "desde";
  document.getElementById("f-y1").placeholder = meta.yearMax || "hasta";
}

/* ---------- filtrado ---------- */
/* Cada fila del índice: [id, fIdx, maIdx, mo, y0, y1, p, h, art, t] */
const COL = { id:0, fIdx:1, maIdx:2, mo:3, y0:4, y1:5, p:6, h:7, art:8, t:9, u:10 };

function applyFilters() {
  if (!state.index) return;
  const { rows, families, brands } = state.index;
  const f = state.filters;

  const q = normSearch(f.q);
  // Búsqueda por palabras (todas deben aparecer), ignorando palabras de relleno.
  let tokens = q ? q.split(/\s+/).filter(Boolean) : null;
  if (tokens) {
    const sinRelleno = tokens.filter(t => !STOPWORDS.has(t));
    // Si la consulta era solo relleno (raro), mantenemos los tokens originales.
    tokens = sinRelleno.length ? sinRelleno : tokens;
  }

  const familyIdx = f.family ? families.indexOf(f.family) : -1;
  const brandIdx  = f.brand  ? brands.indexOf(f.brand)    : -1;
  const model     = f.model || "";
  const y0Filter  = f.y0;
  const y1Filter  = f.y1;

  const out = [];
  // Iteramos sobre TODOS los índices (es un loop sobre 127k arrays cortos: <50ms)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (familyIdx !== -1 && row[COL.fIdx] !== familyIdx) continue;
    if (brandIdx !== -1 && row[COL.maIdx] !== brandIdx) continue;
    if (model && row[COL.mo] !== model) continue;
    // Año: la pieza encaja si su rango [y0,y1] solapa con el rango filtrado
    if (y0Filter != null) {
      const fin = row[COL.y1] ?? row[COL.y0];
      if (fin == null || fin < y0Filter) continue;
    }
    if (y1Filter != null) {
      const ini = row[COL.y0] ?? row[COL.y1];
      if (ini == null || ini > y1Filter) continue;
    }
    if (tokens) {
      const t = row[COL.t];
      let ok = true;
      for (const tk of tokens) { if (!t.includes(tk)) { ok = false; break; } }
      if (!ok) continue;
    }
    out.push(i);
  }

  // Ordenación
  switch (state.sort) {
    case "price-asc":  out.sort((a,b) => (rows[a][COL.p]||0) - (rows[b][COL.p]||0)); break;
    case "price-desc": out.sort((a,b) => (rows[b][COL.p]||0) - (rows[a][COL.p]||0)); break;
    case "year-desc":  out.sort((a,b) => (rows[b][COL.y1]||rows[b][COL.y0]||0) - (rows[a][COL.y1]||rows[a][COL.y0]||0)); break;
    case "year-asc":   out.sort((a,b) => (rows[a][COL.y0]||rows[a][COL.y1]||9999) - (rows[b][COL.y0]||rows[b][COL.y1]||9999)); break;
    case "newest":     out.sort((a,b) => (rows[b][COL.u]||0) - (rows[a][COL.u]||0)); break;
    // 'rel' = orden original del CSV (suele venir por fecha de entrada → más reciente arriba),
    // pero primero las que tienen foto (mejor presentación visual).
    default:
      out.sort((a, b) => {
        const imgDiff = (rows[b][COL.h] || 0) - (rows[a][COL.h] || 0);
        if (imgDiff !== 0) return imgDiff;
        return a - b; // estable: orden original del CSV
      });
  }

  state.filtered = out;
  state.pageShown = 0;
  document.getElementById("result-count").textContent =
    out.length.toLocaleString("es-ES");

  document.getElementById("grid").innerHTML = "";
  document.getElementById("status").style.display = out.length ? "none" : "block";
  document.getElementById("status").textContent = out.length ? "" : "Sin resultados con esos filtros.";
  renderNextPage();
}

/* ---------- render ---------- */
function renderNextPage() {
  const { rows, families, brands } = state.index;
  const grid = document.getElementById("grid");
  const start = state.pageShown;
  const end = Math.min(start + CONFIG.pageSize, state.filtered.length);
  const frag = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const idx = state.filtered[i];
    const row = rows[idx];
    const id     = row[COL.id];
    const family = families[row[COL.fIdx]] || "—";
    const brand  = brands[row[COL.maIdx]]  || "";
    const model  = row[COL.mo] || "";
    const y0 = row[COL.y0], y1 = row[COL.y1];
    const price = row[COL.p];
    const title = capitalizeFirst(row[COL.art] || "Sin nombre");

    const card = document.createElement("article");
    card.className = "card";
    if (!row[COL.h]) card.classList.add("no-img");
    card.dataset.idx = idx;
    card.style.animationDelay = `${Math.min((i - start) * 25, 500)}ms`;
    const mediaInner = row[COL.h]
      ? `<img loading="lazy" src="" data-needs-img="1" alt="${escapeHtml(title)}">`
      : `<div class="card-placeholder"><img src="assets/logo.png" alt="${escapeHtml(title)}" loading="lazy"><span>Sin foto disponible</span></div>`;
    card.innerHTML = `
      <div class="card-media">
        ${mediaInner}
        <span class="badge-ref">REF ${escapeHtml(id)}</span>
      </div>
      <div class="card-body">
        <p class="card-cat">${escapeHtml(family)}</p>
        <h3 class="card-title">${escapeHtml(title)}</h3>
        <p class="card-vehicle">${escapeHtml(vehicleString(brand, model, y0, y1))}</p>
        <div class="card-foot">
          <span class="card-price">${formatPrice(price)}</span>
          <span class="card-year">${y0 || y1 || ""}</span>
        </div>
      </div>
    `;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  state.pageShown = end;

  // Botón cargar más
  const btn = document.getElementById("load-more");
  if (state.pageShown < state.filtered.length) {
    btn.hidden = false;
    btn.textContent = `Mostrar más (${(state.filtered.length - state.pageShown).toLocaleString("es-ES")} restantes)`;
  } else {
    btn.hidden = true;
  }

  // Cargar imágenes de las cards: necesitan la URL real, que está en el JSON de familia.
  // Para no descargar familias enteras solo por ver cards, agrupamos por familia
  // y solo pedimos las que aún no están en cache.
  hydrateImages(start, end);
}

function capitalizeFirst(s) {
  if (!s) return "";
  // El CSV viene en MAYÚSCULAS; ponemos solo la 1ª letra en mayúscula y el resto en minúscula
  // pero respetamos siglas comunes (ABS, EBD, ESP, etc.) que sigan siendo en mayúscula al final.
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/* Carga las URLs de imagen de las cards visibles, agrupadas por familia.
   La URL está en el JSON de familia, no en el índice (para mantenerlo ligero). */
async function hydrateImages(start, end) {
  const { rows, families } = state.index;
  // Mapear: familia -> lista de {id, imgEl}
  const groups = new Map();
  const grid = document.getElementById("grid");
  const cards = grid.querySelectorAll(".card");
  // Cards renderizadas en este lote están al final
  for (let i = start; i < end; i++) {
    const card = cards[i];
    if (!card) continue;
    const img = card.querySelector('img[data-needs-img="1"]');
    if (!img) continue;
    const idx = parseInt(card.dataset.idx, 10);
    const row = rows[idx];
    const family = families[row[COL.fIdx]];
    const id = row[COL.id];
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push({ id, img });
  }
  for (const [family, list] of groups) {
    try {
      const items = await getFamily(family);
      const byId = new Map(items.map(p => [p.id, p]));
      for (const { id, img } of list) {
        const p = byId.get(id);
        if (p && p.im && p.im[0]) {
          img.src = p.im[0];
          img.removeAttribute("data-needs-img");
          img.addEventListener("error", () => { img.style.opacity = ".15"; }, { once: true });
        }
      }
    } catch (e) {
      console.warn("No se pudo cargar familia", family, e);
    }
  }
}

/* Carga JSON de familia bajo demanda y la cachea (en memoria del navegador) */
async function getFamily(family) {
  if (state.familyCache.has(family)) return state.familyCache.get(family);
  // Añadimos buildId como query string para invalidar caché HTTP cuando hay nuevo deploy
  const url = CONFIG.familyUrl(family) + (state.meta?.buildId ? `?v=${state.meta.buildId}` : "");
  const promise = fetch(url, { cache: "no-cache" })
    .then(r => r.ok ? r.json() : Promise.reject(r.status));
  state.familyCache.set(family, promise);
  const items = await promise;
  state.familyCache.set(family, items); // sustituir promesa por datos
  return items;
}

/* Carga el catálogo de vehículos de origen bajo demanda (1ª vez que se abre
   una ficha). Se cachea en memoria; si falla, se devuelve {} para no romper. */
async function getVehiculos() {
  if (state.vehiculos) return state.vehiculos;
  if (state.vehiculosPromise) return state.vehiculosPromise;
  const url = CONFIG.vehiculosUrl + (state.meta?.buildId ? `?v=${state.meta.buildId}` : "");
  state.vehiculosPromise = fetch(url, { cache: "no-cache" })
    .then(r => r.ok ? r.json() : {})
    .then(obj => { state.vehiculos = obj; return obj; })
    .catch(() => { state.vehiculos = {}; return {}; });
  return state.vehiculosPromise;
}

/* Construye el bloque HTML "Vehículo de origen" para la ficha. */
function vehiculoOrigenHTML(veh, cod) {
  if (!veh) return "";
  const row = (label, value) =>
    value ? `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>` : "";

  const titulo = [veh.ma, veh.mo].filter(Boolean).join(" ");
  const fields =
    row("Versión", veh.ver) +
    row("Año", veh.an ? String(veh.an) : "") +
    row("Combustible", veh.comb) +
    row("Cambio", veh.cam) +
    row("Color", veh.col) +
    row("Puertas", veh.pu ? String(veh.pu) : "") +
    row("Kilómetros", veh.km ? formatKm(veh.km) : "") +
    row("Cód. motor", veh.cm) +
    row("Bastidor", veh.bas ? veh.bas + "…" : "") +
    row("Cód. vehículo", cod);

  const fotos = (veh.im && veh.im.length) ? `
    <div class="veh-fotos" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${veh.im.map(u => `
        <button type="button" class="veh-thumb" data-img="${escapeHtml(u)}"
          style="width:64px;height:64px;padding:0;border:1px solid var(--border,#2a2a2a);border-radius:8px;overflow:hidden;cursor:pointer;background:#000">
          <img src="${escapeHtml(u)}" alt="" loading="lazy"
            style="width:100%;height:100%;object-fit:cover" onerror="this.style.opacity=.2">
        </button>`).join("")}
    </div>` : "";

  return `
    <div class="veh-origen" style="margin-top:20px;padding-top:18px;border-top:1px solid var(--border,#2a2a2a)">
      <p class="card-cat">Vehículo de origen</p>
      ${titulo ? `<p class="modal-vehicle" style="margin-top:2px">${escapeHtml(titulo)}</p>` : ""}
      <dl class="modal-meta">${fields}</dl>
      ${fotos}
    </div>`;
}

/* ---------- modal de ficha ---------- */
const modal = document.getElementById("product-modal");
const modalBody = document.getElementById("modal-body");

async function openProduct(idx) {
  const { rows, families, brands } = state.index;
  const row = rows[idx];
  const family = families[row[COL.fIdx]];
  const brand  = brands[row[COL.maIdx]];
  const id     = row[COL.id];

  modalBody.innerHTML = `<div class="modal-info"><p style="font-family:var(--mono);color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase">Cargando ficha…</p></div>`;
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");

  let pieza;
  try {
    const items = await getFamily(family);
    pieza = items.find(p => p.id === id);
  } catch (e) {
    modalBody.innerHTML = `<div class="modal-info"><p>Error cargando la ficha.</p></div>`;
    return;
  }
  if (!pieza) {
    modalBody.innerHTML = `<div class="modal-info"><p>Pieza no encontrada.</p></div>`;
    return;
  }

  // Vehículo de origen (carga diferida del catálogo de vehículos).
  let veh = null;
  if (pieza.cv) {
    try {
      const vehiculos = await getVehiculos();
      veh = vehiculos[pieza.cv] || null;
    } catch { veh = null; }
  }

  const imgs = pieza.im || [];
  const vehTexto = vehicleString(brand, pieza.mo, pieza.y0, pieza.y1);
  const motor = pieza.mt || "—";
  const refVisual = pieza.rv || "—";
  const refCatalogo = pieza.rc || "—";

  // Datos del vehículo de origen para el mensaje de WhatsApp (ayuda al desguace
  // a localizar la pieza por su vehículo donante).
  let vehLineas = "";
  if (veh) {
    const titulo = [veh.ma, veh.mo, veh.an].filter(Boolean).join(" ");
    vehLineas = `\n• Vehículo de origen: ${titulo}`;
    if (veh.bas) vehLineas += `\n• Bastidor: ${veh.bas}…`;
    if (pieza.cv) vehLineas += `\n• Cód. vehículo: ${pieza.cv}`;
  }

  const msg = `Hola, escribo desde la web de Desguaces Soliva (desguacessoliva.com).
Me interesa esta pieza del catálogo:

• ${pieza.art}
• Vehículo: ${vehTexto}${motor !== "—" ? `\n• Motor: ${motor}` : ""}${vehLineas}
• Referencia: ${pieza.id}
• Precio orientativo: ${formatPrice(pieza.p)}

¿Podríais confirmarme disponibilidad y estado? Gracias.`;

  modalBody.innerHTML = `
    <div class="modal-media${imgs.length ? "" : " modal-media-empty"}">
      ${imgs.length
        ? `<img id="modal-main-img" src="${escapeHtml(imgs[0])}" alt="${escapeHtml(pieza.art)}" onerror="this.style.opacity=.15">`
        : `<div class="modal-placeholder">
             <img src="assets/logo.png" alt="">
             <span>Sin foto disponible</span>
             <small>Consulta detalles por WhatsApp</small>
           </div>`}
      ${imgs.length > 1 ? `
        <div class="modal-thumbs">
          ${imgs.slice(0, 5).map((u, i) => `
            <button class="${i === 0 ? "active" : ""}" data-img="${escapeHtml(u)}">
              <img src="${escapeHtml(u)}" alt="">
            </button>
          `).join("")}
        </div>` : ""}
    </div>
    <div class="modal-info">
      <p class="card-cat">${escapeHtml(family)}</p>
      <h2 id="modal-title">${escapeHtml(pieza.art || "Pieza sin nombre")}</h2>
      <p class="modal-vehicle">${escapeHtml(vehTexto) || "Sin vehículo asignado"}</p>

      ${pieza.n ? `<p class="modal-note">${escapeHtml(pieza.n)}</p>` : ""}

      <dl class="modal-meta">
        <div><dt>Referencia</dt><dd>${escapeHtml(pieza.id)}</dd></div>
        <div><dt>Marca</dt><dd>${escapeHtml(brand || "—")}</dd></div>
        <div><dt>Modelo</dt><dd>${escapeHtml(pieza.mo || "—")}</dd></div>
        <div><dt>Años</dt><dd>${pieza.y0 || "?"}${pieza.y1 && pieza.y1 !== pieza.y0 ? ` – ${pieza.y1}` : ""}</dd></div>
        <div><dt>Motor</dt><dd>${escapeHtml(motor)}</dd></div>
        <div><dt>Ref. visual</dt><dd>${escapeHtml(refVisual)}</dd></div>
        <div><dt>Ref. catálogo</dt><dd>${escapeHtml(refCatalogo)}</dd></div>
      </dl>

      ${vehiculoOrigenHTML(veh, pieza.cv)}

      <div class="modal-price-line">
        <span class="modal-price">${formatPrice(pieza.p)}</span>
        <span class="modal-price-note">Precio orientativo</span>
      </div>

      <a class="cta-wa" href="${whatsappUrl(msg)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M17.5 14.4c-.3-.1-1.6-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.2-.7.9-.9 1.1-.2.2-.3.2-.6.1-1.7-.8-2.8-1.5-3.9-3.5-.3-.5.3-.5.8-1.5.1-.2 0-.3 0-.5 0-.1-.6-1.4-.8-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.2-1 .9-1 2.3 0 1.4 1 2.7 1.2 2.9.1.2 2 3.1 5 4.3.7.3 1.2.5 1.7.6.7.2 1.3.2 1.8.1.6-.1 1.6-.7 1.9-1.3.2-.6.2-1.2.1-1.3 0-.1-.2-.2-.5-.3zM12 2A10 10 0 0 0 3.4 17l-1.4 5 5.1-1.3A10 10 0 1 0 12 2zm6 16.1a8.3 8.3 0 0 1-12.7 1.1l-.3-.2-3 .8.8-2.9-.2-.3a8.3 8.3 0 1 1 15.4-1.4 8.3 8.3 0 0 1 0 2.9z"/>
        </svg>
        Consultar por WhatsApp
      </a>
      <p class="cta-note">Se abre WhatsApp con un mensaje predefinido. Sin compromiso.</p>
    </div>
  `;

  // Galería de la PIEZA (cambiar imagen al pulsar miniatura)
  const main = document.getElementById("modal-main-img");
  modalBody.querySelectorAll(".modal-thumbs button").forEach(b => {
    b.addEventListener("click", () => {
      modalBody.querySelectorAll(".modal-thumbs button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      if (main) main.src = b.dataset.img;
    });
  });
  // Fotos del VEHÍCULO de origen: al pulsar, se muestran en la imagen principal.
  modalBody.querySelectorAll(".veh-thumb").forEach(b => {
    b.addEventListener("click", () => {
      if (main) main.src = b.dataset.img;
      modalBody.querySelectorAll(".modal-thumbs button").forEach(x => x.classList.remove("active"));
    });
  });
}

/* ---------- eventos ---------- */
document.getElementById("grid").addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (card) openProduct(parseInt(card.dataset.idx, 10));
});

modal.addEventListener("click", e => {
  if (e.target === modal || e.target.dataset.close !== undefined) modal.close();
});

const debouncedFilter = debounce(applyFilters, CONFIG.searchDebounce);

const $q = document.getElementById("q");
const $qClear = document.getElementById("q-clear");
$q.addEventListener("input", e => {
  state.filters.q = e.target.value;
  $qClear.hidden = !e.target.value;
  debouncedFilter();
});
$qClear.addEventListener("click", () => {
  $q.value = ""; state.filters.q = "";
  $qClear.hidden = true; applyFilters();
});

document.getElementById("f-family").addEventListener("change", e => {
  state.filters.family = e.target.value;
  applyFilters();
});
document.getElementById("f-brand").addEventListener("change", e => {
  state.filters.brand = e.target.value;
  state.filters.model = "";
  populateModels(e.target.value);
  applyFilters();
});
document.getElementById("f-model").addEventListener("change", e => {
  state.filters.model = e.target.value;
  applyFilters();
});
document.getElementById("f-y0").addEventListener("change", e => {
  const v = parseInt(e.target.value, 10);
  state.filters.y0 = Number.isFinite(v) ? v : null;
  applyFilters();
});
document.getElementById("f-y1").addEventListener("change", e => {
  const v = parseInt(e.target.value, 10);
  state.filters.y1 = Number.isFinite(v) ? v : null;
  applyFilters();
});
document.getElementById("sort").addEventListener("change", e => {
  state.sort = e.target.value; applyFilters();
});
document.getElementById("reset-filters").addEventListener("click", () => {
  state.filters = { q:"", family:"", brand:"", model:"", y0:null, y1:null };
  state.sort = "rel";
  document.getElementById("q").value = "";
  $qClear.hidden = true;
  document.getElementById("f-family").value = "";
  document.getElementById("f-brand").value = "";
  populateModels("");
  document.getElementById("f-y0").value = "";
  document.getElementById("f-y1").value = "";
  document.getElementById("sort").value = "rel";
  applyFilters();
});
document.getElementById("load-more").addEventListener("click", renderNextPage);

// WhatsApp links: cabecera + footer
const waMessage = "Hola, escribo desde la web de Desguaces Soliva (desguacessoliva.com). Tengo una consulta sobre el catálogo de recambios:";
const waUrl = whatsappUrl(waMessage);
const $waHeader = document.getElementById("wa-direct");
const $waFooter = document.getElementById("wa-direct-footer");
if ($waHeader) $waHeader.href = waUrl;
if ($waFooter) $waFooter.href = waUrl;

document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- arranque ---------- */
loadAll();
