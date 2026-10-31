import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Download, FileText, Receipt, Search, Send, Trash2, X } from "lucide-react";
import { Boton, Cargando, Encabezado, Insignia, Modal, Vacio, useAccion, useAviso } from "../componentes/ui";
import { get, post, put } from "../lib/api";
import { fechaHora } from "../lib/fechas";
import type { Compra, ComprobanteDatos, Configuracion, EstadoCompra } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const FILTROS = [
  ["", "Todos"],
  ["pendiente", "A confirmar"],
  ["revisar", "A revisar"],
  ["confirmado", "Confirmados"],
  ["descartado", "Descartados"],
] as const;

const ESTADOS: Record<EstadoCompra, [string, string]> = {
  pendiente: ["A confirmar", "bg-sky-50 text-sky-700"],
  revisar: ["A revisar", "bg-amber-50 text-amber-700"],
  confirmado: ["Confirmado", "bg-marca-suave text-marca-profundo"],
  descartado: ["Descartado", "bg-slate-100 text-slate-500"],
};

const plata = (n: number | string | null, moneda = "PES") =>
  n === null ? "—" : `${moneda === "DOL" ? "US$" : "$"} ${Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CLASES: Record<string, string> = { mercaderia: "Mercadería", gasto: "Gasto", mixta: "Mixta", dudoso: "Dudosa" };
const fechaCorta = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : (iso ?? "—"));

function descargar(nombre: string, datos: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

export function Compras() {
  const [estado, setEstado] = useState("");
  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState<number | null>(null);
  const [elegidos, setElegidos] = useState<Set<number>>(new Set());
  const accion = useAccion();
  const avisar = useAviso();
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const ruta = `/api/compras?${new URLSearchParams({ ...(estado && { estado }), ...(busqueda.trim() && { q: busqueda.trim() }) })}`;
  const { datos, cargando } = useDatos<Compra[]>(ruta, ["compras"]);
  const visibles = useMemo(() => new Set(datos?.map((c) => c.id) ?? []), [datos]);
  const seleccion = [...elegidos].filter((id) => visibles.has(id));

  const exportar = async (como: "copiar" | "descargar") => {
    const json = await accion(() => post<{ comprobantes: ComprobanteDatos[] }>("/api/compras/exportar", { ids: seleccion }));
    if (!json) return;
    if (como === "descargar") descargar(`compras-${new Date().toISOString().slice(0, 10)}.json`, json);
    else {
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
      avisar(`JSON de ${seleccion.length} comprobante${seleccion.length > 1 ? "s" : ""} copiado`);
    }
  };

  const alternar = (id: number) =>
    setElegidos((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <Encabezado titulo="Compras" subtitulo="Facturas, remitos y tickets de proveedores que leyó el bot. Al confirmarlos pasan al ERP." />
      <div className="mb-4 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input className="campo pl-9" placeholder="Buscar por proveedor, número o CUIT…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {FILTROS.map(([v, t]) => (
            <button
              key={v}
              onClick={() => setEstado(v)}
              className={`shrink-0 rounded-full border px-3 py-1 text-sm font-medium transition ${
                estado === v ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {seleccion.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-marca/40 bg-marca-suave/60 px-3 py-2 text-sm">
            <span className="mr-auto font-medium text-marca-profundo">
              {seleccion.length} seleccionado{seleccion.length > 1 ? "s" : ""}
            </span>
            <Boton chico icono={<Copy className="size-3.5" />} onClick={() => exportar("copiar")}>
              Copiar JSON
            </Boton>
            <Boton chico icono={<Download className="size-3.5" />} onClick={() => exportar("descargar")}>
              Descargar .json
            </Boton>
            <Boton chico variante="fantasma" onClick={() => setElegidos(new Set())}>
              Limpiar
            </Boton>
          </div>
        )}
      </div>

      {cargando && !datos ? (
        <Cargando />
      ) : !datos?.length ? (
        <div className="tarjeta">
          <Vacio
            icono={<Receipt className="size-10" />}
            titulo={busqueda || estado ? "No hay resultados" : "Todavía no hay compras"}
            texto="Mandá la foto o el PDF de una factura al grupo de compras (o al bot por privado, con “factura” en el pie)."
          />
        </div>
      ) : (
        <div className="tarjeta divide-y divide-slate-100">
          {datos.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/60">
              <input type="checkbox" className="size-4 shrink-0 accent-marca-oscuro" checked={elegidos.has(c.id)} onChange={() => alternar(c.id)} aria-label="Seleccionar" />
              <button onClick={() => setAbierto(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-800">{c.proveedor || "Proveedor sin datos"}</span>
                    <Insignia className={ESTADOS[c.estado][1]}>{ESTADOS[c.estado][0]}</Insignia>
                    {c.enviadoEn && <Insignia className="bg-marca-suave text-marca-profundo">En el ERP</Insignia>}
                    {c.envioError && !c.enviadoEn && <Insignia className="bg-red-50 text-red-700">No se pudo enviar</Insignia>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {c.titulo} · {fechaCorta(c.fecha)} · {c.renglones} renglón{c.renglones === 1 ? "" : "es"}
                    {c.autor && ` · ${c.autor}`}
                    {c.origen === "panel" && " · Panel de compras"}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums text-slate-800">{plata(c.total, c.moneda)}</span>
                  <span className={`flex items-center justify-end gap-1 text-xs ${c.cierra ? "text-marca-profundo" : "text-amber-600"}`}>
                    {c.cierra ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                    {c.cierra ? "Cierra" : "No cierra"}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      {abierto && <Detalle id={abierto} onCerrar={() => setAbierto(null)} />}
    </div>
  );
}

function Detalle({ id, onCerrar }: { id: number; onCerrar: () => void }) {
  const { datos: c, recargar } = useDatos<Compra & { datos: ComprobanteDatos }>(`/api/compras/${id}`, ["compras"]);
  const [cfg, setCfg] = useState<Configuracion | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const accion = useAccion();
  const avisar = useAviso();
  useEffect(() => {
    void get<Configuracion>("/api/configuracion").then(setCfg);
  }, []);

  const hacer = async (clave: string, fn: () => Promise<unknown>, ok: string) => {
    setOcupado(clave);
    const r = await accion(fn, ok);
    setOcupado(null);
    return r;
  };
  const abierto = c && (c.estado === "pendiente" || c.estado === "revisar");

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      ancho="max-w-5xl"
      titulo={c ? `${c.titulo} · ${c.proveedor || "Proveedor sin datos"}` : "Comprobante"}
      pie={
        c && (
          <>
            {abierto && (
              <Boton variante="peligro" className="mr-auto" icono={<Trash2 className="size-4" />} cargando={ocupado === "des"} onClick={() => hacer("des", () => post(`/api/compras/${id}/descartar`), "Descartado")}>
                Descartar
              </Boton>
            )}
            <Boton
              icono={<Copy className="size-4" />}
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify({ comprobantes: [c.datos] }, null, 2));
                avisar("JSON copiado");
              }}
            >
              Copiar JSON
            </Boton>
            <Boton icono={<Download className="size-4" />} onClick={() => descargar(`compra-${id}.json`, { comprobantes: [c.datos] })}>
              Descargar
            </Boton>
            {c.estado === "confirmado" && cfg?.erpUrl && (
              <Boton icono={<Send className="size-4" />} cargando={ocupado === "env"} onClick={() => hacer("env", () => post(`/api/compras/${id}/enviar`), c.enviadoEn ? "Reenviado" : "Enviado al ERP")}>
                {c.enviadoEn ? "Reenviar al ERP" : "Enviar al ERP"}
              </Boton>
            )}
            {abierto && (
              <Boton variante="primario" icono={<Check className="size-4" />} cargando={ocupado === "conf"} onClick={() => hacer("conf", () => post(`/api/compras/${id}/confirmar`), "Confirmado")}>
                Confirmar
              </Boton>
            )}
          </>
        )
      }
    >
      {!c ? (
        <Cargando />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-3">
            {c.archivos.length ? (
              c.archivos.map((a) =>
                a.mime === "application/pdf" ? (
                  <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 p-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                    <FileText className="size-5 text-red-500" /> Abrir PDF
                  </a>
                ) : (
                  <a key={a.url} href={a.url} target="_blank" rel="noreferrer">
                    <img src={a.url} alt="Comprobante" className="w-full rounded-xl border border-slate-200" />
                  </a>
                ),
              )
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                {c.archivosBorrados ? "La foto o el PDF ya se borró (se guardan unos días). Los datos quedan." : "Sin archivo."}
              </p>
            )}
            <dl className="space-y-1 text-xs text-slate-500">
              <div>Cargado {fechaHora(c.creadoEn)}{c.autor ? ` por ${c.autor}` : ""}{c.grupoNombre ? ` en ${c.grupoNombre}` : ""}{c.origen === "panel" ? " desde el panel de compras" : ""}</div>
              {c.modelo && <div>Leído con {c.modelo}</div>}
              {c.enviadoEn && <div className="text-marca-profundo">Enviado al ERP {fechaHora(c.enviadoEn)}</div>}
              {c.envioError && <div className="text-red-600">Último error al enviar: {c.envioError}</div>}
            </dl>
          </div>

          <div className="min-w-0 space-y-4">
            {!c.cierra && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <div className="mb-1 flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="size-4" /> Las cuentas no cierran
                </div>
                {c.diferencias}
              </div>
            )}
            {c.dudas.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                <div className="mb-1 font-semibold">Dudas de la lectura</div>
                <ul className="list-disc pl-5">
                  {c.dudas.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {json === null ? (
              <Vista d={c.datos} />
            ) : (
              <div className="space-y-2">
                <textarea className="campo min-h-96 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
                <div className="flex justify-end gap-2">
                  <Boton variante="fantasma" icono={<X className="size-4" />} onClick={() => setJson(null)}>
                    Cancelar
                  </Boton>
                  <Boton
                    variante="primario"
                    cargando={ocupado === "json"}
                    onClick={async () => {
                      let datos: unknown;
                      try {
                        datos = JSON.parse(json);
                      } catch {
                        return avisar("El JSON tiene un error de formato", "error");
                      }
                      if (await hacer("json", () => put(`/api/compras/${id}`, { datos }), "Guardado; se rehicieron los controles")) {
                        setJson(null);
                        await recargar();
                      }
                    }}
                  >
                    Guardar cambios
                  </Boton>
                </div>
              </div>
            )}
            {json === null && abierto && (
              <button className="text-xs font-medium text-slate-500 underline hover:text-slate-800" onClick={() => setJson(JSON.stringify(c.datos, null, 2))}>
                Corregir a mano (editar el JSON)
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Vista({ d }: { d: ComprobanteDatos }) {
  const e = d.encabezado;
  const m = String(e.moneda || "PES");
  const datosEncabezado: [string, string | number][] = [
    ["Fecha", fechaCorta(String(e.fecha))],
    ["CUIT emisor", e.cuitEmisor],
    ["Condición IVA", String(e.condicionIvaEmisor).replace("_", " ")],
    ["CAE", e.cae],
    ["Receptor", [e.razonSocialReceptor, e.cuitReceptor].filter(Boolean).join(" · ")],
    ["Condición de venta", e.condicionVentaImpresa],
    ["Vencimiento", fechaCorta(String(e.vencimientoPago) || null)],
    ["Clase", `${CLASES[d.clase] ?? d.clase}${d.motivoClase ? ` (${d.motivoClase})` : ""}`],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {datosEncabezado
          .filter(([, v]) => v && v !== "—")
          .map(([t, v]) => (
            <div key={t}>
              <dt className="etiqueta">{t}</dt>
              <dd className="break-words text-slate-800">{v}</dd>
            </div>
          ))}
      </dl>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Descripción</th>
              <th className="px-2 py-2 text-right">Cant.</th>
              <th className="px-2 py-2 text-right">P. unit.</th>
              <th className="px-2 py-2 text-right">Desc.</th>
              <th className="px-2 py-2 text-right">Importe</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.renglones.map((r, i) => (
              <tr key={i} className={r.cierra ? "" : "bg-amber-50"}>
                <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                <td className="px-2 py-1.5">
                  <span className="text-slate-800">{r.descripcion}</span>
                  <span className="block text-[11px] text-slate-400">
                    {[r.codigo, CLASES[r.clase] ?? r.clase, r.unidadesPorBulto ? `x ${r.unidadesPorBulto}` : "", r.alicuotaIva ? `IVA ${r.alicuotaIva}%` : ""].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                  {r.cantidad} {r.unidad}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{plata(r.precioUnitario, m)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{r.descuentos.length ? `${r.descuentos.join("+")}%` : ""}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums">{plata(r.importe, m)}</td>
                <td className="px-2 py-1.5">{r.cierra ? <CheckCircle2 className="size-3.5 text-marca-oscuro" /> : <AlertTriangle className="size-3.5 text-amber-600" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto max-w-xs space-y-1 text-sm">
        <Fila t="Suma de renglones" v={plata(d.controles.sumaRenglones, m)} />
        {d.pie.subtotal > 0 && <Fila t="Subtotal" v={plata(d.pie.subtotal, m)} ok={d.controles.cierraSubtotal} />}
        {d.pie.bonificacionImporte > 0 && <Fila t={`Bonificación ${d.pie.bonificacionPct ? `${d.pie.bonificacionPct}%` : ""}`} v={`− ${plata(d.pie.bonificacionImporte, m)}`} />}
        {d.pie.ivas.map((i) => (
          <Fila key={`iva${i.alicuota}`} t={`IVA ${i.alicuota}%`} v={plata(i.importe, m)} />
        ))}
        {d.pie.percepciones.map((p) => (
          <Fila key={p.nombre} t={p.nombre} v={plata(p.importe, m)} />
        ))}
        {d.pie.impuestosInternos > 0 && <Fila t="Impuestos internos" v={plata(d.pie.impuestosInternos, m)} />}
        {d.pie.otrosImpuestos > 0 && <Fila t="Otros impuestos" v={plata(d.pie.otrosImpuestos, m)} />}
        <Fila t="Total" v={plata(d.pie.total, m)} ok={d.controles.cierraTotal} fuerte />
      </dl>
      {d.pagoQueFigura.figura && (
        <p className="text-xs text-slate-500">
          Figura pagado: {d.pagoQueFigura.medio.replace("_", " ")} {d.pagoQueFigura.importe ? plata(d.pagoQueFigura.importe, m) : ""} {d.pagoQueFigura.referencia}
        </p>
      )}
    </div>
  );
}

function Fila({ t, v, ok, fuerte }: { t: string; v: string; ok?: boolean; fuerte?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${fuerte ? "border-t border-slate-200 pt-1 font-semibold text-slate-900" : "text-slate-600"}`}>
      <dt>{t}</dt>
      <dd className="flex items-center gap-1 tabular-nums">
        {v}
        {ok === true && <CheckCircle2 className="size-3.5 text-marca-oscuro" />}
        {ok === false && <AlertTriangle className="size-3.5 text-amber-600" />}
      </dd>
    </div>
  );
}
