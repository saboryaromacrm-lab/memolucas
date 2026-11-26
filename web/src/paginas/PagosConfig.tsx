import { useState } from "react";
import { Building2, Home, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Boton, Cargando, Interruptor, MenuAcciones, Modal, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { FRECUENCIAS_PAGO, nombreMes, periodoActual } from "../lib/pagos";
import type { ConfigPagos, FijoPago, FrecuenciaPago, LugarPago, Moneda, TipoLugar } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

/** Lo que armó la IA, para revisar antes de guardar. */
type Propuesto = Omit<FijoPago, "id" | "desde" | "lugarId"> & { lugarId: number | null; lugarNuevo?: { nombre: string; tipo: TipoLugar }; elegido: boolean };

const textoAviso = (d: number | null, general: number) => (d === null ? `${general} días antes` : d < 0 ? "No avisar" : d === 0 ? "El día que vence" : `${d} ${d === 1 ? "día" : "días"} antes`);

export function PagosConfig() {
  const { datos } = useDatos<ConfigPagos>("/api/pagos/config", ["pagos"]);
  const [lugar, setLugar] = useState<number | "todos">("todos");
  const [editando, setEditando] = useState<FijoPago | "nuevo" | null>(null);
  const accion = useAccion();
  if (!datos) return <Cargando />;
  const fijos = datos.fijos.filter((f) => lugar === "todos" || f.lugarId === lugar);
  const nombreLugar = (id: number) => datos.lugares.find((l) => l.id === id)?.nombre ?? "—";

  return (
    <div className="space-y-4">
      <CargarConIa config={datos} />

      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        <Lugares lugares={datos.lugares} elegido={lugar} onElegir={setLugar} />

        <section className="tarjeta overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Qué pagás · {lugar === "todos" ? "todos los lugares" : nombreLugar(lugar)}</h2>
            <Boton chico variante="primario" icono={<Plus className="size-3.5" />} disabled={!datos.lugares.length} onClick={() => setEditando("nuevo")}>
              Pago fijo
            </Boton>
          </div>
          {!fijos.length ? (
            <p className="border-t border-slate-100 px-4 py-6 text-center text-sm text-slate-500">Todavía no cargaste pagos{lugar === "todos" ? "" : " en este lugar"}. Usá «Cargá con IA» o «+ Pago fijo».</p>
          ) : (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {fijos.map((f) => (
                <li key={f.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[1fr_9rem_10rem_9rem_auto]">
                  <button onClick={() => setEditando(f)} className="min-w-0 text-left">
                    <div className="font-medium text-slate-900">{f.nombre}</div>
                    <div className="truncate text-xs text-slate-500">{[lugar === "todos" && nombreLugar(f.lugarId), f.categoria, f.cuenta].filter(Boolean).join(" · ")}</div>
                  </button>
                  <div className="text-right text-sm tabular-nums text-slate-900 sm:text-left">
                    {f.variable && "~ "}
                    {f.monto ? plata(f.monto, f.moneda) : "Sin monto"}
                    <div className="text-[11px] text-slate-400">{f.variable ? "variable" : "fijo"}</div>
                  </div>
                  <div className="text-xs text-slate-600">
                    Día {f.dia} · {FRECUENCIAS_PAGO[f.frecuencia].toLowerCase()}
                    <div className="text-slate-400">{f.medio || "Medio sin definir"}</div>
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

      {editando && <ModalFijo fijo={editando === "nuevo" ? null : editando} lugarInicial={lugar === "todos" ? datos.lugares[0]?.id : lugar} config={datos} onCerrar={() => setEditando(null)} />}
    </div>
  );
}

function CargarConIa({ config }: { config: ConfigPagos }) {
  const [texto, setTexto] = useState("");
  const [armando, setArmando] = useState(false);
  const [propuesta, setPropuesta] = useState<Propuesto[] | null>(null);
  const accion = useAccion();
  const armar = async () => {
    setArmando(true);
    const r = await accion(() => post<{ fijos: Omit<Propuesto, "elegido">[] }>("/api/pagos/ia/armar", { texto }));
    setArmando(false);
    if (r) setPropuesta(r.fijos.map((f) => ({ ...f, elegido: true })));
  };
  const elegidos = propuesta?.filter((p) => p.elegido) ?? [];
  const guardar = async () => {
    const fijos = elegidos.map(({ elegido: _, ...f }) => f);
    if (await accion(() => post("/api/pagos/fijos/lote", { fijos }), `Listo: ${fijos.length} ${fijos.length === 1 ? "pago cargado" : "pagos cargados"}`)) {
      setPropuesta(null);
      setTexto("");
    }
  };
  const nombreLugar = (p: Propuesto) => config.lugares.find((l) => l.id === p.lugarId)?.nombre ?? p.lugarNuevo?.nombre ?? "—";

  return (
    <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
        <Sparkles className="size-4" /> Cargá con IA
      </h2>
      <p className="mt-1 text-sm text-slate-600">Escribí o dictá lo que pagás, como te salga. La IA arma la lista y la revisás antes de guardar (cuesta unos centavos).</p>
      <textarea
        className="campo mt-2 min-h-24"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="En el Express 1 pago alquiler 650 mil el 5, la luz a mitad de mes más o menos 70 mil, internet 30 mil por débito automático. En casa el ABL cada dos meses, unos 38 mil el 20…"
      />
      <div className="mt-2">
        <Boton variante="primario" icono={<Sparkles className="size-4" />} cargando={armando} disabled={texto.trim().length < 3} onClick={() => void armar()}>
          Armar la lista
        </Boton>
      </div>
      {propuesta && (
        <Modal
          abierto
          onCerrar={() => setPropuesta(null)}
          titulo={`Revisá lo que armó la IA (${propuesta.length})`}
          ancho="max-w-4xl"
          pie={
            <>
              <Boton onClick={() => setPropuesta(null)}>Cancelar</Boton>
              <Boton variante="primario" disabled={!elegidos.length} onClick={() => void guardar()}>
                Guardar {elegidos.length}
              </Boton>
            </>
          }
        >
          <p className="mb-3 text-sm text-slate-500">Destildá lo que no va. Después cada uno se puede editar en la lista.</p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {propuesta.map((p, k) => (
              <li key={k} className="flex items-start gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-marca-oscuro"
                  checked={p.elegido}
                  onChange={(e) => setPropuesta(propuesta.map((x, j) => (j === k ? { ...x, elegido: e.target.checked } : x)))}
                  aria-label={`Incluir ${p.nombre}`}
                />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium text-slate-900">
                    {p.nombre} · {nombreLugar(p)}
                    {p.lugarNuevo && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Lugar nuevo</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {[
                      p.categoria,
                      p.monto ? `${p.variable ? "~ " : ""}${plata(p.monto, p.moneda)}` : "sin monto",
                      `día ${p.dia}`,
                      FRECUENCIAS_PAGO[p.frecuencia].toLowerCase(),
                      p.medio,
                      p.cuenta,
                      p.nota,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  );
}

function Lugares({ lugares, elegido, onElegir }: { lugares: LugarPago[]; elegido: number | "todos"; onElegir: (l: number | "todos") => void }) {
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

function ModalFijo({ fijo, lugarInicial, config, onCerrar }: { fijo: FijoPago | null; lugarInicial: number | undefined; config: ConfigPagos; onCerrar: () => void }) {
  const [f, setF] = useState({
    lugarId: String(fijo?.lugarId ?? lugarInicial ?? ""),
    nombre: fijo?.nombre ?? "",
    categoria: fijo?.categoria ?? "Servicios",
    monto: aCampo(fijo?.monto ?? 0, true),
    variable: fijo?.variable ?? false,
    moneda: (fijo?.moneda ?? "ARS") as Moneda,
    dia: String(fijo?.dia ?? 10),
    frecuencia: (fijo?.frecuencia ?? "mensual") as FrecuenciaPago,
    desde: fijo?.desde ?? periodoActual(),
    medio: fijo?.medio ?? "",
    cuenta: fijo?.cuenta ?? "",
    aviso: fijo?.avisoDias === null || fijo?.avisoDias === undefined ? "" : String(fijo.avisoDias),
    nota: fijo?.nota ?? "",
  });
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const monto = aNumero(f.monto) ?? 0;
  const valido = f.nombre.trim() && f.lugarId && Number(f.dia) >= 1 && Number(f.dia) <= 31;
  const guardar = async () => {
    const cuerpo = { ...f, lugarId: Number(f.lugarId), monto, dia: Number(f.dia), avisoDias: f.aviso === "" ? null : Number(f.aviso) };
    const ok = await accion(() => (fijo ? put(`/api/pagos/fijos/${fijo.id}`, cuerpo) : post("/api/pagos/fijos", cuerpo)), fijo ? "Guardado" : "Pago agregado");
    if (ok) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={fijo ? `Editar ${fijo.nombre}` : "Nuevo pago fijo"}
      ancho="max-w-lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!valido} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block">
          <span className="etiqueta">Qué pagás</span>
          <input className="campo" autoFocus placeholder="Alquiler, luz, ABL, sueldos…" {...campo("nombre")} />
        </label>
        <label className="block">
          <span className="etiqueta">Lugar</span>
          <select className="campo" {...campo("lugarId")}>
            {config.lugares.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="etiqueta">Categoría</span>
          <input className="campo" list="categorias-fijo" {...campo("categoria")} />
          <datalist id="categorias-fijo">
            {config.categorias.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="etiqueta">{f.variable ? "Monto aproximado" : "Monto"}</span>
          <input className="campo" inputMode="decimal" placeholder="0,00" {...campo("monto")} />
        </label>
        <label className="block">
          <span className="etiqueta">Moneda</span>
          <select className="campo" {...campo("moneda")}>
            <option value="ARS">Pesos ($)</option>
            <option value="USD">Dólares (US$)</option>
          </select>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4 accent-marca-oscuro" checked={f.variable} onChange={(e) => setF({ ...f, variable: e.target.checked })} />
          Cambia mes a mes (luz, gas, agua): sugiere el promedio de lo que pagaste
        </label>
        <label className="block">
          <span className="etiqueta">Vence el día</span>
          <input className="campo" type="number" min={1} max={31} {...campo("dia")} />
        </label>
        <label className="block">
          <span className="etiqueta">Cada cuánto</span>
          <select className="campo" {...campo("frecuencia")}>
            {Object.entries(FRECUENCIAS_PAGO).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="etiqueta">Desde</span>
          <input className="campo" type="month" {...campo("desde")} />
          <span className="mt-0.5 block text-[11px] text-slate-400">Primer mes: {nombreMes(f.desde || periodoActual())}</span>
        </label>
        <label className="block">
          <span className="etiqueta">Cómo lo pagás</span>
          <input className="campo" list="medios-fijo" placeholder="Transferencia…" {...campo("medio")} />
          <datalist id="medios-fijo">
            {config.medios.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="etiqueta">N.º de cliente o cuenta</span>
          <input className="campo" placeholder="Opcional" {...campo("cuenta")} />
        </label>
        <label className="block">
          <span className="etiqueta">Aviso por WhatsApp</span>
          <select className="campo" {...campo("aviso")}>
            <option value="">Como en Configuración ({config.diasAviso} días antes)</option>
            <option value="0">Solo el día que vence</option>
            {[1, 2, 3, 5, 7, 10].map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? "día" : "días"} antes
              </option>
            ))}
            <option value="-1">No avisar</option>
          </select>
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Nota</span>
          <input className="campo" placeholder="Opcional" {...campo("nota")} />
        </label>
      </div>
    </Modal>
  );
}
