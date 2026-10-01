import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DemoPage from "./demo/DemoPage";
import Layout from "./admin/Layout";
import FlagsPage from "./admin/FlagsPage";
import HealthPage from "./admin/HealthPage";
import EvaluationsPage from "./admin/EvaluationsPage";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/admin" element={<Layout />}>
            <Route index element={<Navigate to="flags" replace />} />
            <Route path="flags" element={<FlagsPage />} />
            <Route path="health" element={<HealthPage />} />
            <Route path="evaluations" element={<EvaluationsPage />} />
          </Route>
          <Route path="/demo" element={<DemoPage />} />
          <Route path="*" element={<Navigate to="/admin/flags" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
