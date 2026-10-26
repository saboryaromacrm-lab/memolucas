/** "15 minutos", "1 hora", "2 horas y 30 minutos", "1 día". */
export function describirMinutos(min: number): string {
  if (min <= 0) return "un momento";
  const dias = Math.floor(min / 1440);
  const horas = Math.floor((min % 1440) / 60);
  const minutos = min % 60;
  const partes: string[] = [];
  if (dias) partes.push(dias === 1 ? "1 día" : `${dias} días`);
  if (horas) partes.push(horas === 1 ? "1 hora" : `${horas} horas`);
  if (minutos) partes.push(minutos === 1 ? "1 minuto" : `${minutos} minutos`);
  return partes.length > 1 ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}` : partes[0];
}

/** Saca tildes, signos y espacios de más: para comparar comandos. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¡!¿?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
