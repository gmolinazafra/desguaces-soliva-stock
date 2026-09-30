/* ================== Desguaces Soliva · soliva-bot.js ==================
   Soliva Bot: asistente de recambios SIN IA (solo reglas).
   Mismo comportamiento que PiezaBot de Red Desguace, adaptado a un sitio
   estático: en lugar de la RPC fn_piezabot_search busca en el índice que
   ya carga assets/app.js (state.index), con búsqueda en cascada:
   del término más específico al más general, explicando qué se ha relajado.

   · Entiende: nombre de pieza, marca, modelo, año, motor/versión,
     referencia OEM/SKU y bastidor (VIN, por sus 10 primeros caracteres).
   · Saluda según la hora, muestra "escribiendo…" antes de cada respuesta
     (tiempo proporcional al texto) y varía las frases.
   · Flujo guiado: pieza → marca → modelo, o "Tengo una avería".
   · Recuerda el vehículo y admite seguimientos: "más barato", "con foto",
     "y para golf".
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
    limite: 8                          // resultados por respuesta (igual que PiezaBot)
  };

  /* Avería → pieza (tarjeta "Tengo una avería") */
  var AVERIAS = [
    ["No arranca", "motor arranque"], ["No carga la batería", "alternador"],
    ["Se calienta", "radiador"], ["Pierde potencia", "turbo"],
    ["No entran las marchas", "caja cambios"], ["El aire no enfría", "compresor aire"],
    ["La ventanilla no sube", "elevalunas"], ["La puerta no cierra", "cerradura"],
    ["Dirección dura", "bomba direccion"], ["Testigo de motor", "centralita"],
    ["Cuadro apagado", "cuadro instrumentos"], ["El limpia no va", "motor limpia"],
    ["Golpe delantero", "paragolpes delantero"], ["Golpe trasero", "paragolpes trasero"],
    ["Faro roto", "faro"], ["Piloto roto", "piloto"],
    ["Retrovisor roto", "retrovisor"], ["Luna rota", "luna"]
  ];

  /* Frases variadas: nunca repite la última del mismo grupo */
  var FRASES = {
    saludo: ["¡Hola! ¿Qué pieza necesitas?", "¡Hola! Dime qué pieza buscas y para qué vehículo.", "¡Buenas! ¿En qué recambio te ayudo?"],
    gracias: ["¡A ti! Si necesitas otra pieza, escríbela aquí.", "¡De nada! Aquí sigo si te hace falta algo más.", "¡Un placer! ¿Buscamos otra pieza?"],
    adios: ["¡Hasta pronto!", "¡Que vaya bien! Aquí estaremos.", "¡Hasta la próxima!"],
    pidePieza: ["¿Qué pieza necesitas?", "Dime el nombre de la pieza que buscas.", "Perfecto. ¿Qué pieza estás buscando?"],
    pideMarca: ["¿De qué marca es tu vehículo?", "Vale. ¿Qué marca es?", "Entendido. ¿De qué marca?"],
    pideModelo: ["¿Y qué modelo?", "¿Qué modelo es?", "Bien. ¿De qué modelo se trata?"],
    encontrado: ["He encontrado", "Tengo", "Mira, hay", "He localizado"],
    noEntiendo: ["No he entendido qué pieza buscas.", "No me queda claro qué pieza necesitas.", "Perdona, no he pillado qué pieza buscas."],
    reinicio: ["De acuerdo, empezamos de cero.", "Hecho, borrón y cuenta nueva.", "Vale, empezamos otra vez."]
  };
  var ultimaFrase = {};
  function frase(grupo) {
    var lista = FRASES[grupo], i;
    do { i = Math.floor(Math.random() * lista.length); } while (lista.length > 1 && i === ultimaFrase[grupo]);
    ultimaFrase[grupo] = i;
    return lista[i];
  }
  function saludoHora() {
    var h = new Date().getHours();
    if (h >= 6 && h < 14) return "Buenos días";
    if (h >= 14 && h < 21) return "Buenas tardes";
    return "Buenas noches";
  }

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
    ".svb{position:fixed;right:1rem;bottom:7.5rem;z-index:951;width:min(390px,calc(100vw - 2rem));height:min(600px,calc(100vh - 9rem));height:min(600px,calc(100dvh - 9rem));display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(14,30,63,.32);overflow:hidden;font:400 .92rem/1.45 var(--sv-body,Inter,system-ui,sans-serif);color:var(--sv-ink,#1B2333)}" +
    ".svb[hidden]{display:none}" +
    ".svb-head{flex:none;background:var(--sv-navy,#0E1E3F);color:#fff;display:flex;align-items:center;gap:.7rem;padding:.7rem 1rem}" +
    ".svb-head img{width:40px;height:46px;object-fit:contain}" +
    ".svb-head b{display:block;font:800 1.05rem var(--sv-display,inherit)}" +
    ".svb-head small{display:block;color:#C7D0E2;font-size:.76rem}" +
    ".svb-head small::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:#35d07f;margin-right:.35rem}" +
    ".svb-head .svb-hb{background:transparent;border:0;color:#fff;font-size:1.25rem;line-height:1;cursor:pointer;padding:.3rem .45rem;border-radius:8px}" +
    ".svb-head .svb-hb:first-of-type{margin-left:auto}" +
    ".svb-head .svb-hb.x{font-size:1.6rem}" +
    ".svb-log{flex:1;overflow-y:auto;padding:1rem .8rem;display:flex;flex-direction:column;gap:.6rem;background:#ECEFF4}" +
    ".svb-row{display:flex;align-items:flex-end;gap:.45rem}" +
    ".svb-row.yo{justify-content:flex-end}" +
    ".svb-av{flex:none;width:30px;height:30px;border-radius:50%;background:#fff url('" + BOT.avatar + "') center 12%/170% no-repeat;box-shadow:0 1px 2px rgba(14,30,63,.2)}" +
    ".svb-m{max-width:82%;padding:.6rem .8rem;border-radius:14px 14px 14px 4px;background:#fff;box-shadow:0 1px 2px rgba(14,30,63,.10);overflow-wrap:anywhere}" +
    ".svb-row.yo .svb-m{background:#1a1a1a;color:#fff;border-radius:14px 14px 4px 14px;font-weight:500}" +
    ".svb-m.ancho{max-width:none;flex:1;min-width:0}" +
    ".svb-dots{display:inline-flex;gap:4px;padding:.2rem 0}" +
    ".svb-dots span{width:7px;height:7px;border-radius:50%;background:#9AA6BF;animation:svb-d 1.1s infinite}" +
    ".svb-dots span:nth-child(2){animation-delay:.18s}.svb-dots span:nth-child(3){animation-delay:.36s}" +
    "@keyframes svb-d{0%,60%,100%{transform:none;opacity:.45}30%{transform:translateY(-4px);opacity:1}}" +
    ".svb-ops{display:grid;gap:.4rem;margin-top:.6rem}" +
    ".svb-ops.dos{grid-template-columns:1fr 1fr}" +
    ".svb-op{display:flex;align-items:center;gap:.5rem;text-align:left;width:100%;border:1.5px solid var(--sv-line,#E1E6EE);background:#fff;border-radius:12px;padding:.6rem .7rem;font:600 .86rem var(--sv-body,inherit);color:var(--sv-navy,#0E1E3F);cursor:pointer}" +
    ".svb-op:hover{border-color:var(--sv-orange,#F26A1B)}" +
    ".svb-ops.dos .svb-op{font-size:.8rem;padding:.5rem .6rem}" +
    ".svb-tags{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.6rem}" +
    ".svb-tags button{border:1.5px solid var(--sv-line,#E1E6EE);background:#fff;border-radius:999px;padding:.35rem .7rem;font:600 .8rem var(--sv-body,inherit);color:var(--sv-navy,#0E1E3F);cursor:pointer}" +
    ".svb-tags button:hover{border-color:var(--sv-orange,#F26A1B)}" +
    ".svb-usado button{pointer-events:none;opacity:.55}" +
    ".svb-res{display:grid;gap:.45rem;margin-top:.6rem}" +
    ".svb-r{display:grid;grid-template-columns:56px 1fr;gap:.6rem;align-items:center;text-align:left;width:100%;border:1.5px solid var(--sv-line,#E1E6EE);background:#fff;border-radius:12px;padding:.4rem;cursor:pointer;font:inherit;color:inherit}" +
    ".svb-r:hover{border-color:var(--sv-orange,#F26A1B)}" +
    ".svb-r .f{width:56px;height:56px;border-radius:8px;background:var(--sv-mist,#F3F5F9);display:flex;align-items:center;justify-content:center;color:#9AA6BF;font-size:.62rem;text-align:center;overflow:hidden}" +
    ".svb-r .f img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".svb-r b{display:block;font-size:.88rem;line-height:1.25;color:var(--sv-navy,#0E1E3F)}" +
    ".svb-r small{display:block;color:var(--sv-muted,#5A6478);font-size:.76rem}" +
    ".svb-r i{font-style:normal;font-weight:700;font-size:.84rem;color:var(--sv-orange-d,#D9570C)}" +
    ".svb-acc{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.65rem}" +
    ".svb-b{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:.5rem .9rem;font:700 .82rem var(--sv-body,inherit);text-decoration:none;border:0;cursor:pointer}" +
    ".svb-b.p{background:var(--sv-orange,#F26A1B);color:#fff}.svb-b.p:hover{background:var(--sv-orange-d,#D9570C)}" +
    ".svb-b.g{background:#fff;color:var(--sv-navy,#0E1E3F);box-shadow:inset 0 0 0 1.5px var(--sv-navy,#0E1E3F)}" +
    ".svb-form{flex:none;display:flex;gap:.4rem;padding:.65rem .8rem .8rem;background:#fff;border-top:1px solid var(--sv-line,#E1E6EE)}" +
    ".svb-form input{flex:1;min-width:0;border:1.5px solid var(--sv-line,#E1E6EE);border-radius:999px;padding:.65rem .9rem;font:500 .92rem var(--sv-body,inherit);color:inherit}" +
    ".svb-form input:focus{outline:0;border-color:var(--sv-orange,#F26A1B)}" +
    ".svb button:focus-visible,.svb a:focus-visible,.svb-fab:focus-visible{outline:3px solid var(--sv-orange,#F26A1B);outline-offset:2px}" +
    "@media (max-width:640px){.svb-fab{width:60px;height:70px;right:.5rem;bottom:.5rem}.svb-fab.abierto{display:none}" +
    ".svb{z-index:1000;top:.5rem;right:.5rem;bottom:.5rem;left:.5rem;width:auto;height:auto;max-height:none}.svb-form input{font-size:16px}}" +
    "@media (prefers-reduced-motion:reduce){.svb-dots span{animation:none}}";

  var PLACEHOLDER = "Escribe la pieza que buscas…";
  var PLACEHOLDER_SEGUIR = "Prueba: «más barato», «con foto», «y para Golf»";

  var el = {}, ctx = null, saludado = false, cola = Promise.resolve();
  var guia = null;      // flujo guiado: { paso: 'pieza' | 'marca' | 'modelo', pieza, marca }
  var ultima = null;    // última búsqueda con resultados: { st, q, r, texto, pieza }

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
      "<div><b>" + esc(BOT.nombre) + "</b><small>En línea · stock real del desguace</small></div>" +
      '<button type="button" class="svb-hb" data-h="reiniciar" aria-label="Empezar de nuevo" title="Empezar de nuevo">↺</button>' +
      '<button type="button" class="svb-hb x" data-h="cerrar" aria-label="Cerrar ' + esc(BOT.nombre) + '">×</button></div>' +
      '<div class="svb-log" aria-live="polite"></div>' +
      '<div class="svb-form"><input type="text" autocomplete="off" maxlength="100" placeholder="' + PLACEHOLDER + '" aria-label="Escribe tu mensaje">' +
      '<button type="button" class="svb-b p">Enviar</button></div>';

    document.body.appendChild(el.fab);
    document.body.appendChild(el.panel);
    el.log = el.panel.querySelector(".svb-log");
    el.input = el.panel.querySelector(".svb-form input");
    el.enviar = el.panel.querySelector(".svb-form button");

    el.fab.addEventListener("click", function () { abrir(el.panel.hidden); });
    el.panel.querySelector('[data-h="cerrar"]').addEventListener("click", function () { abrir(false); el.fab.focus(); });
    el.panel.querySelector('[data-h="reiniciar"]').addEventListener("click", reiniciar);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !el.panel.hidden) { abrir(false); el.fab.focus(); }
    });
    el.enviar.addEventListener("click", enviar);
    el.input.addEventListener("keydown", function (e) { if (e.key === "Enter") enviar(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", ajustarAlTeclado);
      window.visualViewport.addEventListener("scroll", ajustarAlTeclado);
    }

    // botones dentro de la conversación (tarjeta de bienvenida, averías, marcas, modelos)
    el.log.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-accion],button[data-decir]");
      if (!b) return;
      var grupo = b.closest(".svb-ops,.svb-tags");
      if (grupo) grupo.classList.add("svb-usado");
      if (b.dataset.accion) accion(b.dataset.accion, b);
      else { yo(b.textContent); procesar(b.dataset.decir); }
    });
  }

  function abrir(si) {
    el.panel.hidden = !si;
    el.fab.setAttribute("aria-expanded", si ? "true" : "false");
    el.fab.classList.toggle("abierto", !!si);
    if (si) {
      if (!saludado) { saludado = true; bienvenida(); }
      enfocar();
      ajustarAlTeclado();
    }
  }
  /* En móvil/táctil NO se enfoca el campo: abriría el teclado y taparía el chat.
     El teclado solo sale cuando la persona toca el campo. */
  function esTactil() {
    return window.matchMedia && (window.matchMedia("(pointer:coarse)").matches || window.matchMedia("(max-width:640px)").matches);
  }
  function enfocar() { if (!esTactil()) el.input.focus(); }
  /* Cuando el teclado del móvil está abierto, el panel se encoge a la zona visible
     para que el campo y los últimos mensajes queden por encima del teclado. */
  function ajustarAlTeclado() {
    var vv = window.visualViewport;
    if (!vv || el.panel.hidden || !window.matchMedia("(max-width:640px)").matches) {
      el.panel.style.top = ""; el.panel.style.bottom = ""; return;
    }
    var tapado = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    el.panel.style.top = (vv.offsetTop + 8) + "px";
    el.panel.style.bottom = (tapado + 8) + "px";
    bajar();
  }

  /* ---------- burbujas ---------- */
  function bajar() { el.log.scrollTop = el.log.scrollHeight; }
  function fila(clase) {
    var row = document.createElement("div");
    row.className = "svb-row" + (clase ? " " + clase : "");
    el.log.appendChild(row);
    return row;
  }
  function yo(texto) {
    var row = fila("yo");
    row.innerHTML = '<div class="svb-m">' + esc(texto) + "</div>";
    bajar();
  }
  /* Respuesta del bot: primero los puntos de "escribiendo…", con una espera
     proporcional a la longitud del texto, y después el mensaje. Las
     respuestas se encolan para que salgan una detrás de otra. */
  function bot(texto, extraHtml, opciones) {
    opciones = opciones || {};
    cola = cola.then(function () {
      return new Promise(function (ok) {
        var row = fila();
        row.innerHTML = '<span class="svb-av" aria-hidden="true"></span><div class="svb-m"><span class="svb-dots"><span></span><span></span><span></span></span></div>';
        bajar();
        var espera = Math.max(350, Math.min(1100, 300 + String(texto).length * 9));
        setTimeout(function () {
          var m = row.querySelector(".svb-m");
          if (opciones.ancho) m.classList.add("ancho");
          m.innerHTML = md(texto) + (extraHtml || "");
          if (opciones.despues) opciones.despues(m);
          bajar();
          ok();
        }, espera);
      });
    });
    return cola;
  }
  function botonWa(consulta, etiqueta) {
    var t = "Hola, escribo desde la web de Desguaces Soliva (desguacessoliva.com). " + consulta;
    return '<a class="svb-b p" target="_blank" rel="noopener" href="' + esc(waUrl(t)) + '">' + esc(etiqueta || "Preguntar por WhatsApp") + "</a>";
  }
  function acciones(html) { return '<div class="svb-acc">' + html + "</div>"; }
  function etiquetas(lista, extra) {
    var html = '<div class="svb-tags">';
    lista.forEach(function (t) { html += '<button type="button" data-decir="' + esc(t) + '">' + esc(t) + "</button>"; });
    if (extra) html += '<button type="button" data-decir="' + esc(extra[1]) + '">' + esc(extra[0]) + "</button>";
    return html + "</div>";
  }

  /* ---------- bienvenida y flujo guiado ---------- */
  function tarjetaInicio() {
    return '<div class="svb-ops">' +
      '<button type="button" class="svb-op" data-accion="buscar">🔍 Buscar una pieza</button>' +
      '<button type="button" class="svb-op" data-accion="averia">🔧 Tengo una avería</button>' +
      '<button type="button" class="svb-op" data-accion="ref">🔩 Tengo la referencia o el bastidor</button>' +
      "</div>";
  }
  function bienvenida() {
    bot(saludoHora() + " 👋 Soy **" + BOT.nombre + "**, el asistente de recambios de Desguaces Soliva.");
    bot("¿Cómo te ayudo? También puedes escribir directamente lo que buscas, por ejemplo **faro derecho Seat Ibiza 2012**.", tarjetaInicio(), { ancho: true });
  }
  function reiniciar() {
    ctx = null; guia = null; ultima = null;
    el.input.placeholder = PLACEHOLDER;
    bot(frase("reinicio") + " ¿Cómo te ayudo?", tarjetaInicio(), { ancho: true });
  }
  function accion(cual, boton) {
    yo(boton.textContent.replace(/^[^\wÁÉÍÓÚáéíóú¿]+/, ""));
    if (cual === "buscar") { guia = { paso: "pieza" }; bot(frase("pidePieza")); }
    else if (cual === "averia") {
      var html = '<div class="svb-ops dos">';
      AVERIAS.forEach(function (a) { html += '<button type="button" class="svb-op" data-accion="averia:' + esc(a[1]) + '">' + esc(a[0]) + "</button>"; });
      bot("¿Qué le pasa al vehículo? Elige lo que más se parezca:", html + "</div>", { ancho: true });
    }
    else if (cual === "ref") { guia = null; bot("Escribe la **referencia OEM** de la pieza o el **bastidor** completo (17 caracteres)."); }
    else if (cual.indexOf("averia:") === 0) {
      var pieza = cual.slice(7);
      bot("Para eso lo habitual es revisar **" + pieza + "**. Lo busco en el stock.");
      guia = { paso: "marca", pieza: pieza };
      pedirMarca();
    }
    enfocar();
  }
  function marcasPrincipales(st) {
    var col = C(), rows = st.index.rows, n = {};
    for (var i = 0; i < rows.length; i++) n[rows[i][col.maIdx]] = (n[rows[i][col.maIdx]] || 0) + 1;
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a]; }).slice(0, 10)
      .map(function (k) { return st.index.brands[k]; }).filter(Boolean);
  }
  function modelosPrincipales(st, marcaIdx) {
    var col = C(), rows = st.index.rows, n = {};
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][col.maIdx] !== marcaIdx || !rows[i][col.mo]) continue;
      n[rows[i][col.mo]] = (n[rows[i][col.mo]] || 0) + 1;
    }
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a]; }).slice(0, 10);
  }
  function pedirMarca() {
    var st = app();
    if (ctx && ctx.marca) { pasoFinal(); return; }
    var lista = st ? marcasPrincipales(st) : [];
    bot(frase("pideMarca"), lista.length ? etiquetas(lista, ["Cualquiera", "cualquiera"]) : "", { ancho: lista.length > 0 });
  }
  function pasoFinal(extra) {
    var texto = guia.pieza + (guia.marca ? " " + guia.marca : "") + (extra ? " " + extra : "");
    guia = null;
    lanzarBusqueda(texto);
  }
  /* Devuelve true si el mensaje se ha consumido dentro del flujo guiado */
  function seguirGuia(texto, st) {
    if (!guia) return false;
    var n = norm(texto), ninguno = /^(cualquiera|no lo se|no se|ninguno|da igual|todas?|todos?)$/.test(n);
    if (guia.paso === "pieza") {
      var q = interpretar(texto, st);
      if (q.marca || q.modelo.length || q.ref) { guia = null; return false; }   // ya trae vehículo: búsqueda directa
      if (!q.pieza.length) { bot(frase("noEntiendo") + " Escribe solo el nombre, por ejemplo **alternador**."); return true; }
      guia = { paso: "marca", pieza: texto };
      pedirMarca();
      return true;
    }
    if (guia.paso === "marca") {
      if (ninguno) { pasoFinal(); return true; }
      var qm = interpretar(texto, st);
      if (!qm.marca) {
        if (qm.modelo.length) { pasoFinal(texto); return true; }               // ha escrito directamente el modelo
        bot("No tengo esa marca en el stock. Elige una de la lista o escribe **cualquiera**.");
        return true;
      }
      if (qm.modelo.length) { guia.marca = ""; pasoFinal(texto); return true; } // "seat ibiza"
      guia.paso = "modelo"; guia.marca = qm.marca.nombre; guia.marcaIdx = qm.marca.i;
      var modelos = modelosPrincipales(st, qm.marca.i);
      bot(frase("pideModelo"), modelos.length ? etiquetas(modelos, ["No lo sé", "no lo se"]) : "", { ancho: modelos.length > 0 });
      return true;
    }
    if (guia.paso === "modelo") {
      pasoFinal(ninguno ? "" : texto);
      return true;
    }
    return false;
  }

  /* ---------- entrada del usuario ---------- */
  function enviar() {
    var t = el.input.value.trim();
    if (!t) { enfocar(); return; }
    el.input.value = "";
    yo(t);
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
    texto = String(texto).trim();
    if (texto.length < 2) { bot("Escribe al menos 2 caracteres para buscar."); return; }
    var n = norm(texto);

    if (/^(reiniciar|empezar de nuevo|empezar|otro vehiculo|otro coche|otra moto|menu|inicio)$/.test(n)) { reiniciar(); return; }

    var vin = esVin(texto);
    if (vin) { guia = null; conCatalogo(texto, function (st) { responderVin(st, vin); }); return; }

    if (!guia) {
      var que = intencion(texto);
      if (que) { responderIntencion(que, texto); return; }
      if (seguimiento(texto)) return;
    }
    lanzarBusqueda(texto, true);
  }

  function conCatalogo(texto, cb) {
    cola = cola.then(function () {
      return new Promise(function (ok) {
        esperarIndice(function (st) {
          if (!st) bot("Ahora mismo no puedo consultar el catálogo. Escríbenos y te lo miramos al momento.", acciones(botonWa("Busco: " + texto)));
          else cb(st);
          ok();
        });
      });
    });
  }
  function lanzarBusqueda(texto, conGuia) {
    conCatalogo(texto, function (st) {
      if (conGuia && seguirGuia(texto, st)) return;
      responderBusqueda(st, texto);
    });
  }

  /* ---------- seguimientos tras una búsqueda ---------- */
  function seguimiento(texto) {
    if (!ultima) return false;
    var n = norm(texto), col = C(), rows = ultima.st.index.rows, filas;
    if (/\b(mas barat[oa]s?|barat[oa]s?|economic[oa]s?|menor precio)\b/.test(n)) {
      filas = ultima.r.filas.filter(function (i) { return rows[i][col.p] > 0; })
        .sort(function (a, b) { return rows[a][col.p] - rows[b][col.p]; });
      if (!filas.length) { bot("Esas piezas no tienen precio publicado; te lo confirmamos por WhatsApp.", acciones(botonWa("Busco: " + ultima.texto))); return true; }
      var t = tarjetas(ultima.st, { filas: filas, paso: ultima.r.paso }, ultima.texto);
      bot("El más barato es **" + titulo(rows[filas[0]][col.art]) + "** por **" + euros(rows[filas[0]][col.p]) + "**, y el resto va de menor a mayor precio:", t.html, { ancho: true, despues: t.enlazar });
      return true;
    }
    if (/\b(con fotos?|que tengan? fotos?|solo fotos?)\b/.test(n)) {
      filas = ultima.r.filas.filter(function (i) { return rows[i][col.h]; });
      if (!filas.length) { bot("Ninguna de esas piezas tiene foto publicada. Pídenosla por WhatsApp.", acciones(botonWa("Busco (con foto): " + ultima.texto))); return true; }
      var t2 = tarjetas(ultima.st, { filas: filas, paso: ultima.r.paso }, ultima.texto);
      bot("Estas **" + filas.length.toLocaleString("es-ES") + "** tienen foto:", t2.html, { ancho: true, despues: t2.enlazar });
      return true;
    }
    var m = n.match(/^(?:y |¿y )?(?:para|de|en) (?:un |una |el |la |mi )?(.{2,60})$/);
    if (m && ultima.pieza) {
      var qv = interpretar(m[1], ultima.st);
      if (!qv.marca && !qv.modelo.length) return false;   // no es un vehículo: búsqueda normal
      ctx = null;
      lanzarBusqueda(ultima.pieza + " " + m[1]);
      return true;
    }
    return false;
  }

  function responderIntencion(que, texto) {
    var wa = acciones(botonWa("Tengo una consulta: " + texto) + '<a class="svb-b g" href="tel:' + BOT.telefono + '">Llamar ' + BOT.telefonoTexto + "</a>");
    switch (que) {
      case "saludo": bot(frase("saludo")); break;
      case "gracias": bot(frase("gracias")); break;
      case "adios": bot(frase("adios")); break;
      case "horario":
        if (BOT.horario) bot("Nuestro horario: **" + BOT.horario + "**."); else bot("El horario te lo confirmamos al momento por WhatsApp o teléfono.", wa);
        break;
      case "direccion":
        if (BOT.direccion) bot("Estamos en **" + BOT.direccion + "**."); else bot("Te pasamos la ubicación por WhatsApp.", wa);
        break;
      case "garantia": bot("Las piezas de segunda mano tienen **1 año de garantía** para particulares y **6 meses** para profesionales. Respondemos directamente ante cualquier defecto de la pieza."); break;
      case "envio": bot("Esta web es un escaparate: la compra y el envío se acuerdan por WhatsApp tras confirmar disponibilidad y estado de la pieza.", wa); break;
      case "devolucion": bot("Las devoluciones se gestionan directamente con nosotros. Cuéntanos el caso y lo vemos.", wa); break;
      case "vender": bot("Para vender tu vehículo o darlo de baja, escríbenos con marca, modelo, año y estado, y te respondemos.", acciones(botonWa("Quiero vender o dar de baja mi vehículo: ", "Escribir por WhatsApp"))); break;
      default: bot("Puedes hablar con nosotros por WhatsApp o por teléfono.", wa);
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
    cola = cola.then(function () {
      return Promise.resolve(cargar).then(function (vehiculos) {
        var pref = vin.slice(0, 10), v = null;
        Object.keys(vehiculos || {}).some(function (k) {
          if (vehiculos[k] && vehiculos[k].bas === pref) { v = vehiculos[k]; return true; }
          return false;
        });
        if (!v || !v.ma) {
          setTimeout(function () {
            bot("🔑 No tengo en stock un vehículo que coincida con ese bastidor. Dime **marca, modelo y año**, o envíanos el bastidor y confirmamos la compatibilidad.",
              acciones(botonWa("Mi bastidor es " + vin + ". Busco: ", "Enviar bastidor por WhatsApp")));
          }, 0);
          return;
        }
        prepararCatalogo(st);
        var marca = marcaPorNombre(norm(v.ma).replace(/-/g, " "));
        var modelo = norm(v.mo || "").split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 2; }).slice(0, 2);
        ctx = { marca: marca, modelo: modelo, anio: v.an || null, extra: [] };
        setTimeout(function () {
          bot("🔑 Por el bastidor, tu vehículo coincide con un **" + [v.ma, v.mo, v.an].filter(Boolean).join(" ") + "** que tenemos despiezado. ¿Qué pieza necesitas?");
        }, 0);
      }).catch(function () {
        setTimeout(function () {
          bot("No he podido comprobar el bastidor. Envíanoslo y lo miramos.", acciones(botonWa("Mi bastidor es " + vin + ". Busco: ", "Enviar bastidor por WhatsApp")));
        }, 0);
      });
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

    if (!q.pieza.length && !q.marca && !q.modelo.length) {
      bot(frase("noEntiendo") + " Prueba con el nombre de la pieza y tu vehículo, por ejemplo **faro derecho Seat Ibiza 2012**, o con una referencia OEM.",
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
    var buscado = (nombrePieza + " " + veh).trim();

    if (!r) {
      ultima = null;
      el.input.placeholder = PLACEHOLDER;
      bot("**Sin resultados en el catálogo**\nNo encontré **" + buscado + "** entre las piezas disponibles ahora mismo. El stock cambia a diario: pregúntanos y lo comprobamos en el almacén.",
        acciones(botonWa("Busco: " + buscado)));
      return;
    }

    var t = tarjetas(st, r, texto);

    // solo vehículo, sin pieza: se anota y se pregunta
    if (!q.pieza.length) {
      ultima = null;
      bot("Anotado: **" + veh + "**. Tengo **" + r.filas.length.toLocaleString("es-ES") + "** " + (r.filas.length !== 1 ? "piezas" : "pieza") +
        (r.nivel > 0 && r.paso.nota ? " (" + r.paso.nota + ")" : "") + ". ¿Qué pieza necesitas? Estas son las últimas:",
        t.html, { ancho: true, despues: t.enlazar });
      return;
    }

    // resumen: total, rango de precios y cuántas con foto
    var col = C(), rows = st.index.rows, min = Infinity, max = 0, conFoto = 0;
    r.filas.forEach(function (i) {
      var p = rows[i][col.p];
      if (p > 0) { if (p < min) min = p; if (p > max) max = p; }
      if (rows[i][col.h]) conFoto++;
    });
    var total = r.filas.length;
    var cuantos = "**" + total.toLocaleString("es-ES") + " " + (total !== 1 ? "resultados" : "resultado") + "**";
    var rango = max > 0 ? (min === max ? " por " + euros(min) : " entre " + euros(min).replace(" IVA inc.", "") + " y " + euros(max)) : "";
    var fotos = " (" + conFoto.toLocaleString("es-ES") + " con foto)";
    var cab;
    if (q.ref) cab = "🔩 Encontrado por referencia: " + cuantos + rango + fotos + ".";
    else if (r.nivel === 0) cab = frase("encontrado") + " " + cuantos + " para **" + buscado + "**" + rango + fotos + ".";
    else cab = "No tengo exactamente **" + buscado + "**, pero sí " + cuantos + " " + r.paso.nota + rango + fotos + ".";
    if (usadoSinonimo) cab += "\nLo he buscado como **" + nombrePieza + "**.";

    ultima = { st: st, q: q, r: r, texto: buscado, pieza: nombrePieza };
    el.input.placeholder = PLACEHOLDER_SEGUIR;
    bot(cab, t.html, { ancho: true, despues: t.enlazar });
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

    return {
      html: html,
      enlazar: function (cont) {
        cont.querySelectorAll(".svb-r").forEach(function (b) {
          b.addEventListener("click", function () {
            try { openProduct(parseInt(b.dataset.idx, 10)); } catch (e) {}
          });
        });
        var ver = cont.querySelector("[data-ver]");
        if (ver) ver.addEventListener("click", function () { verEnCatalogo(st, r.paso); });
        hidratarFotos(cont);
      }
    };
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
