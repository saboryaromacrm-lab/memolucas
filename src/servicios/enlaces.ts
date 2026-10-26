import dns from "node:dns/promises";
import net from "node:net";
import { imagenParaIa } from "./adjuntos.js";

/** Se identifica tal cual es: el bot de Memolucas leyendo un link que le mandó su dueño. */
const AGENTE = "Mozilla/5.0 (compatible; MemolucasBot/1.0; +https://memolucas.saboryaroma.com)";
const TIEMPO_MS = 12_000;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGEN = 8 * 1024 * 1024;
const MAX_TEXTO = 6000;

export type VistaPreviaWa = { titulo?: string | null; descripcion?: string | null; miniatura?: Buffer | null };

export type ContenidoEnlace = {
  url: string;
  urlFinal: string;
  sitio: string;
  titulo: string | null;
  descripcion: string | null;
  texto: string | null;
  evento: { nombre: string | null; inicio: string | null; lugar: string | null } | null;
  imagen: { datos: Buffer; mime: string } | null;
  legible: boolean;
  esInstagram: boolean;
};

// ───────────── URLs ─────────────

/** Links del mensaje (con o sin http, como los escribe WhatsApp). */
export function extraerUrls(texto: string): string[] {
  const encontrados = texto.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi) ?? [];
  return [
    ...new Set(
      encontrados
        .map((u) => u.replace(/[).,;:!?¡¿»”’]+$/u, ""))
        .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
        .filter((u) => {
          try {
            return !!new URL(u).hostname.includes(".");
          } catch {
            return false;
          }
        }),
    ),
  ];
}

export const textoSinUrls = (texto: string) => texto.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, " ").replace(/\s+/g, " ").trim();

const hostDe = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
const esDe = (host: string, dominio: string) => host === dominio || host.endsWith(`.${dominio}`);

// ───────────── Seguridad: solo direcciones públicas ─────────────

export function ipPrivada(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return ipPrivada(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

export async function verificarDestino(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Solo se leen links http o https");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Puerto no permitido");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(ipPrivada)) throw new Error("Dirección no permitida");
}

async function leerCuerpo(r: Response, max: number, cortarSiSobra: boolean): Promise<Buffer> {
  if (!r.body) return Buffer.alloc(0);
  const lector = r.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await lector.cancel();
      if (!cortarSiSobra) throw new Error("Archivo demasiado grande");
      partes.push(value.subarray(0, value.length - (total - max)));
      break;
    }
    partes.push(value);
  }
  return Buffer.concat(partes);
}

/** GET seguro: revisa cada redirección, con tiempo y tamaño máximos. */
export async function traer(url: string, op: { max: number; aceptar: string; cortarSiSobra?: boolean }) {
  let actual = new URL(url);
  for (let saltos = 0; saltos < 6; saltos++) {
    await verificarDestino(actual);
    const r = await fetch(actual, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIEMPO_MS),
      headers: { "user-agent": AGENTE, accept: op.aceptar, "accept-language": "es-AR,es;q=0.9,en;q=0.6" },
    });
    const destino = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && destino) {
      await r.body?.cancel();
      actual = new URL(destino, actual);
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`HTTP ${r.status}`);
    }
    const datos = await leerCuerpo(r, op.max, op.cortarSiSobra ?? false);
    return { url: actual.toString(), tipo: r.headers.get("content-type") ?? "", datos };
  }
  throw new Error("Demasiadas redirecciones");
}

// ───────────── HTML ─────────────

const ENTIDADES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", iexcl: "¡", iquest: "¿", deg: "°",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü", euro: "€",
};

export function decodificarEntidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTIDADES[e] ?? m;
  });
}

const limpiar = (s: string | null | undefined) => {
  const t = s ? decodificarEntidades(s).replace(/\s+/g, " ").trim() : "";
  return t || null;
};

function atributos(etiqueta: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const m of etiqueta.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    r[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return r;
}

type Evento = NonNullable<ContenidoEnlace["evento"]>;

function buscarEvento(nodo: unknown, prof = 0): Evento | null {
  if (!nodo || typeof nodo !== "object" || prof > 6) return null;
  if (Array.isArray(nodo)) {
    for (const x of nodo) {
      const e = buscarEvento(x, prof + 1);
      if (e) return e;
    }
    return null;
  }
  const o = nodo as Record<string, unknown>;
  const tipos = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
  if (tipos.some((t) => /Event$/i.test(t)) && o.startDate) {
    const loc = o.location as Record<string, unknown> | string | undefined;
    let lugar: string | null = null;
    if (typeof loc === "string") lugar = loc;
    else if (loc && typeof loc === "object") {
      const dir = loc.address as Record<string, unknown> | string | undefined;
      const dirTxt = typeof dir === "string" ? dir : dir ? [dir.streetAddress, dir.addressLocality].filter(Boolean).join(", ") : "";
      lugar = [loc.name, dirTxt].filter(Boolean).join(" — ") || null;
    }
    return { nombre: limpiar(String(o.name ?? "")), inicio: String(o.startDate), lugar: limpiar(lugar) };
  }
  for (const v of Object.values(o)) {
    const e = buscarEvento(v, prof + 1);
    if (e) return e;
  }
  return null;
}

export type DatosHtml = {
  titulo: string | null;
  descripcion: string | null;
  sitio: string | null;
  imagen: string | null;
  texto: string | null;
  evento: Evento | null;
};

/** Saca lo útil de una página: metadatos (Open Graph), evento (JSON-LD) y el texto visible. */
export function parsearHtml(html: string, base: string): DatosHtml {
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = atributos(m[0]);
    const clave = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (clave && a.content && !(clave in meta)) meta[clave] = a.content;
  }
  const titulo = limpiar(meta["og:title"] ?? meta["twitter:title"] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const descripcion = limpiar(meta["og:description"] ?? meta["twitter:description"] ?? meta.description);
  const sitio = limpiar(meta["og:site_name"]);
  let imagen: string | null = null;
  const img = meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["twitter:image"] ?? meta["twitter:image:src"];
  if (img) {
    try {
      imagen = new URL(decodificarEntidades(img), base).toString();
    } catch {
      imagen = null;
    }
  }
  let evento: Evento | null = null;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      evento = buscarEvento(JSON.parse(m[1].trim()));
    } catch {
      evento = null;
    }
    if (evento) break;
  }
  const cuerpo = html
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const texto = decodificarEntidades(cuerpo)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXTO);
  return { titulo, descripcion, sitio, imagen, texto: texto || null, evento };
}

function decodificarHtml(datos: Buffer, tipo: string): string {
  const charset = /charset=([\w-]+)/i.exec(tipo)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(datos.subarray(0, 4096).toString("latin1"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(datos);
  } catch {
    return new TextDecoder("utf-8").decode(datos);
  }
}

// ───────────── oEmbed públicos (TikTok y YouTube) ─────────────

async function oembed(url: string): Promise<{ titulo: string | null; autor: string | null; imagen: string | null } | null> {
  const host = hostDe(url);
  let fin: string | null = null;
  if (esDe(host, "tiktok.com")) fin = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  else if (esDe(host, "youtube.com") || host === "youtu.be") fin = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  if (!fin) return null;
  const r = await traer(fin, { max: 512 * 1024, aceptar: "application/json" });
  const j = JSON.parse(r.datos.toString("utf8")) as Record<string, unknown>;
  return {
    titulo: limpiar(typeof j.title === "string" ? j.title : null),
    autor: limpiar(typeof j.author_name === "string" ? j.author_name : null),
    imagen: typeof j.thumbnail_url === "string" ? j.thumbnail_url : null,
  };
}

async function bajarImagen(url: string): Promise<{ datos: Buffer; mime: string } | null> {
  try {
    const r = await traer(url, { max: MAX_IMAGEN, aceptar: "image/*" });
    if (!r.tipo.startsWith("image/")) return null;
    return await imagenParaIa(r.datos);
  } catch {
    return null;
  }
}

const PANTALLA_DE_LOGIN = /^(instagram|log ?in|iniciar sesión|inicia sesión|facebook|tiktok - make your day)\b/i;

/** Lee un link: metadatos, texto, evento e imagen de portada. Combina con la vista previa de WhatsApp. */
export async function leerEnlace(url: string, previa?: VistaPreviaWa | null): Promise<ContenidoEnlace> {
  const host = hostDe(url);
  const esInstagram = esDe(host, "instagram.com") || host === "instagr.am";
  const [pagina, embebido] = await Promise.allSettled([
    traer(url, { max: MAX_HTML, aceptar: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", cortarSiSobra: true }),
    oembed(url),
  ]);

  let datos: DatosHtml = { titulo: null, descripcion: null, sitio: null, imagen: null, texto: null, evento: null };
  let urlFinal = url;
  if (pagina.status === "fulfilled") {
    urlFinal = pagina.value.url;
    if (/html|xml/i.test(pagina.value.tipo) || !pagina.value.tipo) datos = parsearHtml(decodificarHtml(pagina.value.datos, pagina.value.tipo), urlFinal);
  }
  const oe = embebido.status === "fulfilled" ? embebido.value : null;

  let titulo = oe?.titulo ?? datos.titulo;
  let descripcion = datos.descripcion ?? (oe?.autor ? `De ${oe.autor}` : null);
  // Instagram sin sesión suele devolver una pantalla de ingreso: eso no cuenta como contenido.
  const bloqueado = !!titulo && PANTALLA_DE_LOGIN.test(titulo) && !descripcion;
  if (bloqueado) titulo = null;
  titulo ??= limpiar(previa?.titulo);
  descripcion ??= limpiar(previa?.descripcion);

  let imagen = null as ContenidoEnlace["imagen"];
  const urlImagen = oe?.imagen ?? (bloqueado ? null : datos.imagen);
  if (urlImagen) imagen = await bajarImagen(urlImagen);
  if (!imagen && previa?.miniatura?.length) imagen = await imagenParaIa(previa.miniatura);

  const texto = bloqueado || esInstagram ? null : datos.texto;
  const legible = !!(titulo || descripcion || datos.evento || (texto && texto.length > 200) || (imagen && !esInstagram));
  return {
    url,
    urlFinal,
    sitio: datos.sitio ?? host,
    titulo,
    descripcion,
    texto,
    evento: datos.evento,
    imagen,
    legible,
    esInstagram,
  };
}
