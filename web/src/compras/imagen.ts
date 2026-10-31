/** Achica la foto en el celular antes de subirla (sube rápido con datos móviles y se sigue leyendo bien). */
export async function comprimir(archivo: File): Promise<File> {
  if (archivo.type === "application/pdf") return archivo;
  try {
    const bmp = await createImageBitmap(archivo, { imageOrientation: "from-image" });
    const escala = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.round(bmp.width * escala);
    lienzo.height = Math.round(bmp.height * escala);
    lienzo.getContext("2d")!.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => lienzo.toBlob(r, "image/jpeg", 0.85));
    if (!blob) return archivo;
    return new File([blob], archivo.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return archivo; // Si el navegador no la puede abrir, se sube como está.
  }
}
