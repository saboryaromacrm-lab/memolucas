import { useState } from "react";
import { Building2, Home, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Boton, Cargando, Interruptor, MenuAcciones, Modal, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { describirAlcance, FRECUENCIAS_PAGO, nombreMes, periodoActual } from "../lib/pagos";
import type { AlcancePago, CampoFijo, ConfigPagos, FijoPago, FijoPropuesto, FrecuenciaPago, LugarPago, Moneda, PropuestaPagos, TipoLugar } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

/** Cada cosa que propone la IA, con su casilla para revisar antes de aplicar. */
type ItemIa = (
  | { tipo: "nuevo"; fijo: FijoPropuesto }
  | { tipo: "cambio"; antes: FijoPago; fijo: FijoPropuesto; campos: CampoFijo[] }
  | { tipo: "borrar"; antes: FijoPago }
) & { elegido: boolean };
/** Filtro de la lista: todos, un lugar, los generales o los repartidos. */
type FiltroLugar = number | "todos" | "general" | "repartido";

const textoAviso = (d: number | null, general: number) => (d === null ? `${general} días antes` : d < 0 ? "No avisar" : d === 0 ? "El día que vence" : `${d} ${d === 1 ? "día" : "días"} antes`);

export function PagosConfig() {
  const { datos } = useDatos<ConfigPagos>("/api/pagos/config", ["pagos"]);
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
        <Lugares lugares={datos.lugares} fijos={datos.fijos} elegido={lugar} onElegir={setLugar} />

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

      {editando && <ModalFijo fijo={editando === "nuevo" ? null : editando} lugarInicial={typeof lugar === "number" ? lugar : datos.lugares[0]?.id} config={datos} onCerrar={() => setEditando(null)} />}
    </div>
  );
}

const ETIQUETA_CAMPO: Record<CampoFijo, string> = {
  nombre: "Nombre",
  alcance: "A qué corresponde",
  categoria: "Categoría",
  monto: "Monto",
  variable: "Tipo de monto",
  moneda: "Moneda",
  vence: "Vencimiento",
  aviso: "Aviso",
  frecuencia: "Frecuencia",
  medio: "Medio de pago",
  cuenta: "Cuenta",
  nota: "Nota",
};

const INSIGNIA: Record<ItemIa["tipo"], [string, string]> = {
  nuevo: ["Nuevo", "bg-emerald-100 text-emerald-800"],
  cambio: ["Cambia", "bg-sky-100 text-sky-800"],
  borrar: ["Borrar", "bg-red-100 text-red-700"],
};

const cantidad = (n: number, uno: string, varios: string) => (n ? [`${n} ${n === 1 ? uno : varios}`] : []);

function CargarConIa({ config }: { config: ConfigPagos }) {
  const [texto, setTexto] = useState("");
  const [armando, setArmando] = useState(false);
  const [items, setItems] = useState<ItemIa[] | null>(null);
  const [mensaje, setMensaje] = useState("");
  const accion = useAccion();
  const lugarDe = (f: FijoPropuesto) => (f.lugarNuevo ? f.lugarNuevo.nombre : describirAlcance(f, config.lugares));
  const valor = (c: CampoFijo, f: FijoPropuesto) =>
    ({
      nombre: f.nombre,
      alcance: lugarDe(f) + (f.lugarNuevo ? " (lugar nuevo)" : ""),
      categoria: f.categoria,
      monto: f.monto ? plata(f.monto, f.moneda) : "sin monto",
      variable: f.variable ? "cambia mes a mes" : "fijo",
      moneda: f.moneda === "USD" ? "dólares" : "pesos",
      vence: f.dia ? `día ${f.dia}` : "sin vencimiento",
      aviso: textoAviso(f.avisoDias, config.diasAviso).toLowerCase(),
      frecuencia: FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
      medio: f.medio,
      cuenta: f.cuenta,
      nota: f.nota,
    })[c] || "—";

  const armar = async () => {
    setArmando(true);
    setMensaje("");
    const r = await accion(() => post<PropuestaPagos>("/api/pagos/ia/armar", { texto }));
    setArmando(false);
    if (!r) return;
    const cargado = (id: number) => config.fijos.find((f) => f.id === id);
    const lista: ItemIa[] = [
      ...r.cambios.flatMap((c) => {
        const antes = cargado(c.id);
        return antes ? [{ tipo: "cambio" as const, antes, fijo: c.despues, campos: c.campos, elegido: true }] : [];
      }),
      ...r.nuevos.map((fijo) => ({ tipo: "nuevo" as const, fijo, elegido: true })),
      // Lo que se borra arranca destildado: lo tildás vos.
      ...r.borrar.flatMap((id) => {
        const antes = cargado(id);
        return antes ? [{ tipo: "borrar" as const, antes, elegido: false }] : [];
      }),
    ];
    setMensaje(r.mensaje || (lista.length ? "" : "No encontré nada para agregar, cambiar ni borrar."));
    if (lista.length) setItems(lista);
  };
  const cerrar = () => {
    setItems(null);
    setMensaje("");
  };
  const elegidos = items?.filter((i) => i.elegido) ?? [];
  const aplicar = async () => {
    const nuevos = elegidos.flatMap((i) => (i.tipo === "nuevo" ? [i.fijo] : []));
    const cambios = elegidos.flatMap((i) => (i.tipo === "cambio" ? [{ id: i.antes.id, ...i.fijo }] : []));
    const borrar = elegidos.flatMap((i) => (i.tipo === "borrar" ? [i.antes.id] : []));
    const listo = [...cantidad(nuevos.length, "cargado", "cargados"), ...cantidad(cambios.length, "cambiado", "cambiados"), ...cantidad(borrar.length, "borrado", "borrados")];
    if (await accion(() => post("/api/pagos/fijos/aplicar", { nuevos, cambios, borrar }), `Listo: ${listo.join(", ")}`)) {
      cerrar();
      setTexto("");
    }
  };
  const elegirTodos = (elegido: boolean) => items && setItems(items.map((i) => ({ ...i, elegido })));

  return (
    <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
        <Sparkles className="size-4" /> Cargá o cambiá con IA
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Escribí o dictá lo que pagás o lo que querés cambiar, como te salga. La IA arma los cambios y los revisás antes de guardar (cuesta unos centavos).
      </p>
      <textarea
        className="campo mt-2 min-h-24"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="En el Express 1 pago alquiler 650 mil el 5 y la luz más o menos 70 mil… · Sacale el vencimiento a todo · El alquiler de Fontana subió a 850 mil · Borrá el gimnasio"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Boton variante="primario" icono={<Sparkles className="size-4" />} cargando={armando} disabled={texto.trim().length < 3} onClick={() => void armar()}>
          Armar con IA
        </Boton>
        {mensaje && !items && <p className="text-sm text-amber-700">{mensaje}</p>}
      </div>
      {items && (
        <Modal
          abierto
          onCerrar={cerrar}
          titulo={`Revisá lo que propone la IA (${items.length})`}
          ancho="max-w-4xl"
          pie={
            <>
              <Boton onClick={cerrar}>Cancelar</Boton>
              <Boton variante="primario" disabled={!elegidos.length} onClick={() => void aplicar()}>
                Aplicar {elegidos.length}
              </Boton>
            </>
          }
        >
          {mensaje && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{mensaje}</p>}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-500">Destildá lo que no va. Lo que se borra viene destildado: tildalo si va.</p>
            <div className="flex gap-1">
              <Boton variante="fantasma" chico onClick={() => elegirTodos(true)}>
                Elegir todos
              </Boton>
              <Boton variante="fantasma" chico onClick={() => elegirTodos(false)}>
                Ninguno
              </Boton>
            </div>
          </div>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {items.map((it, k) => {
              const f = it.tipo === "nuevo" ? it.fijo : it.antes;
              const [insignia, color] = INSIGNIA[it.tipo];
              return (
                <li key={k} className="flex items-start gap-3 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-marca-oscuro"
                    checked={it.elegido}
                    onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, elegido: e.target.checked } : x)))}
                    aria-label={`${insignia}: ${f.nombre}`}
                  />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="font-medium text-slate-900">
                      <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
                      {f.nombre} · {lugarDe(f)}
                      {it.tipo === "nuevo" && it.fijo.lugarNuevo && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Lugar nuevo</span>}
                    </div>
                    {it.tipo === "nuevo" && (
                      <div className="text-xs text-slate-500">
                        {[
                          f.categoria,
                          f.monto ? `${f.variable ? "~ " : ""}${plata(f.monto, f.moneda)}` : "sin monto",
                          f.dia ? `día ${f.dia}` : "sin vencimiento",
                          FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
                          f.medio,
                          f.cuenta,
                          f.nota,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                    {it.tipo === "cambio" && (
                      <ul className="mt-0.5 space-y-0.5 text-xs">
                        {it.campos.map((c) => (
                          <li key={c} className="text-slate-500">
                            {ETIQUETA_CAMPO[c]}: <span className="text-slate-400 line-through">{valor(c, it.antes)}</span> → <span className="font-medium text-slate-800">{valor(c, it.fijo)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {it.tipo === "borrar" && <div className="text-xs text-red-600">Se borra con sus pagos pendientes; lo pagado queda en el historial.</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Modal>
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

function ModalFijo({ fijo, lugarInicial, config, onCerrar }: { fijo: FijoPago | null; lugarInicial: number | undefined; config: ConfigPagos; onCerrar: () => void }) {
  const [f, setF] = useState({
    lugarId: String(fijo?.lugarId ?? lugarInicial ?? ""),
    nombre: fijo?.nombre ?? "",
    categoria: fijo?.categoria ?? "Servicios",
    monto: aCampo(fijo?.monto ?? 0, true),
    variable: fijo?.variable ?? false,
    moneda: (fijo?.moneda ?? "ARS") as Moneda,
    dia: String(fijo?.dia ?? 10),
    /** De entrada sin vencimiento: muchos pagos no tienen fecha. */
    conVencimiento: fijo ? fijo.dia !== null : false,
    frecuencia: (fijo?.frecuencia ?? "mensual") as FrecuenciaPago,
    desde: fijo?.desde ?? periodoActual(),
    medio: fijo?.medio ?? "",
    cuenta: fijo?.cuenta ?? "",
    aviso: fijo?.avisoDias === null || fijo?.avisoDias === undefined ? "" : String(fijo.avisoDias),
    nota: fijo?.nota ?? "",
  });
  const [alcance, setAlcance] = useState<AlcancePago>(fijo?.alcance ?? "lugar");
  const [tipoGeneral, setTipoGeneral] = useState<TipoLugar>(fijo?.tipo ?? "personal");
  // Entre qué lugares se reparte: lugarId → porcentaje escrito (solo con porcentajes).
  const [reparto, setReparto] = useState<Record<number, string>>(() => Object.fromEntries((fijo?.reparto ?? []).map((r) => [r.lugarId, r.porcentaje === null ? "" : aCampo(r.porcentaje)])));
  const [conPorcentajes, setConPorcentajes] = useState(!!fijo?.reparto?.length && fijo.reparto.every((r) => r.porcentaje !== null));
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const monto = aNumero(f.monto) ?? 0;
  const elegidos = Object.keys(reparto).map(Number);
  const suma = elegidos.reduce((s, id) => s + (aNumero(reparto[id]) ?? 0), 0);
  const repartoValido = elegidos.length >= 2 && (!conPorcentajes || Math.abs(suma - 100) < 0.01);
  const valido = f.nombre.trim() && (!f.conVencimiento || (Number(f.dia) >= 1 && Number(f.dia) <= 31)) && (alcance === "lugar" ? !!f.lugarId : alcance === "repartido" ? repartoValido : true);
  const alternar = (id: number) => setReparto((r) => (id in r ? Object.fromEntries(Object.entries(r).filter(([k]) => Number(k) !== id)) : { ...r, [id]: "" }));
  const guardar = async () => {
    const cuerpo = {
      ...f,
      alcance,
      lugarId: alcance === "lugar" ? Number(f.lugarId) : null,
      tipo: alcance === "general" ? tipoGeneral : null,
      reparto: alcance === "repartido" ? elegidos.map((id) => ({ lugarId: id, porcentaje: conPorcentajes ? (aNumero(reparto[id]) ?? 0) : null })) : null,
      monto,
      dia: f.conVencimiento ? Number(f.dia) : null,
      avisoDias: f.aviso === "" ? null : Number(f.aviso),
    };
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
        <div className="col-span-2">
          <span className="etiqueta">A qué corresponde</span>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ["lugar", "Un lugar"],
                ["repartido", "Repartido"],
                ["general", "General"],
              ] as const
            ).map(([a, texto]) => (
              <button
                key={a}
                type="button"
                onClick={() => setAlcance(a)}
                className={`min-h-9 rounded-md text-sm font-medium ${alcance === a ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                {texto}
              </button>
            ))}
          </div>
          {alcance === "lugar" && (
            <select className="campo mt-2" {...campo("lugarId")} aria-label="Lugar">
              {config.lugares.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nombre}
                </option>
              ))}
            </select>
          )}
          {alcance === "general" && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs text-slate-500">Sin lugar físico (la tarjeta, la cuota del auto, el celular…). Igual cuenta como negocio o personal.</p>
              <select className="campo" value={tipoGeneral} onChange={(e) => setTipoGeneral(e.target.value as TipoLugar)} aria-label="De negocio o personal">
                <option value="personal">Personal</option>
                <option value="negocio">Del negocio</option>
              </select>
            </div>
          )}
          {alcance === "repartido" && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-slate-500">Se paga una vez, y cada lugar suma su parte en el resumen (el contador, el abogado…).</p>
              <div className="flex flex-wrap gap-2">
                <Boton chico type="button" onClick={() => setReparto(Object.fromEntries(config.lugares.filter((l) => l.tipo === "negocio").map((l) => [l.id, reparto[l.id] ?? ""])))}>
                  Todos los negocios
                </Boton>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" className="size-4 accent-marca-oscuro" checked={conPorcentajes} onChange={(e) => setConPorcentajes(e.target.checked)} />
                  Con porcentajes (si no, partes iguales)
                </label>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {config.lugares.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-1.5">
                    <label className="flex flex-1 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" className="size-4 accent-marca-oscuro" checked={l.id in reparto} onChange={() => alternar(l.id)} />
                      {l.nombre}
                    </label>
                    {conPorcentajes && l.id in reparto && (
                      <span className="flex items-center gap-1 text-sm text-slate-500">
                        <input className="campo w-20 py-1 text-right" inputMode="decimal" value={reparto[l.id]} onChange={(e) => setReparto({ ...reparto, [l.id]: e.target.value })} aria-label={`Porcentaje de ${l.nombre}`} />%
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className={`text-xs ${repartoValido ? "text-slate-500" : "text-red-600"}`}>
                {elegidos.length < 2
                  ? "Elegí al menos 2 lugares."
                  : conPorcentajes
                    ? `Suma ${Math.round(suma * 100) / 100} %${Math.abs(suma - 100) < 0.01 ? "" : " (tiene que dar 100 %)"}`
                    : `${elegidos.length} lugares en partes iguales${monto ? `: ${plata(monto / elegidos.length, f.moneda)} cada uno` : ""}.`}
              </p>
            </div>
          )}
        </div>
        <label className="col-span-2 block">
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
        <div className="col-span-2">
          <Interruptor
            activo={f.conVencimiento}
            onChange={(v) => setF({ ...f, conVencimiento: v })}
            etiqueta="Tiene vencimiento"
            ayuda={f.conVencimiento ? "Te aviso antes y, si pasa la fecha sin pagarlo, queda como vencido." : "Sin fecha: aparece en el mes para pagar, sin avisos de vencimiento."}
          />
        </div>
        {f.conVencimiento && (
          <label className="block">
            <span className="etiqueta">Vence el día</span>
            <input className="campo" type="number" min={1} max={31} {...campo("dia")} />
          </label>
        )}
        <label className={f.conVencimiento ? "block" : "col-span-2 block"}>
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
        <label className={f.conVencimiento ? "block" : "hidden"}>
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
