/** Para buscar sin importar mayúsculas ni tildes: "Café" → "cafe". */
export const sinTildes = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
