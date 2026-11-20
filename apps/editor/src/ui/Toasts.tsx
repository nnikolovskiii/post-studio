import { useEditor } from "../store.ts";

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
