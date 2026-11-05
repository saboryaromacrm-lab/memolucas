// CSV para Excel en español: separado con ; y con coma decimal.

export const numero = (n: number | null | undefined) => (n === null || n === undefined ? "" : n.toFixed(2).replace(".", ","));
export const celda = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Con BOM, para que Excel lea bien los acentos. */
export const csv = (lineas: string[]) => `\uFEFF${lineas.join("\r\n")}`;
