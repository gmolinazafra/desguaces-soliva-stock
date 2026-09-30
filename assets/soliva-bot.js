/* ================== Desguaces Soliva · soliva-bot.js ==================
   Soliva Bot: asistente de recambios SIN IA (solo reglas).
   Mismo comportamiento que PiezaBot de Red Desguace, adaptado a un sitio
   estático: en lugar de la RPC fn_piezabot_search busca en el índice que
   ya carga assets/app.js (state.index), con búsqueda en cascada:
   del término más específico al más general, explicando qué se ha relajado.

   · Entiende: nombre de pieza, marca, modelo, año, motor/versión,
     referencia OEM/SKU y bastidor (VIN, por sus 10 primeros caracteres).
   · Recuerda el vehículo durante la conversación.
   · Si no hay stock, deriva a WhatsApp con la consulta ya escrita.

   Requiere que assets/app.js se cargue ANTES (usa state, COL, openProduct…).
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- configuración editable ---------- */
  var BOT = {
    nombre: "Soliva Bot",
    avatar: "assets/soliva-bot.webp",
    whatsapp: "34649903695",          // respaldo si app.js no está disponible
    telefono: "+34649903695",
    telefonoTexto: "649 903 695",
    horario: "",                       // p. ej. "Lunes a viernes de 9 a 14 h y de 16 a 19 h". Vacío = se deriva a WhatsApp
    direccion: "",                     // p. ej. "Calle …, Málaga". Vacío = se deriva a WhatsApp
    limite: 8,                         // resultados por respuesta (igual que PiezaBot)
    chips: ["Motor", "Caja de cambios", "Faro", "Retrovisor", "Centralita"]
  };

  var BIENVENIDA =
    "¡Hola! Soy " + BOT.nombre + " 🤖 Escribe el **nombre de la pieza**, una **referencia OEM**, " +
    "el **bastidor (VIN)** o la **marca y el modelo** de tu vehículo y compruebo el stock al instante.";

  /* ---------- acceso a lo que expone app.js ---------- */
  function app() {
    try {
      if (typeof state === "undefined" || !state || !state.index) return null;
      return state;
    } catch (e) { return null; }
  }
  function C() { try { return COL; } catch (e) { return { id:0, fIdx:1, maIdx:2, mo:3, y0:4, y1:5, p:6, h:7, art:8, t:9, u:10, im0:11 }; } }

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/(\d),(\d)/g, "$1.$2")
      .replace(/\s+/g, " ")
      .trim();
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"); }
  function waUrl(texto) {
    try { if (typeof whatsappUrl === "function") return whatsappUrl(texto); } catch (e) {}
    return "https://wa.me/" + BOT.whatsapp + "?text=" + encodeURIComponent(texto);
  }
  function euros(p) {
    try { if (p && p > 0 && typeof precioIva === "function") return precioIva(p).conIva + " IVA inc."; } catch (e) {}
    return "Consultar";
  }
  function titulo(s) { s = String(s || "").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- vocabulario ---------- */
  var RELLENO = {};
  ("de del la el los las un una unos unas en con para por y o a al su sus mi mis me te se que lo " +
   "busco buscando necesito necesitaria quiero queria quisiera tienes teneis tiene tienen hay habria " +
   "hola buenas buenos dias tardes noches gracias favor porfa pieza piezas recambio recambios repuesto repuestos " +
   "coche moto furgoneta vehiculo ano año modelo marca algun alguna si es esta estoy stock disponible disponibles " +
   "saber ver comprar precio cuanto cuesta vale como").split(" ").forEach(function (w) { RELLENO[w] = 1; });

  var LADOS = {
    izq: "izquierd", izqdo: "izquierd", izqda: "izquierd", izquierdo: "izquierd", izquierda: "izquierd",
    dcho: "derech", dcha: "derech", der: "derech", derecho: "derech", derecha: "derech",
    delantero: "delanter", delantera: "delanter", delanteros: "delanter", delanteras: "delanter",
    trasero: "traser", trasera: "traser", traseros: "traser", traseras: "traser",
    superior: "superior", inferior: "inferior"
  };
  var ES_LADO = { izquierd: 1, derech: 1, delanter: 1, traser: 1, superior: 1, inferior: 1 };

  var MOTOR = {};
  ("tdi tdci hdi dci cdti cdi crdi jtd jtdm tsi tfsi fsi gti gtd sdi dti d4d vtec mpi gdi tce " +
   "diesel gasolina hibrido electrico turbodiesel automatico manual cv kw").split(" ").forEach(function (w) { MOTOR[w] = 1; });

  /* Sinónimos: solo se prueban si la búsqueda original no da NADA.
     Apuntan a la palabra que usa el catálogo; nada de genéricos peligrosos. */
  var SINONIMOS = {
    parachoques: "paragolpes", parachoque: "paragolpes", defensa: "paragolpes",
    espejo: "retrovisor", espejos: "retrovisor", optica: "faro", opticas: "faro", foco: "faro", focos: "faro",
    intermitente: "piloto", intermitentes: "piloto", ecu: "centralita", uce: "centralita",
    alzacristales: "elevalunas", maletero: "porton", rueda: "llanta", ruedas: "llanta",
    marcador: "cuadro instrumentos", reloj: "cuadro instrumentos", relojes: "cuadro instrumentos"
  };

  /* Descriptores de carrocería que aparecen en nombres de modelo pero no identifican un modelo. */
  var NO_MODELO = {};
  ("caja cerrada abierta furgon berlina familiar puertas puerta combi chasis cabina doble largo corto techo alto bajo " +
   "kasten turismo monovolumen volquete plataforma motor cambio cambios mixta mixto isotermo frigorifico").split(" ")
    .forEach(function (w) { NO_MODELO[w] = 1; });

  var ALIAS_MARCA = {
    vw: "volkswagen", volkswagen: "volkswagen", wolkswagen: "volkswagen", volswagen: "volkswagen",
    mercedes: "mercedes", benz: "mercedes", merche: "mercedes", chevy: "chevrolet",
    alfa: "alfa romeo", landrover: "land rover", citroen: "citroen", bmv: "bmw", "b.m.w": "bmw"
  };

  /* ---------- catálogo: marcas y palabras de modelo ---------- */
  var cacheMarcas = null, cachePalabras = null, cacheDe = null;
  function prepararCatalogo(st) {
    if (cacheDe === st.index && cacheMarcas) return;
    cacheDe = st.index;
    cacheMarcas = (st.index.brands || []).map(function (b, i) { return { i: i, nombre: b, n: norm(b).replace(/-/g, " ") }; })
      .filter(function (b) { return b.n.length >= 2; })
      .sort(function (a, b) { return b.n.length - a.n.length; });
    cachePalabras = { todas: {}, porMarca: {}, veces: {} };
    var mbb = (st.meta && st.meta.modelsByBrand) || {};
    Object.keys(mbb).forEach(function (marca) {
      var set = {};
      (mbb[marca] || []).forEach(function (mo) {
        norm(mo).split(/[^a-z0-9]+/).forEach(function (w) {
          if (w.length >= 2 && !RELLENO[w] && !MOTOR[w] && !NO_MODELO[w] && !set[w]) {
            set[w] = 1; cachePalabras.todas[w] = 1;
            cachePalabras.veces[w] = (cachePalabras.veces[w] || 0) + 1;
          }
        });
      });
      cachePalabras.porMarca[marca] = set;
    });
  }
  function marcaPorNombre(n) {
    for (var k = 0; k < cacheMarcas.length; k++) {
      var b = cacheMarcas[k];
      if (b.n === n || b.n.indexOf(n) === 0) return b;
    }
    return null;
  }

  /* ---------- interpretación de la consulta ---------- */
  function interpretar(texto, st) {
    prepararCatalogo(st);
    var n = " " + norm(texto).replace(/[,;:!?¿¡()"']/g, " ").replace(/-/g, " ").replace(/\s+/g, " ") + " ";
    var r = { marca: null, modelo: [], anio: null, pieza: [], extra: [], ref: false, orig: {} };

    // marca (nombres completos, el más largo primero)
    for (var k = 0; k < cacheMarcas.length; k++) {
      var b = cacheMarcas[k];
      if (n.indexOf(" " + b.n + " ") !== -1) { r.marca = b; n = n.replace(" " + b.n + " ", " "); break; }
    }
    if (!r.marca) {
      var alias = Object.keys(ALIAS_MARCA);
      for (var a = 0; a < alias.length; a++) {
        if (n.indexOf(" " + alias[a] + " ") !== -1) {
          var m = marcaPorNombre(ALIAS_MARCA[alias[a]]);
          if (m) { r.marca = m; n = n.replace(" " + alias[a] + " ", " "); break; }
        }
      }
    }

    // año
    var y = n.match(/ (19[5-9]\d|20[0-4]\d) /);
    if (y) { r.anio = parseInt(y[1], 10); n = n.replace(y[0], " "); }

    var palabrasModelo = r.marca ? (cachePalabras.porMarca[r.marca.nombre] || {}) : cachePalabras.todas;
    var previa = "";
    n.trim().split(" ").forEach(function (w) {
      if (!w) return;
      // "clase a", "serie 3": la palabra siguiente forma parte del modelo
      if ((previa === "clase" || previa === "serie") && w.length <= 3) { previa = w; r.modelo.push(w); return; }
      previa = w;
      if (RELLENO[w]) return;
      if (LADOS[w]) { r.pieza.push(LADOS[w]); return; }
      var conDigito = /\d/.test(w);
      if (conDigito && w.replace(/[^a-z0-9]/g, "").length >= 6) { r.pieza.push(w); r.ref = true; return; } // referencia OEM/SKU
      if (MOTOR[w] || /^\d\.\d/.test(w) || /^\d+(v|cv|kw)$/.test(w)) { r.extra.push(w); return; }
      // sin marca, una palabra solo cuenta como modelo si es propia de pocas marcas
      if (palabrasModelo[w] && (r.marca || (cachePalabras.veces[w] || 0) <= 5)) { r.modelo.push(w); return; }
      if (conDigito) { r.extra.push(w); return; }
      // plural → raíz (la búsqueda es por subcadena: "retrovisor" casa con "retrovisores")
      var raiz = w;
      if (w.length > 5 && /es$/.test(w)) raiz = w.slice(0, -2);
      else if (w.length > 4 && /s$/.test(w)) raiz = w.slice(0, -1);
      r.orig[raiz] = w;
      r.pieza.push(raiz);
    });
    return r;
  }

  /* ---------- búsqueda sobre el índice local ---------- */
  function buscar(st, tokens, marcaIdx, anio) {
    var col = C(), rows = st.index.rows, out = [];
    var toks = tokens.map(function (t) { return { t: t, corto: t.length <= 2 }; });
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (marcaIdx != null && row[col.maIdx] !== marcaIdx) continue;
      if (anio != null) {
        var ini = row[col.y0] != null ? row[col.y0] : row[col.y1];
        var fin = row[col.y1] != null ? row[col.y1] : row[col.y0];
        if (ini == null || fin == null || anio < ini || anio > fin) continue;
      }
      var t = row[col.t] || "", ok = true;
      for (var k = 0; k < toks.length; k++) {
        if (toks[k].corto ? (" " + t + " ").indexOf(" " + toks[k].t + " ") === -1 : t.indexOf(toks[k].t) === -1) { ok = false; break; }
      }
      if (ok) out.push(i);
    }
    out.sort(function (a, b) {
      var d = (rows[b][col.h] || 0) - (rows[a][col.h] || 0);
      return d !== 0 ? d : (rows[b][col.u] || 0) - (rows[a][col.u] || 0);
    });
    return out;
  }

  /* Cascada: del más específico al más general. Los lados (izquierdo,
     delantero…) y las referencias NUNCA se relajan. */
  function cascada(st, q) {
    var P = q.pieza, M = q.modelo, E = q.extra, mi = q.marca ? q.marca.i : null;
    var pasos = [];
    function paso(tokens, marca, anio, nota) {
      if (!tokens.length && marca == null) return;
      var clave = tokens.join(" ") + "|" + marca + "|" + anio;
      for (var k = 0; k < pasos.length; k++) if (pasos[k].clave === clave) return;
      pasos.push({ clave: clave, tokens: tokens, marca: marca, anio: anio, nota: nota });
    }
    paso(P.concat(M, E), mi, q.anio, "");
    if (q.anio) paso(P.concat(M, E), mi, null, "sin filtrar por el año " + q.anio);
    if (E.length) paso(P.concat(M), mi, null, "sin filtrar por motor o versión");
    if (M.length > 1) paso(P.concat([M[0]]), mi, null, "para cualquier versión de " + M[0].toUpperCase());
    if (M.length && P.length) paso(P, mi, null, q.marca ? "de otros modelos de " + q.marca.nombre : "de otros modelos");
    if (mi != null && P.length && !q.ref) paso(P, null, null, "de otras marcas");
    pasos = pasos.slice(0, 10);
    for (var n = 0; n < pasos.length; n++) {
      var res = buscar(st, pasos[n].tokens, pasos[n].marca, pasos[n].anio);
      if (res.length) return { nivel: n, paso: pasos[n], filas: res };
    }
    return null;
  }

  function conSinonimos(q) {
    var cambiado = false, pieza = [];
    q.pieza.forEach(function (w) {
      var sin = SINONIMOS[(q.orig && q.orig[w]) || w] || SINONIMOS[w];
      if (sin) { cambiado = true; sin.split(" ").forEach(function (x) { pieza.push(x); }); }
      else pieza.push(w);
    });
    if (!cambiado) return null;
    return { marca: q.marca, modelo: q.modelo, anio: q.anio, pieza: pieza, extra: q.extra, ref: q.ref, orig: {} };
  }

  /* ---------- intenciones (sin búsqueda) ---------- */
  function intencion(texto) {
    var n = norm(texto), pocas = n.split(" ").length <= 4;
    if (/\b(horario|horarios|abris|abiertos?|cerrais|a que hora)\b/.test(n)) return "horario";
    if (/\b(donde estais|donde esta|direccion|ubicacion|como llegar|localizacion)\b/.test(n)) return "direccion";
    if (/\bgarantia/.test(n)) return "garantia";
    if (/\b(envio|envios|enviais|enviar|mandais|portes|mensajeria)\b/.test(n)) return "envio";
    if (/\bdevol/.test(n)) return "devolucion";
    if (/\b(vender|vendo|tasar|tasacion|dar de baja|baja definitiva|achatarrar)\b/.test(n)) return "vender";
    if (/\b(persona|humano|agente|telefono|llamar|llamaros|whatsapp|contacto|contactar)\b/.test(n)) return "contacto";
    if (pocas && /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ey)\b/.test(n) && n.split(" ").length <= 3) return "saludo";
    if (pocas && /\b(gracias|perfecto|genial|vale|ok)\b/.test(n)) return "gracias";
    if (pocas && /\b(adios|hasta luego|chao)\b/.test(n)) return "adios";
    return null;
  }
  function esVin(texto) {
    var s = String(texto).toUpperCase().replace(/[\s.-]/g, "");
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) ? s : null;
  }

  /* ---------- interfaz ---------- */
  var CSS =
    ".svb-fab{position:fixed;right:1rem;bottom:1rem;z-index:950;width:84px;height:96px;border:0;background:transparent;padding:0;cursor:pointer;filter:drop-shadow(0 10px 18px rgba(14,30,63,.28))}" +
    ".svb-fab img{width:100%;height:100%;object-fit:contain;display:block}" +
    ".svb{position:fixed;right:1rem;bottom:7.5rem;z-index:951;width:min(380px,calc(100vw - 2rem));height:min(560px,calc(100vh - 9rem));height:min(560px,calc(100dvh - 9rem));display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(14,30,63,.32);overflow:hidden;font:400 .92rem/1.45 var(--sv-body,Inter,system-ui,sans-serif);color:var(--sv-ink,#1B2333)}" +
    ".svb[hidden]{display:none}" +
    ".svb-head{flex:none;background:var(--sv-navy,#0E1E3F);color:#fff;display:flex;align-items:center;gap:.7rem;padding:.7rem 1rem}" +
    ".svb-head img{width:40px;height:46px;object-fit:contain}" +
    ".svb-head b{display:block;font:800 1.05rem var(--sv-display,inherit)}" +
    ".svb-head small{display:block;color:#C7D0E2;font-size:.76rem}" +
    ".svb-head button{margin-left:auto;background:transparent;border:0;color:#fff;font-size:1.6rem;line-height:1;cursor:pointer;padding:.2rem .45rem;border-radius:8px}" +
    ".svb-log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem;background:var(--sv-mist,#F3F5F9)}" +
    ".svb-m{max-width:88%;padding:.65rem .85rem;border-radius:4px 14px 14px 14px;background:#fff;box-shadow:0 1px 2px rgba(14,30,63,.08);align-self:flex-start;overflow-wrap:anywhere}" +
    ".svb-m.yo{align-self:flex-end;background:var(--sv-navy,#0E1E3F);color:#fff;border-radius:14px 4px 14px 14px}" +
    ".svb-m.ancho{max-width:100%;width:100%;box-sizing:border-box}" +
    ".svb-dots span{display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:#9AA6BF;animation:svb-d 1s infinite}" +
    ".svb-dots span:nth-child(2){animation-delay:.15s}.svb-dots span:nth-child(3){animation-delay:.3s}" +
    "@keyframes svb-d{50%{opacity:.25}}" +
    ".svb-res{display:grid;gap:.45rem;margin-top:.6rem}" +
    ".svb-r{display:grid;grid-template-columns:56px 1fr;gap:.6rem;align-items:center;text-align:left;width:100%;border:1.5px solid var(--sv-line,#E1E6EE);background:#fff;border-radius:12px;padding:.4rem;cursor:pointer;font:inherit;color:inherit}" +
    ".svb-r:hover{border-color:var(--sv-orange,#F26A1B)}" +
    ".svb-r .f{width:56px;height:56px;border-radius:8px;background:var(--sv-mist,#F3F5F9) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#9AA6BF;font-size:.62rem;text-align:center;overflow:hidden}" +
    ".svb-r .f img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".svb-r b{display:block;font-size:.88rem;line-height:1.25;color:var(--sv-navy,#0E1E3F)}" +
    ".svb-r small{display:block;color:var(--sv-muted,#5A6478);font-size:.76rem}" +
    ".svb-r i{font-style:normal;font-weight:700;font-size:.84rem;color:var(--sv-orange-d,#D9570C)}" +
    ".svb-acc{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.65rem}" +
    ".svb-b{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:.5rem .9rem;font:700 .82rem var(--sv-body,inherit);text-decoration:none;border:0;cursor:pointer}" +
    ".svb-b.p{background:var(--sv-orange,#F26A1B);color:#fff}.svb-b.p:hover{background:var(--sv-orange-d,#D9570C)}" +
    ".svb-b.g{background:#fff;color:var(--sv-navy,#0E1E3F);box-shadow:inset 0 0 0 1.5px var(--sv-navy,#0E1E3F)}" +
    ".svb-chips{flex:none;display:flex;gap:.4rem;overflow-x:auto;padding:.55rem 1rem 0;background:#fff}" +
    ".svb-chips button{flex:none;border:1.5px solid var(--sv-line,#E1E6EE);background:#fff;border-radius:999px;padding:.35rem .7rem;font:600 .8rem var(--sv-body,inherit);color:var(--sv-navy,#0E1E3F);cursor:pointer}" +
    ".svb-chips button:hover{border-color:var(--sv-orange,#F26A1B)}" +
    ".svb-form{flex:none;display:flex;gap:.4rem;padding:.6rem 1rem .8rem;background:#fff}" +
    ".svb-form input{flex:1;min-width:0;border:1.5px solid var(--sv-line,#E1E6EE);border-radius:999px;padding:.65rem .9rem;font:500 .92rem var(--sv-body,inherit);color:inherit}" +
    ".svb-form input:focus{outline:0;border-color:var(--sv-orange,#F26A1B)}" +
    ".svb button:focus-visible,.svb a:focus-visible,.svb-fab:focus-visible{outline:3px solid var(--sv-orange,#F26A1B);outline-offset:2px}" +
    "@media (max-width:640px){.svb-fab{width:60px;height:70px;right:.5rem;bottom:.5rem}.svb-fab.abierto{display:none}" +
    ".svb{z-index:1000;top:.5rem;right:.5rem;bottom:.5rem;left:.5rem;width:auto;height:auto;max-height:none}.svb-form input{font-size:16px}}" +
    "@media (prefers-reduced-motion:reduce){.svb-dots span{animation:none}}";

  var el = {}, ctx = null, saludado = false, ocupado = false;

  function montar() {
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    el.fab = document.createElement("button");
    el.fab.type = "button";
    el.fab.className = "svb-fab";
    el.fab.setAttribute("aria-label", "Abrir " + BOT.nombre);
    el.fab.setAttribute("aria-expanded", "false");
    el.fab.innerHTML = '<img src="' + BOT.avatar + '" alt="" width="517" height="600">';

    el.panel = document.createElement("div");
    el.panel.className = "svb";
    el.panel.hidden = true;
    el.panel.setAttribute("role", "dialog");
    el.panel.setAttribute("aria-label", BOT.nombre);
    el.panel.innerHTML =
      '<div class="svb-head"><img src="' + BOT.avatar + '" alt="" width="517" height="600">' +
      "<div><b>" + esc(BOT.nombre) + "</b><small>Busca en el stock real del desguace</small></div>" +
      '<button type="button" aria-label="Cerrar ' + esc(BOT.nombre) + '">×</button></div>' +
      '<div class="svb-log" aria-live="polite"></div>' +
      '<div class="svb-chips"></div>' +
      '<div class="svb-form"><input type="text" autocomplete="off" maxlength="100" placeholder="Ej.: faro derecho Golf 2015" aria-label="Escribe qué pieza buscas">' +
      '<button type="button" class="svb-b p">Enviar</button></div>';

    document.body.appendChild(el.fab);
    document.body.appendChild(el.panel);
    el.log = el.panel.querySelector(".svb-log");
    el.chips = el.panel.querySelector(".svb-chips");
    el.input = el.panel.querySelector(".svb-form input");
    el.enviar = el.panel.querySelector(".svb-form button");

    el.fab.addEventListener("click", function () { abrir(el.panel.hidden); });
    el.panel.querySelector(".svb-head button").addEventListener("click", function () { abrir(false); el.fab.focus(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !el.panel.hidden) { abrir(false); el.fab.focus(); }
    });
    el.enviar.addEventListener("click", enviar);
    el.input.addEventListener("keydown", function (e) { if (e.key === "Enter") enviar(); });
    el.chips.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.accion === "otro") { ctx = null; pintarChips(); decir("De acuerdo, empezamos de cero. ¿Para qué vehículo o qué pieza buscas?"); return; }
      procesar(b.textContent);
    });
    pintarChips();
  }

  function abrir(si) {
    el.panel.hidden = !si;
    el.fab.setAttribute("aria-expanded", si ? "true" : "false");
    el.fab.classList.toggle("abierto", !!si);
    if (si) {
      if (!saludado) { saludado = true; decir(BIENVENIDA); }
      el.input.focus();
    }
  }
  function pintarChips() {
    var html = BOT.chips.map(function (c) { return '<button type="button">' + esc(c) + "</button>"; }).join("");
    if (ctx) html = '<button type="button" data-accion="otro">Otro vehículo</button>' + html;
    el.chips.innerHTML = html;
  }
  function burbuja(html, clase) {
    var d = document.createElement("div");
    d.className = "svb-m" + (clase ? " " + clase : "");
    d.innerHTML = html;
    el.log.appendChild(d);
    el.log.scrollTop = el.log.scrollHeight;
    return d;
  }
  function decir(texto, extraHtml, ancho) { return burbuja(md(texto) + (extraHtml || ""), ancho ? "ancho" : ""); }
  function botonWa(consulta, etiqueta) {
    var t = "Hola, escribo desde la web de Desguaces Soliva (desguacessoliva.com). " + consulta;
    return '<a class="svb-b p" target="_blank" rel="noopener" href="' + esc(waUrl(t)) + '">' + esc(etiqueta || "Preguntar por WhatsApp") + "</a>";
  }
  function acciones(html) { return '<div class="svb-acc">' + html + "</div>"; }

  function enviar() {
    var t = el.input.value.trim();
    if (!t) { el.input.focus(); return; }
    el.input.value = "";
    procesar(t);
  }

  function esperarIndice(cb) {
    var intentos = 0;
    (function mirar() {
      var st = app();
      if (st && (st.indexFull || intentos > 27)) return cb(st);
      if (!st && intentos > 27) return cb(null);
      intentos++;
      setTimeout(mirar, 300);
    })();
  }

  function procesar(texto) {
    if (ocupado) return;
    texto = String(texto).trim();
    burbuja(esc(texto), "yo");
    if (texto.length < 2) { decir("Escribe al menos 2 caracteres para buscar."); return; }

    var vin = esVin(texto);
    var que = vin ? null : intencion(texto);
    if (que) { responderIntencion(que, texto); return; }

    ocupado = true;
    var puntos = burbuja('<span class="svb-dots"><span></span><span></span><span></span></span>');
    esperarIndice(function (st) {
      setTimeout(function () {
        puntos.remove();
        ocupado = false;
        if (!st) {
          decir("Ahora mismo no puedo consultar el catálogo. Escríbenos y te lo miramos al momento.", acciones(botonWa("Busco: " + texto)));
          return;
        }
        if (vin) responderVin(st, vin); else responderBusqueda(st, texto);
      }, 250);
    });
  }

  function responderIntencion(que, texto) {
    var wa = acciones(botonWa("Tengo una consulta: " + texto) + '<a class="svb-b g" href="tel:' + BOT.telefono + '">Llamar ' + BOT.telefonoTexto + "</a>");
    switch (que) {
      case "saludo": decir("¡Hola! Dime qué pieza buscas y para qué vehículo (marca, modelo y año) y miro el stock."); break;
      case "gracias": decir("¡A ti! Si necesitas otra pieza, escríbela aquí."); break;
      case "adios": decir("¡Hasta pronto!"); break;
      case "horario":
        if (BOT.horario) decir("Nuestro horario: **" + BOT.horario + "**."); else decir("El horario te lo confirmamos al momento por WhatsApp o teléfono.", wa);
        break;
      case "direccion":
        if (BOT.direccion) decir("Estamos en **" + BOT.direccion + "**."); else decir("Te pasamos la ubicación por WhatsApp.", wa);
        break;
      case "garantia": decir("Las piezas de segunda mano tienen **1 año de garantía** para particulares y **6 meses** para profesionales. Respondemos directamente ante cualquier defecto de la pieza."); break;
      case "envio": decir("Esta web es un escaparate: la compra y el envío se acuerdan por WhatsApp tras confirmar disponibilidad y estado de la pieza.", wa); break;
      case "devolucion": decir("Las devoluciones se gestionan directamente con nosotros. Cuéntanos el caso y lo vemos.", wa); break;
      case "vender": decir("Para vender tu vehículo o darlo de baja, escríbenos con marca, modelo, año y estado, y te respondemos.", acciones(botonWa("Quiero vender o dar de baja mi vehículo: ", "Escribir por WhatsApp"))); break;
      default: decir("Puedes hablar con nosotros por WhatsApp o por teléfono.", wa);
    }
  }

  function etiquetaVehiculo(q) {
    var p = [];
    if (q.marca) p.push(q.marca.nombre);
    if (q.modelo.length) p.push(q.modelo.join(" ").toUpperCase());
    if (q.extra.length) p.push(q.extra.join(" ").toUpperCase());
    if (q.anio) p.push(String(q.anio));
    return p.join(" ");
  }

  function responderVin(st, vin) {
    var cargar;
    try { cargar = getVehiculos(); } catch (e) { cargar = Promise.resolve({}); }
    var puntos = burbuja('<span class="svb-dots"><span></span><span></span><span></span></span>');
    Promise.resolve(cargar).then(function (vehiculos) {
      puntos.remove();
      var pref = vin.slice(0, 10), v = null;
      Object.keys(vehiculos || {}).some(function (k) {
        if (vehiculos[k] && vehiculos[k].bas === pref) { v = vehiculos[k]; return true; }
        return false;
      });
      if (!v || !v.ma) {
        decir("🔑 No tengo en stock un vehículo que coincida con ese bastidor. Dime **marca, modelo y año**, o envíanos el bastidor y confirmamos la compatibilidad.",
          acciones(botonWa("Mi bastidor es " + vin + ". Busco: ", "Enviar bastidor por WhatsApp")));
        return;
      }
      prepararCatalogo(st);
      var marca = marcaPorNombre(norm(v.ma).replace(/-/g, " "));
      var modelo = norm(v.mo || "").split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 2; }).slice(0, 2);
      ctx = { marca: marca, modelo: modelo, anio: v.an || null, extra: [] };
      pintarChips();
      decir("🔑 Por el bastidor, tu vehículo coincide con un **" + [v.ma, v.mo, v.an].filter(Boolean).join(" ") + "** que tenemos despiezado. ¿Qué pieza necesitas?");
    }).catch(function () {
      puntos.remove();
      decir("No he podido comprobar el bastidor. Envíanoslo y lo miramos.", acciones(botonWa("Mi bastidor es " + vin + ". Busco: ", "Enviar bastidor por WhatsApp")));
    });
  }

  function responderBusqueda(st, texto) {
    var q = interpretar(texto, st);
    var traeVehiculo = !!(q.marca || q.modelo.length);

    // memoria de vehículo
    if (traeVehiculo) {
      ctx = { marca: q.marca, modelo: q.modelo, anio: q.anio, extra: q.extra };
    } else if (ctx && !q.ref) {
      q.marca = ctx.marca; q.modelo = ctx.modelo;
      if (!q.anio) q.anio = ctx.anio;
      if (!q.extra.length) q.extra = ctx.extra || [];
    }
    pintarChips();

    if (!q.pieza.length && !q.marca && !q.modelo.length) {
      decir("No he entendido qué pieza buscas. Prueba con el nombre de la pieza y tu vehículo, por ejemplo **faro derecho Seat Ibiza 2012**, o con una referencia OEM.",
        acciones(botonWa("Busco: " + texto)));
      return;
    }

    var r = cascada(st, q), usadoSinonimo = false;
    if (!r) {
      var q2 = conSinonimos(q);
      if (q2) { r = cascada(st, q2); if (r) { usadoSinonimo = true; q = q2; } }
    }

    var veh = etiquetaVehiculo(q);
    var legible = function (w) {
      if (w === "superior" || w === "inferior") return w;
      return ES_LADO[w] ? w + "o" : ((q.orig && q.orig[w]) || w);
    };
    var nombrePieza = q.pieza.map(legible).join(" ");

    if (!r) {
      decir("No encontré **" + (nombrePieza || "piezas") + "**" + (veh ? " para **" + veh + "**" : "") +
        " en el catálogo. El stock cambia a diario: pregúntanos y lo comprobamos en el almacén.",
        acciones(botonWa("Busco: " + texto + (veh && texto.toUpperCase().indexOf(veh) === -1 ? " (" + veh + ")" : ""))));
      return;
    }

    // solo vehículo, sin pieza: se anota y se pregunta
    if (!q.pieza.length) {
      decir("Anotado: **" + veh + "**. Tengo **" + r.filas.length.toLocaleString("es-ES") + "** " + (r.filas.length !== 1 ? "piezas" : "pieza") +
        (r.nivel > 0 && r.paso.nota ? " (" + r.paso.nota + ")" : "") + ". ¿Qué pieza necesitas? Estas son las últimas:",
        tarjetas(st, r, texto), true);
      return;
    }

    var total = r.filas.length.toLocaleString("es-ES");
    var cab;
    if (q.ref) cab = "🔩 Encontrado por referencia — **" + total + "** resultado" + (r.filas.length !== 1 ? "s" : "");
    else if (r.nivel === 0) cab = "🔍 Tengo **" + total + "** " + (r.filas.length !== 1 ? "piezas" : "pieza") + (veh ? " para **" + veh + "**" : "") + ":";
    else cab = "No tengo exactamente lo que pides" + (veh ? " para **" + veh + "**" : "") + ", pero sí **" + total + "** " +
      (r.filas.length !== 1 ? "piezas" : "pieza") + " " + r.paso.nota + ":";
    if (usadoSinonimo) cab += "\nLo he buscado como **" + nombrePieza + "**.";
    decir(cab, tarjetas(st, r, texto), true);
  }

  function tarjetas(st, r, texto) {
    var col = C(), rows = st.index.rows, fams = st.index.families, brands = st.index.brands;
    var html = '<div class="svb-res">';
    r.filas.slice(0, BOT.limite).forEach(function (idx) {
      var row = rows[idx], id = row[col.id], foto = null;
      try { if (typeof thumbR2 === "function") foto = thumbR2(id); } catch (e) {}
      if (!foto && row[col.im0]) foto = row[col.im0];
      var anios = (row[col.y0] && row[col.y1] && row[col.y0] !== row[col.y1]) ? row[col.y0] + "-" + row[col.y1] : (row[col.y0] || row[col.y1] || "");
      var vehiculo = [brands[row[col.maIdx]] || "", row[col.mo] || "", anios].filter(Boolean).join(" · ");
      html += '<button type="button" class="svb-r" data-idx="' + idx + '">' +
        '<span class="f"' + (!foto && row[col.h] ? ' data-fam="' + esc(fams[row[col.fIdx]] || "") + '" data-id="' + esc(id) + '"' : "") + ">" +
        (foto ? '<img loading="lazy" alt="" src="' + esc(foto) + '" onerror="this.remove()">' : (row[col.h] ? "" : "Sin foto")) + "</span>" +
        "<span><b>" + esc(titulo(row[col.art] || "Pieza")) + "</b><small>" + esc(vehiculo) + " · REF " + esc(id) + "</small><i>" + esc(euros(row[col.p])) + "</i></span></button>";
    });
    html += "</div>";
    var acc = "";
    if (r.filas.length > BOT.limite) acc += '<button type="button" class="svb-b g" data-ver="1">Ver las ' + r.filas.length.toLocaleString("es-ES") + " en el catálogo</button>";
    acc += botonWa("Busco: " + texto, "Preguntar por WhatsApp");
    html += acciones(acc);

    // enlazar eventos cuando la burbuja exista
    setTimeout(function () {
      var cont = el.log.lastElementChild;
      if (!cont) return;
      cont.querySelectorAll(".svb-r").forEach(function (b) {
        b.addEventListener("click", function () {
          try { openProduct(parseInt(b.dataset.idx, 10)); } catch (e) {}
        });
      });
      var ver = cont.querySelector("[data-ver]");
      if (ver) ver.addEventListener("click", function () { verEnCatalogo(st, r.paso); });
      hidratarFotos(cont);
    }, 0);
    return html;
  }

  /* Fotos que no vienen en el índice: se piden al JSON de su familia (como hace el grid). */
  function hidratarFotos(cont) {
    var pendientes = {};
    cont.querySelectorAll(".f[data-fam]").forEach(function (f) {
      (pendientes[f.dataset.fam] = pendientes[f.dataset.fam] || []).push(f);
    });
    Object.keys(pendientes).forEach(function (fam) {
      var p;
      try { p = getFamily(fam); } catch (e) { return; }
      Promise.resolve(p).then(function (items) {
        var porId = {};
        (items || []).forEach(function (it) { porId[it.id] = it; });
        pendientes[fam].forEach(function (f) {
          var it = porId[f.dataset.id];
          if (it && it.im && it.im[0]) f.innerHTML = '<img loading="lazy" alt="" src="' + esc(it.im[0]) + '" onerror="this.remove()">';
        });
      }).catch(function () {});
    });
  }

  /* Lleva la búsqueda del bot a los filtros del catálogo de la página. */
  function verEnCatalogo(st, paso) {
    var ev = function (id, valor, tipo) {
      var n = document.getElementById(id);
      if (!n) return;
      n.value = valor;
      n.dispatchEvent(new Event(tipo, { bubbles: true }));
    };
    var reset = document.getElementById("reset-filters");
    if (reset) reset.click();
    if (paso.marca != null) ev("f-brand", st.index.brands[paso.marca] || "", "change");
    if (paso.anio) { ev("f-y0", paso.anio, "change"); ev("f-y1", paso.anio, "change"); }
    ev("q", paso.tokens.join(" "), "input");
    abrir(false);
    var cat = document.getElementById("catalogo");
    if (cat) cat.scrollIntoView({ block: "start" });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montar);
  else montar();
})();
