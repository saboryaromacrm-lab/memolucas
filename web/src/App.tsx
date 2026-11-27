import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ProveedorEditor } from "./componentes/Editor";
import { Layout } from "./componentes/Layout";
import { Cargando, ProveedorAvisos } from "./componentes/ui";
import { get } from "./lib/api";
import { esAppBloc } from "./lib/instalar";
import { fijarZona } from "./lib/fechas";
import { cerrarVivo } from "./lib/vivo";
import { Calculadoras } from "./paginas/Calculadoras";
import { Calendario } from "./paginas/Calendario";
import { Configuracion } from "./paginas/Configuracion";
import { Historial } from "./paginas/Historial";
import { Inicio } from "./paginas/Inicio";
import { Login } from "./paginas/Login";
import { Logs } from "./paginas/Logs";
import { Notas } from "./paginas/Notas";
import { Bloc } from "./paginas/Bloc";
import { Pagos } from "./paginas/Pagos";
import { Recordatorios } from "./paginas/Recordatorios";
import { Suscripciones } from "./paginas/Suscripciones";
import { Tarjetas } from "./paginas/Tarjetas";
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
        <Login bloc={esAppBloc()} onIngreso={() => setSesion(true)} />
      ) : (
        <BrowserRouter>
          <ProveedorEditor>
            {/* En su propia dirección, el Bloc es una app aparte: solo las pestañas y el texto, sin el panel. */}
            <Routes>
              <Route path="*" element={esAppBloc() ? <Bloc comoApp /> : <Panel />} />
            </Routes>
          </ProveedorEditor>
        </BrowserRouter>
      )}
    </ProveedorAvisos>
  );
}

/** El panel: el menú y todas las secciones. */
function Panel() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Inicio />} />
        <Route path="/recordatorios" element={<Recordatorios />} />
        <Route path="/calendario" element={<Calendario />} />
        <Route path="/notas" element={<Notas />} />
        <Route path="/bloc" element={<Bloc />} />
        <Route path="/pagos" element={<Pagos />} />
        <Route path="/calculadoras" element={<Calculadoras />} />
        <Route path="/suscripciones" element={<Suscripciones />} />
        <Route path="/tarjetas" element={<Tarjetas />} />
        <Route path="/whatsapp" element={<WhatsApp />} />
        <Route path="/historial" element={<Historial />} />
        <Route path="/configuracion" element={<Configuracion />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
