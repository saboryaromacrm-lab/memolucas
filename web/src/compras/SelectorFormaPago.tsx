import type { FormaPago } from "../lib/tipos";
import { useVivo } from "./comun";

/** Elegir cómo se pagó. Se ofrecen las visibles; la elegida se muestra aunque esté oculta. */
export function SelectorFormaPago({ valor, onChange, className = "" }: { valor: number | null; onChange: (id: number | null) => void; className?: string }) {
  const { datos } = useVivo<FormaPago[]>("/api/c/formas-pago?ocultas=1");
  return (
    <select aria-label="Forma de pago" className={`campo ${className}`} value={valor ?? ""} onChange={(e) => onChange(Number(e.target.value) || null)}>
      <option value="">Sin especificar</option>
      {datos
        ?.filter((f) => !f.oculta || f.id === valor)
        .map((f) => (
          <option key={f.id} value={f.id}>
            {f.nombre}
          </option>
        ))}
    </select>
  );
}
