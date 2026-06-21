import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PreviewBrowserProvider } from "@/components/PreviewBrowserPool";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <PreviewBrowserProvider>
        <App />
      </PreviewBrowserProvider>
      <Toaster />
    </TooltipProvider>
  </StrictMode>
);
