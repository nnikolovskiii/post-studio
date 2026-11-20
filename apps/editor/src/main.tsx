import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./styles.css";
import "./phone.css";

createRoot(document.getElementById("root")!).render(<App />);

// Read-only handle for tests and debugging in the console (same origin only).
import { useEditor } from "./store.ts";
import { perf, useTime } from "./timeline.ts";
(window as unknown as { __postStudio: unknown }).__postStudio = { useEditor, useTime, perf };
