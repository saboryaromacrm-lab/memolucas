import { useEffect, useState } from "react";

/** Un estado (objeto) que se recuerda en este navegador (si el navegador no deja guardar, funciona igual sin recordarlo). */
export function useRecordado<T extends object>(clave: string, inicial: T): [T, (v: T) => void] {
  const [valor, setValor] = useState<T>(() => {
    try {
      const guardado = localStorage.getItem(clave);
      return guardado ? { ...inicial, ...(JSON.parse(guardado) as T) } : inicial;
    } catch {
      return inicial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(clave, JSON.stringify(valor));
    } catch {
      // Sin almacenamiento (modo privado): solo no se recuerda.
    }
  }, [clave, valor]);
  return [valor, setValor];
}
