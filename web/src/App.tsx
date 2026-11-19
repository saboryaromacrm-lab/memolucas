import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ProveedorEditor } from "./componentes/Editor";
import { Layout } from "./componentes/Layout";
import { Cargando, ProveedorAvisos } from "./componentes/ui";
import { get } from "./lib/api";
import { fijarZona } from "./lib/fechas";
import { cerrarVivo } from "./lib/vivo";
import { Calendario } from "./paginas/Calendario";
import { Configuracion } from "./paginas/Configuracion";
import { Historial } from "./paginas/Historial";
import { Inicio } from "./paginas/Inicio";
import { Login } from "./paginas/Login";
import { Logs } from "./paginas/Logs";
import { Notas } from "./paginas/Notas";
import { Recordatorios } from "./paginas/Recordatorios";
import { WhatsApp } from "./paginas/WhatsApp";

export function App() {
  const [sesion, setSesion] = useState<boolean | null>(null);

  useEffect(() => {
    get<{ autenticado: boolean }>("/api/auth/sesion")
      .then((r) => setSesion(r.autenticado))
      .catch(() => setSesion(false));
    const vencida = () => {
      cerrarVivo();
      setSesion(false);
    };
    window.addEventListener("sesion-vencida", vencida);
    return () => window.removeEventListener("sesion-vencida", vencida);
  }, []);

  useEffect(() => {
    if (sesion) get<{ zonaHoraria: string }>("/api/configuracion").then((c) => fijarZona(c.zonaHoraria)).catch(() => {});
  }, [sesion]);

  if (sesion === null) return <Cargando />;

  return (
    <ProveedorAvisos>
      {!sesion ? (
        <Login onIngreso={() => setSesion(true)} />
      ) : (
        <BrowserRouter>
          <ProveedorEditor>
            <Layout>
              <Routes>
                <Route path="/" element={<Inicio />} />
                <Route path="/recordatorios" element={<Recordatorios />} />
                <Route path="/calendario" element={<Calendario />} />
                <Route path="/notas" element={<Notas />} />
                <Route path="/whatsapp" element={<WhatsApp />} />
                <Route path="/historial" element={<Historial />} />
                <Route path="/configuracion" element={<Configuracion />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </ProveedorEditor>
        </BrowserRouter>
      )}
    </ProveedorAvisos>
  );
}
