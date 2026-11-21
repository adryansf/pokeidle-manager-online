import { Crosshair, HeartPulse, Layers, Pause, Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { Modal, Notice } from "@/components/SettingsView";
import { actions, useHuntCatalog } from "@/lib/actions";
import { useAccountIds, useAccountsMap } from "@/lib/telemetry";

const POTIONS = [
  { id: 70070, name: "Golden Potion" },
  { id: 204, name: "Ultimate Potion" },
  { id: 203, name: "Hyper Potion" },
  { id: 202, name: "Ultra Potion" },
  { id: 201, name: "Great Potion" },
  { id: 200, name: "Small Potion" },
];

const BALLS = [
  { id: 1, name: "Poké Ball" },
  { id: 2, name: "Great Ball" },
  { id: 3, name: "Super Ball" },
  { id: 4, name: "Ultra Ball" },
  { id: 5, name: "Beast Ball" },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Erro inesperado");

/** Ações em massa ("Modo Eco"): aplica pausas, Centro Pokémon, poção, bola ou hunt em todas as contas de uma vez. */
export function BulkActionsModal({ onClose }: { onClose: () => void }) {
  const ids = useAccountIds();
  const accounts = useAccountsMap();
  const { data: catalog } = useHuntCatalog(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [potionId, setPotionId] = useState(70070);
  const [ballId, setBallId] = useState(4);
  const [huntSlug, setHuntSlug] = useState("");

  const onlineCount = ids.filter((id) => accounts[id]?.status === "online").length;
  const pausedCount = ids.filter((id) => accounts[id]?.paused).length;

  const run = async (fn: () => Promise<{ tone: "ok" | "warn"; text: string }>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Ações em Massa (Modo Eco)" onClose={onClose} wide>
      <p className="text-xs text-mute sm:text-sm">
        Aplique comandos de uma só vez em todas as contas gerenciadas (
        <b className="text-fg">{onlineCount}</b> online · <b className="text-fg">{pausedCount}</b> pausadas ·{" "}
        <b className="text-fg">{ids.length}</b> total).
      </p>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* Controle geral de pausa & Centro */}
      <div className="space-y-2 rounded-xl border border-line bg-black/20 p-3.5">
        <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-poke-gold">
          <Layers className="size-3.5" aria-hidden />
          Controle Global
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || ids.length === 0}
            onClick={() =>
              void run(async () => {
                const r = await actions.bulkPause(true);
                return { tone: "ok", text: `${r.count} conta(s) pausada(s) manualmente.` };
              })
            }
            className="btn border-[#7a5a1c] bg-[#33260e] text-poke-gold hover:bg-[#463413]"
          >
            <Pause className="size-4" aria-hidden />
            Pausar todas
          </button>
          <button
            type="button"
            disabled={busy || ids.length === 0}
            onClick={() =>
              void run(async () => {
                const r = await actions.bulkPause(false);
                return { tone: "ok", text: `${r.count} conta(s) retomada(s).` };
              })
            }
            className="btn border-[#2f6b3a] bg-[#16301c] text-poke-green hover:bg-[#1e4226]"
          >
            <Play className="size-4" aria-hidden />
            Retomar todas
          </button>
          <button
            type="button"
            disabled={busy || onlineCount === 0}
            onClick={() =>
              void run(async () => {
                const r = await actions.bulkCenter();
                if (r.sent.length === 0) {
                  return { tone: "warn", text: "Nenhuma conta pôde ir ao Centro agora (em combate ou offline)." };
                }
                const extra = r.skipped.length > 0 ? ` (${r.skipped.length} puladas por combate/offline)` : "";
                return { tone: "ok", text: `Enviado ao Centro: ${r.sent.join(", ")}${extra}.` };
              })
            }
            className="btn"
          >
            <HeartPulse className="size-4 text-poke-red" aria-hidden />
            Curar no Centro (1×)
          </button>
        </div>
      </div>

      {/* Equipar Poção / Bola em todas */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-xl border border-line bg-black/20 p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-mute">
            <Sparkles className="size-3.5 text-poke-gold" aria-hidden />
            Poção em todas
          </div>
          <select
            className="field w-full text-sm"
            value={potionId}
            onChange={(e) => setPotionId(Number(e.target.value))}
          >
            {POTIONS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || onlineCount === 0}
            onClick={() =>
              void run(async () => {
                const r = await actions.bulkEquip("potion", potionId);
                return {
                  tone: r.updated.length > 0 ? "ok" : "warn",
                  text:
                    r.updated.length > 0
                      ? `Poção equipada em: ${r.updated.join(", ")}.`
                      : "Nenhuma conta online para equipar.",
                };
              })
            }
            className="btn w-full justify-center"
          >
            Equipar poção em todas
          </button>
        </div>

        <div className="space-y-2 rounded-xl border border-line bg-black/20 p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-mute">
            <Sparkles className="size-3.5 text-poke-gold" aria-hidden />
            Pokébola em todas
          </div>
          <select
            className="field w-full text-sm"
            value={ballId}
            onChange={(e) => setBallId(Number(e.target.value))}
          >
            {BALLS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || onlineCount === 0}
            onClick={() =>
              void run(async () => {
                const r = await actions.bulkEquip("ball", ballId);
                return {
                  tone: r.updated.length > 0 ? "ok" : "warn",
                  text:
                    r.updated.length > 0
                      ? `Bola equipada em: ${r.updated.join(", ")}.`
                      : "Nenhuma conta online para equipar.",
                };
              })
            }
            className="btn w-full justify-center"
          >
            Equipar bola em todas
          </button>
        </div>
      </div>

      {/* Trocar Hunt em todas */}
      {catalog && catalog.hunts.length > 0 && (
        <div className="space-y-2 rounded-xl border border-line bg-black/20 p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-mute">
            <Crosshair className="size-3.5 text-poke-gold" aria-hidden />
            Trocar Hunt em todas (usa fila automática se estiver em combate)
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="field flex-1 text-sm"
              value={huntSlug}
              onChange={(e) => setHuntSlug(e.target.value)}
            >
              <option value="">— Selecione uma hunt —</option>
              {catalog.hunts.map((h) => (
                <option key={h.slug} value={h.slug}>
                  {h.nome} (Nv. {h.nivel} · {h.regiao || h.area})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !huntSlug || onlineCount === 0}
              onClick={() =>
                void run(async () => {
                  const r = await actions.bulkHunt(huntSlug);
                  const parts: string[] = [];
                  if (r.sent.length) parts.push(`trocadas agora: ${r.sent.join(", ")}`);
                  if (r.queued.length) parts.push(`na fila pós-combate: ${r.queued.join(", ")}`);
                  if (r.skipped.length) parts.push(`puladas: ${r.skipped.join(", ")}`);
                  return {
                    tone: r.sent.length + r.queued.length > 0 ? "ok" : "warn",
                    text: parts.length ? parts.join(" · ") : "Nenhuma conta elegível.",
                  };
                })
              }
              className="btn border-0 bg-poke-gold font-bold text-void hover:bg-[#f6ca5e]"
            >
              Aplicar Hunt
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
