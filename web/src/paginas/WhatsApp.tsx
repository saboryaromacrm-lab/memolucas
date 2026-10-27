import { useEffect, useState } from "react";
import { KeyRound, Link2Off, Loader2, QrCode, RefreshCw, Send, ShieldCheck, Smartphone } from "lucide-react";
import { Boton, Cargando, Encabezado, Modal, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { fechaHora, haceCuanto } from "../lib/fechas";
import type { Grupo, InfoWhatsapp } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const ESTADOS: Record<InfoWhatsapp["estado"], [string, string]> = {
  iniciando: ["Iniciando…", "text-slate-500"],
  conectando: ["Conectando…", "text-amber-600"],
  esperando_qr: ["Esperando vinculación", "text-amber-600"],
  conectado: ["Conectado", "text-marca-oscuro"],
  desconectado: ["Desconectado (reintentando)", "text-red-600"],
  sesion_cerrada: ["Sin vincular", "text-red-600"],
};

export function WhatsApp() {
  const { datos: wa } = useDatos<InfoWhatsapp>("/api/whatsapp", ["whatsapp", "mensajes", "configuracion"]);
  const { datos: grupos } = useDatos<Grupo[]>("/api/grupos", ["mensajes"]);
  const accion = useAccion();
  const [numero, setNumero] = useState("");
  const [desvincular, setDesvincular] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);

  useEffect(() => {
    if (wa?.numeroAutorizado && !numero) setNumero(wa.numeroAutorizadoTexto);
  }, [wa?.numeroAutorizado]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wa) return <Cargando />;
  const [txt, color] = ESTADOS[wa.estado];
  const vinculando = wa.estado === "esperando_qr" || wa.estado === "sesion_cerrada" || (wa.estado !== "conectado" && !wa.numeroVinculado);

  const ejecutar = async (clave: string, fn: () => Promise<unknown>, ok?: string) => {
    setOcupado(clave);
    await accion(fn, ok);
    setOcupado(null);
  };

  return (
    <div className="space-y-6">
      <Encabezado titulo="WhatsApp" subtitulo="Conexión del número del bot y número autorizado." />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="tarjeta p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="etiqueta">Estado</div>
              <div className={`text-lg font-semibold ${color}`}>{txt}</div>
              {wa.alerta && <div className="mt-1 text-sm text-red-600">Desconectado hace {wa.minutosCaido} min.</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Boton chico icono={<RefreshCw className="size-3.5" />} cargando={ocupado === "rec"} onClick={() => ejecutar("rec", () => post("/api/whatsapp/reconectar"), "Reconectando…")}>
                Reconectar
              </Boton>
              <Boton
                chico
                icono={<Send className="size-3.5" />}
                disabled={wa.estado !== "conectado"}
                cargando={ocupado === "prueba"}
                onClick={() => ejecutar("prueba", () => post("/api/whatsapp/prueba"), "Mensaje de prueba enviado")}
              >
                Mensaje de prueba
              </Boton>
              <Boton chico variante="peligro" icono={<Link2Off className="size-3.5" />} disabled={!wa.numeroVinculado} onClick={() => setDesvincular(true)}>
                Desvincular
              </Boton>
            </div>
          </div>
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
            <Dato titulo="Número del bot" valor={wa.numeroVinculadoTexto ?? "—"} />
            <Dato titulo="Último mensaje recibido" valor={wa.ultimoMensajeRecibido ? haceCuanto(wa.ultimoMensajeRecibido) : "—"} detalle={wa.ultimoMensajeRecibido ? fechaHora(wa.ultimoMensajeRecibido) : undefined} />
            <Dato titulo="Último error" valor={wa.estado === "conectado" ? "—" : wa.ultimoError ?? "—"} />
          </dl>

          {vinculando && wa.estado !== "conectado" && <Vinculacion wa={wa} />}
        </section>

        <div className="space-y-6">
          <section className="tarjeta p-5">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ShieldCheck className="size-4 text-marca-oscuro" /> Número autorizado
            </div>
            <p className="mb-3 text-xs text-slate-500">Tu número personal. Es el único al que el bot responde; todo lo demás se ignora.</p>
            <input className="campo" inputMode="tel" placeholder="11 1234-5678" value={numero} onChange={(e) => setNumero(e.target.value)} />
            <Boton
              className="mt-3 w-full"
              variante="primario"
              cargando={ocupado === "num"}
              onClick={() => ejecutar("num", () => put("/api/whatsapp/autorizado", { numero }), "Número autorizado guardado")}
            >
              Guardar número
            </Boton>
            {wa.numeroAutorizado && <p className="mt-2 text-xs text-slate-500">Actual: {wa.numeroAutorizadoTexto}</p>}
          </section>

          <section className="tarjeta p-5">
            <div className="mb-1 text-sm font-semibold text-slate-800">👨‍👩‍👧 Grupos</div>
            <p className="mb-3 text-xs text-slate-500">
              El bot funciona en los grupos donde estás vos. Ahí lee todo, pero solo contesta cuando le piden algo. Aparecen acá después del primer mensaje.
            </p>
            {grupos?.length ? (
              <ul className="space-y-1 text-sm text-slate-700">
                {grupos.map((g) => (
                  <li key={g.jid} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-marca" /> {g.nombre}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Todavía ninguno.</p>
            )}
          </section>

          <section className="tarjeta p-5 text-sm text-slate-600">
            <div className="mb-2 font-semibold text-slate-800">Para cuidar el número del bot</div>
            <ul className="list-disc space-y-1 pl-4 text-xs">
              <li>Usá un chip aparte, nunca tu número personal.</li>
              <li>Antes de vincularlo, usalo un par de días en un teléfono como un número normal.</li>
              <li>El bot solo responde a tu número, con una demora corta y “escribiendo…”.</li>
              <li>Si WhatsApp lo bloquea: cambiá el chip, tocá “Desvincular” y escaneá el QR nuevo.</li>
            </ul>
          </section>
        </div>
      </div>

      <Modal
        abierto={desvincular}
        onCerrar={() => setDesvincular(false)}
        titulo="Desvincular WhatsApp"
        ancho="max-w-md"
        pie={
          <>
            <Boton variante="fantasma" onClick={() => setDesvincular(false)}>
              Cancelar
            </Boton>
            <Boton
              variante="peligro"
              onClick={async () => {
                setDesvincular(false);
                await ejecutar("des", () => post("/api/whatsapp/desvincular"), "Sesión borrada. Escaneá el QR nuevo.");
              }}
            >
              Desvincular
            </Boton>
          </>
        }
      >
        <p className="text-sm text-slate-600">Se cierra la sesión y se borra del servidor. Para volver a usar el bot vas a tener que escanear un QR nuevo.</p>
      </Modal>
    </div>
  );
}

function Dato({ titulo, valor, detalle }: { titulo: string; valor: string; detalle?: string }) {
  return (
    <div>
      <dt className="etiqueta">{titulo}</dt>
      <dd className="break-words text-slate-800">{valor}</dd>
      {detalle && <dd className="text-xs text-slate-400">{detalle}</dd>}
    </div>
  );
}

function Vinculacion({ wa }: { wa: InfoWhatsapp }) {
  const [modo, setModo] = useState<"qr" | "codigo">("qr");
  const [numeroBot, setNumeroBot] = useState("");
  const [codigo, setCodigo] = useState<string | null>(null);
  const [pidiendo, setPidiendo] = useState(false);
  const accion = useAccion();

  return (
    <div className="mt-6 border-t border-slate-100 pt-5">
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm sm:w-fit">
        <button onClick={() => setModo("qr")} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${modo === "qr" ? "bg-white shadow-sm" : "text-slate-500"}`}>
          <QrCode className="size-4" /> Código QR
        </button>
        <button onClick={() => setModo("codigo")} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${modo === "codigo" ? "bg-white shadow-sm" : "text-slate-500"}`}>
          <KeyRound className="size-4" /> Con código
        </button>
      </div>

      {modo === "qr" ? (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          <div className="flex size-64 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white p-2">
            {wa.qr ? <img src={wa.qr} alt="Código QR de WhatsApp" className="size-full" /> : <Loader2 className="size-8 animate-spin text-slate-300" />}
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
            <li>En el teléfono del <b>chip del bot</b>, abrí WhatsApp.</li>
            <li>
              Andá a <b>Configuración → Dispositivos vinculados → Vincular un dispositivo</b>.
            </li>
            <li>Escaneá este código. Se renueva solo cada unos segundos.</li>
            <li>Cuando diga “Conectado”, mandale “hola” al bot desde tu número personal.</li>
          </ol>
        </div>
      ) : (
        <div className="max-w-md space-y-3">
          <p className="text-sm text-slate-600">Si no podés escanear, pedí un código con el número del chip del bot y cargalo en ese teléfono en “Vincular con el número de teléfono”.</p>
          <div className="flex gap-2">
            <input className="campo" inputMode="tel" placeholder="Número del bot, ej. 11 5555-0000" value={numeroBot} onChange={(e) => setNumeroBot(e.target.value)} />
            <Boton
              variante="primario"
              cargando={pidiendo}
              icono={<Smartphone className="size-4" />}
              onClick={async () => {
                setPidiendo(true);
                const r = await accion(() => post<{ codigo: string }>("/api/whatsapp/codigo", { numero: numeroBot }));
                if (r) setCodigo(r.codigo);
                setPidiendo(false);
              }}
            >
              Pedir
            </Boton>
          </div>
          {codigo && (
            <div className="rounded-xl border border-marca/40 bg-marca-suave px-4 py-3 text-center">
              <div className="text-xs text-marca-profundo">Código de vinculación</div>
              <div className="font-mono text-2xl font-bold tracking-widest text-slate-900">{codigo}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
