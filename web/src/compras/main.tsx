import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProveedorAvisos } from "../componentes/ui";
import { AppCompras } from "./App";
import "./compras.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProveedorAvisos>
      <AppCompras />
    </ProveedorAvisos>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw-compras.js"));
}
