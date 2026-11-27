import type { ReactNode } from "react";
import { ArrowLeftRight, Banknote, CircleDollarSign, CreditCard, Repeat, Smartphone, WalletCards } from "lucide-react";
import type { FormaPago, TipoFormaPago } from "../lib/tipos";

/** Cada tipo de forma de pago: cómo se llama y su ícono. */
export const TIPOS_FORMA: Record<TipoFormaPago, { texto: string; icono: ReactNode }> = {
  transferencia: { texto: "Transferencia", icono: <ArrowLeftRight /> },
  efectivo: { texto: "Efectivo", icono: <Banknote /> },
  debito_automatico: { texto: "Débito automático", icono: <Repeat /> },
  billetera: { texto: "Billetera virtual", icono: <Smartphone /> },
  credito: { texto: "Tarjeta de crédito", icono: <CreditCard /> },
  debito: { texto: "Tarjeta de débito", icono: <WalletCards /> },
  otro: { texto: "Otro", icono: <CircleDollarSign /> },
};

export function IconoForma({ tipo, className = "size-4" }: { tipo: TipoFormaPago; className?: string }) {
  return <span className={`inline-flex shrink-0 [&>svg]:size-full ${className}`}>{TIPOS_FORMA[tipo].icono}</span>;
}

/**
 * Elegir la forma de pago con un toque: botones grandes con su ícono. ninguna: el texto de la opción "sin forma" (si
 * se puede dejar sin elegir).
 */
export function ElegirForma({ formas, valor, onCambio, ninguna }: { formas: FormaPago[]; valor: number | null; onCambio: (id: number | null) => void; ninguna?: string }) {
  const activas = formas.filter((f) => !f.archivada || f.id === valor);
  if (!activas.length) return <p className="text-sm text-amber-700">Todavía no cargaste formas de pago: agregalas en Pagos › Configuración.</p>;
  const boton = (activo: boolean) =>
    `flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${activo ? "border-marca-oscuro bg-marca-suave font-medium text-marca-profundo ring-1 ring-marca-oscuro" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`;
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup">
      {activas.map((f) => (
        <button key={f.id} type="button" role="radio" aria-checked={valor === f.id} className={boton(valor === f.id)} onClick={() => onCambio(f.id)}>
          <IconoForma tipo={f.tipo} className={`size-4 ${valor === f.id ? "text-marca-oscuro" : "text-slate-400"}`} />
          <span className="min-w-0 break-words">{f.nombre}</span>
        </button>
      ))}
      {ninguna && (
        <button type="button" role="radio" aria-checked={valor === null} className={`${boton(valor === null)} italic`} onClick={() => onCambio(null)}>
          {ninguna}
        </button>
      )}
    </div>
  );
}
