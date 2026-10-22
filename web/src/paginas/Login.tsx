import { useEffect, useRef, useState } from "react";
import { Delete, Lock } from "lucide-react";
import { post } from "../lib/api";

export function Login({ onIngreso }: { onIngreso: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  async function ingresar(valor = pin) {
    if (valor.length < 4 || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await post("/api/auth/login", { pin: valor });
      onIngreso();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo ingresar");
      setPin("");
      input.current?.focus();
    } finally {
      setEnviando(false);
    }
  }

  const tocar = (d: string) => {
    if (pin.length >= 8) return;
    setPin(pin + d);
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-white to-slate-100 px-4 py-10">
      <div className="w-full max-w-xs">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/icono.svg" alt="" className="mb-3 size-14 rounded-2xl shadow-sm" />
          <h1 className="text-xl font-semibold text-slate-900">Memolucas</h1>
          <p className="mt-1 flex items-center gap-1 text-sm text-slate-500">
            <Lock className="size-3.5" /> Ingresá tu PIN
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ingresar();
          }}
        >
          <input
            ref={input}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            className="campo mb-2 text-center text-2xl tracking-[0.5em]"
            aria-label="PIN"
          />
          <div className="mb-3 h-5 text-center text-sm text-red-600">{error}</div>
          <div className="grid grid-cols-3 gap-2.5">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" onClick={() => tocar(d)} className="h-14 rounded-xl border border-slate-200 bg-white text-xl font-medium text-slate-800 shadow-sm active:bg-slate-100">
                {d}
              </button>
            ))}
            <button type="button" onClick={() => setPin(pin.slice(0, -1))} className="flex h-14 items-center justify-center rounded-xl text-slate-500 active:bg-slate-100" aria-label="Borrar">
              <Delete className="size-6" />
            </button>
            <button type="button" onClick={() => tocar("0")} className="h-14 rounded-xl border border-slate-200 bg-white text-xl font-medium text-slate-800 shadow-sm active:bg-slate-100">
              0
            </button>
            <button
              type="submit"
              disabled={pin.length < 4 || enviando}
              className="h-14 rounded-xl bg-marca-oscuro text-sm font-semibold text-white shadow-sm disabled:opacity-40"
            >
              Entrar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
