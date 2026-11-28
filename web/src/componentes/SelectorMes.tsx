import { ChevronLeft, ChevronRight } from "lucide-react";
import { nombreMes, periodoActual, sumarMeses } from "../lib/pagos";
import { Boton } from "./ui";

/** El mes que se está mirando, con las flechas para ir al anterior o al siguiente; tocando el nombre vuelve a este mes. */
export function SelectorMes({ periodo, onPeriodo }: { periodo: string; onPeriodo: (p: string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Boton chico aria-label="Mes anterior" onClick={() => onPeriodo(sumarMeses(periodo, -1))}>
        <ChevronLeft className="size-4" />
      </Boton>
      <button onClick={() => onPeriodo(periodoActual())} title="Volver a este mes" className="min-w-36 px-2 text-center text-sm font-semibold text-slate-900">
        {nombreMes(periodo)}
      </button>
      <Boton chico aria-label="Mes siguiente" onClick={() => onPeriodo(sumarMeses(periodo, 1))}>
        <ChevronRight className="size-4" />
      </Boton>
    </div>
  );
}
