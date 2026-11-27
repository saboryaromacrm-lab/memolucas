import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Building2, Home, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { archivoParaIa, CampoIa } from "../componentes/CampoIa";
import { IconoForma, TIPOS_FORMA } from "../componentes/FormasPago";
import { Boton, Cargando, Interruptor, MenuAcciones, Modal, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { plata } from "../lib/numeros";
import { describirAlcance, FRECUENCIAS_PAGO, periodoActual } from "../lib/pagos";
import type { ConfigPagos, FijoPago, FormaPago, LugarPago, PropuestaPagos, TipoFormaPago, TipoLugar } from "../lib/tipos";
import { ModalFijo } from "./PagosFijo";
import { RevisionIa, type FilaIa } from "./PagosRevisionIa";
import { useDatos } from "../lib/vivo";

/** Filtro de la lista: todos, un lugar, los generales o los repartidos. */
type FiltroLugar = number | "todos" | "general" | "repartido";

const nombreForma = (formas: FormaPago[], id: number | null) => (id === null ? null : (formas.find((f) => f.id === id)?.nombre ?? null));

const textoAviso = (d: number | null, general: number) => (d === null ? `${general} días antes` : d < 0 ? "No avisar" : d === 0 ? "El día que vence" : `${d} ${d === 1 ? "día" : "días"} antes`);

export function PagosConfig() {
  const { datos } = useDatos<ConfigPagos>("/api/pagos/config", ["pagos", "tarjetas"]);
  const [lugar, setLugar] = useState<FiltroLugar>("todos");
  const [editando, setEditando] = useState<FijoPago | "nuevo" | null>(null);
  const accion = useAccion();
  if (!datos) return <Cargando />;
  // Un repartido aparece en cada uno de sus lugares.
  const fijos = datos.fijos.filter(
    (f) =>
      lugar === "todos" ||
      (lugar === "general" ? f.alcance === "general" : lugar === "repartido" ? f.alcance === "repartido" : f.lugarId === lugar || !!f.reparto?.some((r) => r.lugarId === lugar)),
  );
  const titulo = lugar === "todos" ? "todos" : lugar === "general" ? "general" : lugar === "repartido" ? "repartidos" : (datos.lugares.find((l) => l.id === lugar)?.nombre ?? "");

  return (
    <div className="space-y-4">
      <CargarConIa config={datos} />

      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        <div className="space-y-4 self-start">
          <Lugares lugares={datos.lugares} fijos={datos.fijos} elegido={lugar} onElegir={setLugar} />
          <Formas formas={datos.formas} />
        </div>

        <section className="tarjeta overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Qué pagás · {titulo}</h2>
            <Boton chico variante="primario" icono={<Plus className="size-3.5" />} disabled={!datos.lugares.length} onClick={() => setEditando("nuevo")}>
              Pago fijo
            </Boton>
          </div>
          {!fijos.length ? (
            <p className="border-t border-slate-100 px-4 py-6 text-center text-sm text-slate-500">Todavía no cargaste pagos{lugar === "todos" ? "" : " en este lugar"}. Usá «Cargá o cambiá con IA» o «+ Pago fijo».</p>
          ) : (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {fijos.map((f) => (
                <li key={f.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[1fr_9rem_10rem_9rem_auto]">
                  <button onClick={() => setEditando(f)} className="min-w-0 text-left">
                    <div className="font-medium text-slate-900">{f.nombre}</div>
                    <div className="truncate text-xs text-slate-500">{[(lugar === "todos" || f.alcance !== "lugar") && describirAlcance(f, datos.lugares), f.categoria, f.cuenta].filter(Boolean).join(" · ")}</div>
                  </button>
                  <div className="text-right text-sm tabular-nums text-slate-900 sm:text-left">
                    {f.variable && "~ "}
                    {f.monto ? plata(f.monto, f.moneda) : "Sin monto"}
                    <div className="text-[11px] text-slate-400">{f.variable ? "variable" : "fijo"}</div>
                  </div>
                  <div className="text-xs text-slate-600">
                    {f.dia ? `Día ${f.dia}` : "Sin vto."} · {FRECUENCIAS_PAGO[f.frecuencia].toLowerCase()}
                    <div className="text-slate-400">{nombreForma(datos.formas, f.formaId) ?? "Sin forma fija"}</div>
                  </div>
                  <div className="hidden text-xs text-slate-500 sm:block">{textoAviso(f.avisoDias, datos.diasAviso)}</div>
                  <div className="col-start-2 row-span-2 row-start-1 self-center sm:col-start-auto sm:row-span-1">
                    <MenuAcciones
                      etiqueta={`Acciones de ${f.nombre}`}
                      acciones={[
                        { texto: "Editar", icono: <Pencil />, onClick: () => setEditando(f) },
                        {
                          texto: "Borrar",
                          icono: <Trash2 />,
                          peligro: true,
                          onClick: () => confirm(`¿Borrar ${f.nombre}? Sale de los meses que vienen; lo ya pagado queda en el historial.`) && void accion(() => del(`/api/pagos/fijos/${f.id}`), "Pago borrado"),
                        },
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="tarjeta space-y-2 p-4">
        <h2 className="text-sm font-semibold text-slate-800">Avisos por WhatsApp</h2>
        <label className="flex flex-wrap items-center justify-between gap-2 py-1">
          <span>
            <span className="block text-sm font-medium text-slate-800">Avisarme antes de que venza</span>
            <span className="block text-xs text-slate-500">Para los pagos que no tienen su propio aviso. También avisa el día que vence. 0 = solo ese día.</span>
          </span>
          <span className="flex items-center gap-2 text-sm text-slate-600">
            <input
              className="campo w-20"
              type="number"
              min={0}
              max={30}
              defaultValue={datos.diasAviso}
              onBlur={(e) => Number(e.target.value) !== datos.diasAviso && void accion(() => put("/api/pagos/ajustes", { diasAviso: Number(e.target.value) || 0 }), "Guardado")}
            />
            días antes
          </span>
        </label>
        <Interruptor
          activo={datos.mensajes}
          onChange={(v) => void accion(() => put("/api/pagos/ajustes", { mensajes: v }), "Guardado")}
          etiqueta="Mensajes del mes"
          ayuda="El día 1: cómo cerró el mes anterior (análisis de la IA, unos centavos) y lo que viene. A mitad de mes: lo que falta pagar."
        />
      </section>

      {editando && <ModalFijo fijo={editando === "nuevo" ? null : editando} lugarInicial={typeof lugar === "number" ? lugar : datos.lugares[0]?.id} config={datos} onCerrar={() => setEditando(null)} />}
    </div>
  );
}

function CargarConIa({ config }: { config: ConfigPagos }) {
  const [texto, setTexto] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [armando, setArmando] = useState(false);
  const [revision, setRevision] = useState<{ filas: FilaIa[]; totalImagen: number | null; mensaje: string } | null>(null);
  const [mensaje, setMensaje] = useState("");
  const accion = useAccion();

  const armar = async () => {
    setArmando(true);
    setMensaje("");
    const r = await accion(async () => post<PropuestaPagos>("/api/pagos/ia/armar", { texto, archivo: archivo ? await archivoParaIa(archivo) : undefined }));
    setArmando(false);
    if (!r) return;
    const cargado = (id: number) => config.fijos.find((f) => f.id === id);
    const filas: FilaIa[] = [
      ...r.cambios.flatMap((c) => {
        const antes = cargado(c.id);
        return antes ? [{ tipo: "cambio" as const, antes, fijo: c.despues, ia: c.despues }] : [];
      }),
      ...r.nuevos.map((fijo) => ({ tipo: "nuevo" as const, fijo, ia: fijo })),
      ...r.borrar.flatMap((id) => {
        const antes = cargado(id);
        return antes ? [{ tipo: "borrar" as const, antes }] : [];
      }),
    ];
    if (filas.length) setRevision({ filas, totalImagen: r.totalImagen, mensaje: r.mensaje });
    else setMensaje(r.mensaje || "No encontré nada para agregar, cambiar ni borrar.");
  };
  const listo = () => {
    setRevision(null);
    setTexto("");
    setArchivo(null);
  };

  return (
    <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
        <Sparkles className="size-4" /> Cargá o cambiá con IA
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Escribí o dictá lo que pagás o lo que querés cambiar, como te salga, o pegá una foto o un PDF. La IA arma los cambios y los revisás antes de guardar (cuesta unos centavos).
      </p>
      <div className="mt-2">
        <CampoIa
          texto={texto}
          onTexto={setTexto}
          archivo={archivo}
          onArchivo={setArchivo}
          placeholder="En el Express 1 pago alquiler 650 mil el 5 y la luz más o menos 70 mil… · Sacale el vencimiento a todo · El alquiler de Fontana subió a 850 mil · Borrá el gimnasio"
        />
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-slate-600">Lo que la IA tiene que saber de tus negocios</summary>
        <textarea
          className="campo mt-2 min-h-20"
          defaultValue={config.notasIa}
          placeholder="Qué locales son de qué empresa, cómo se reparte algo, cómo le decís a cada cosa…"
          onBlur={(e) => e.target.value.trim() !== config.notasIa && void accion(() => put("/api/pagos/ajustes", { notasIa: e.target.value }), "Guardado")}
        />
        <span className="text-xs text-slate-500">La IA lo tiene en cuenta cada vez que arma, cambia o carga pagos (también con fotos y PDF).</span>
      </details>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Boton variante="primario" icono={<Sparkles className="size-4" />} cargando={armando} disabled={texto.trim().length < 3 && !archivo} onClick={() => void armar()}>
          Armar con IA
        </Boton>
        {mensaje && <p className="text-sm text-amber-700">{mensaje}</p>}
      </div>
      {revision && (
        <RevisionIa modo="config" config={config} {...revision} periodo={periodoActual()} onCerrar={() => setRevision(null)} onListo={listo} />
      )}
    </section>
  );
}

function Lugares({ lugares, fijos, elegido, onElegir }: { lugares: LugarPago[]; fijos: FijoPago[]; elegido: FiltroLugar; onElegir: (l: FiltroLugar) => void }) {
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<TipoLugar>("negocio");
  const accion = useAccion();
  const agregar = async () => {
    if (await accion(() => post("/api/pagos/lugares", { nombre, tipo }), "Lugar agregado")) setNombre("");
  };
  const fila = (activo: boolean) => `flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm ${activo ? "bg-marca-suave font-medium text-marca-profundo" : "text-slate-700 hover:bg-slate-50"}`;
  return (
    <section className="tarjeta overflow-hidden self-start">
      <h2 className="px-4 py-3 text-sm font-semibold text-slate-800">Lugares</h2>
      <ul className="border-t border-slate-100">
        <li>
          <button className={fila(elegido === "todos")} onClick={() => onElegir("todos")}>
            Todos
          </button>
        </li>
        {lugares.map((l) => (
          <li key={l.id} className="flex items-center border-t border-slate-100">
            <button className={fila(elegido === l.id)} onClick={() => onElegir(l.id)}>
              <span className="flex min-w-0 items-center gap-2">
                {l.tipo === "negocio" ? <Building2 className="size-4 shrink-0 text-indigo-500" /> : <Home className="size-4 shrink-0 text-slate-400" />}
                <span className="truncate">{l.nombre}</span>
              </span>
              <span className="shrink-0 text-xs text-slate-400">{l.fijos ? `${l.fijos} ${l.fijos === 1 ? "pago" : "pagos"}` : ""}</span>
            </button>
            <MenuAcciones
              etiqueta={`Acciones de ${l.nombre}`}
              acciones={[
                {
                  texto: "Renombrar",
                  icono: <Pencil />,
                  onClick: () => {
                    const n = prompt("Nuevo nombre", l.nombre);
                    if (n?.trim()) void accion(() => put(`/api/pagos/lugares/${l.id}`, { nombre: n }), "Renombrado");
                  },
                },
                {
                  texto: l.tipo === "negocio" ? "Es personal" : "Es un negocio",
                  icono: l.tipo === "negocio" ? <Home /> : <Building2 />,
                  onClick: () => void accion(() => put(`/api/pagos/lugares/${l.id}`, { tipo: l.tipo === "negocio" ? "personal" : "negocio" })),
                },
                { texto: "Borrar", icono: <Trash2 />, peligro: true, onClick: () => confirm(`¿Borrar ${l.nombre}?`) && void accion(() => del(`/api/pagos/lugares/${l.id}`), "Lugar borrado") },
              ]}
            />
          </li>
        ))}
        {(["repartido", "general"] as const).map((a) => {
          const n = fijos.filter((f) => f.alcance === a).length;
          return (
            <li key={a} className="border-t border-slate-100">
              <button className={fila(elegido === a)} onClick={() => onElegir(a)} title={a === "general" ? "Lo que no tiene lugar físico: la tarjeta, la cuota del auto…" : "Lo que es de varios locales: el contador, el abogado…"}>
                <span className="flex items-center gap-2 italic">{a === "general" ? "General (sin lugar)" : "Repartidos"}</span>
                <span className="shrink-0 text-xs text-slate-400">{n ? `${n} ${n === 1 ? "pago" : "pagos"}` : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="grid grid-cols-[1fr_auto] gap-2 border-t border-slate-100 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (nombre.trim()) void agregar();
        }}
      >
        <input className="campo col-span-2" placeholder="Nuevo lugar" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        <select className="campo w-auto" value={tipo} onChange={(e) => setTipo(e.target.value as TipoLugar)} aria-label="Tipo de lugar">
          <option value="negocio">Negocio</option>
          <option value="personal">Personal</option>
        </select>
        <Boton chico type="submit" disabled={!nombre.trim()} icono={<Plus className="size-3.5" />}>
          Agregar
        </Boton>
      </form>
    </section>
  );
}


/** Con qué pagás: las que cargás y las tarjetas de Tarjetas (aparecen solas). Se ordenan con las flechas. */
function Formas({ formas }: { formas: FormaPago[] }) {
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<TipoFormaPago>("transferencia");
  const [editando, setEditando] = useState<FormaPago | null>(null);
  const accion = useAccion();
  const activas = formas.filter((f) => !f.archivada);
  const agregar = async () => {
    if (await accion(() => post("/api/pagos/formas", { nombre, tipo }), "Forma de pago agregada")) setNombre("");
  };
  const mover = (k: number, paso: -1 | 1) => {
    const ids = activas.map((f) => f.id);
    [ids[k], ids[k + paso]] = [ids[k + paso], ids[k]];
    void accion(() => put("/api/pagos/formas/orden", { ids }));
  };
  // «Lo pagó: …» no se carga acá: se crea sola con cada cuenta (Pagos → Cuentas).
  const opcionesTipo = Object.entries(TIPOS_FORMA)
    .filter(([v]) => v !== "tercero")
    .map(([v, t]) => (
    <option key={v} value={v}>
      {t.texto}
    </option>
  ));
  return (
    <section className="tarjeta overflow-hidden">
      <h2 className="px-4 py-3 text-sm font-semibold text-slate-800">Formas de pago</h2>
      <ul className="border-t border-slate-100">
        {activas.map((f, k) => (
          <li key={f.id} className="flex items-center gap-2 border-t border-slate-100 py-1.5 pl-4 pr-1 text-sm text-slate-700 first:border-t-0">
            <IconoForma tipo={f.tipo} className="size-4 text-slate-400" />
            <span className="min-w-0 flex-1 truncate" title={f.tarjetaId ? "De Tarjetas: el nombre se cambia allá" : f.personaId ? "De Cuentas: se maneja allá" : TIPOS_FORMA[f.tipo].texto}>
              {f.nombre}
            </span>
            <MenuAcciones
              etiqueta={`Acciones de ${f.nombre}`}
              acciones={[
                k > 0 && { texto: "Subir", icono: <ArrowUp />, onClick: () => mover(k, -1) },
                k < activas.length - 1 && { texto: "Bajar", icono: <ArrowDown />, onClick: () => mover(k, 1) },
                !f.tarjetaId && !f.personaId && { texto: "Editar", icono: <Pencil />, onClick: () => setEditando(f) },
                !f.personaId && {
                  texto: "Sacar de la lista",
                  icono: <Trash2 />,
                  peligro: true,
                  onClick: () => confirm(`¿Sacar «${f.nombre}» de la lista? Los pagos que ya hiciste con ella la siguen mostrando.`) && void accion(() => del(`/api/pagos/formas/${f.id}`), "Forma de pago quitada"),
                },
              ]}
            />
          </li>
        ))}
        {!activas.length && <li className="px-4 py-3 text-sm text-slate-500">Agregá con qué pagás: transferencia, efectivo, Mercado Pago…</li>}
      </ul>
      <form
        className="grid grid-cols-[1fr_auto] gap-2 border-t border-slate-100 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (nombre.trim()) void agregar();
        }}
      >
        <input className="campo col-span-2" placeholder="Nueva: Transferencia Galicia…" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        <select className="campo w-auto min-w-0" value={tipo} onChange={(e) => setTipo(e.target.value as TipoFormaPago)} aria-label="Tipo de forma de pago">
          {opcionesTipo}
        </select>
        <Boton chico type="submit" disabled={!nombre.trim()} icono={<Plus className="size-3.5" />}>
          Agregar
        </Boton>
      </form>
      {editando && <ModalForma forma={editando} opcionesTipo={opcionesTipo} onCerrar={() => setEditando(null)} />}
    </section>
  );
}

function ModalForma({ forma, opcionesTipo, onCerrar }: { forma: FormaPago; opcionesTipo: ReactNode; onCerrar: () => void }) {
  const [nombre, setNombre] = useState(forma.nombre);
  const [tipo, setTipo] = useState(forma.tipo);
  const accion = useAccion();
  const guardar = async () => {
    if (await accion(() => put(`/api/pagos/formas/${forma.id}`, { nombre, tipo }), "Guardado")) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Editar ${forma.nombre}`}
      ancho="max-w-sm"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!nombre.trim()} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500">El nombre nuevo se ve en todos los pagos, también en los que ya hiciste.</p>
      <div className="space-y-3">
        <label className="block">
          <span className="etiqueta">Nombre</span>
          <input className="campo" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Tipo</span>
          <select className="campo" value={tipo} onChange={(e) => setTipo(e.target.value as TipoFormaPago)}>
            {opcionesTipo}
          </select>
        </label>
      </div>
    </Modal>
  );
}
