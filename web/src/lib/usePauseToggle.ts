import { useCallback, useRef, useState } from "react";
import { actions } from "./actions";
import { computeBestHuntSlug, type HuntOrder } from "./huntAdvisor";
import { useAccount } from "./telemetry";
import type { AccountAutomation } from "./types";

/**
 * Antes de retomar uma conta em Auto-Hunt, recalcula a #1 do Mapa (simulador real) para ela
 * voltar direto para a melhor hunt do Pokémon equipado, e não para a hunt antiga.
 */
export async function syncBestHuntBeforeResume(accId: string, auto?: AccountAutomation | null) {
  if (!auto?.autoBestHunt) return;
  const prio = (auto.autoBestHuntPriority || "xp") as HuntOrder;
  const reg = auto.autoBestHuntRegion || "all";
  const sim = await computeBestHuntSlug(accId, prio, reg).catch(() => null);
  if (sim?.slug && sim.slug !== auto.autoBestHuntSlug) {
    await actions.setAutomation(accId, { autoBestHuntSlug: sim.slug }).catch(() => {});
  }
}

/**
 * Pausar/Retomar de uma conta, igual em todo o painel (card, detalhes, Live).
 * Pausar: vai ao Pokécentro e desconecta sem reconectar. Retomar: recalcula o Auto-Hunt e reconecta.
 */
export function usePauseToggle(accId: string) {
  const acc = useAccount(accId);
  const accRef = useRef(acc);
  accRef.current = acc;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `force` só vale para pausar: "rope" usa Escape Rope, "forfeit" desiste do combate. */
  const setPaused = useCallback(
    async (paused: boolean, force?: "rope" | "forfeit") => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        if (!paused) await syncBestHuntBeforeResume(accId, accRef.current?.automation);
        await actions.pause(accId, paused, force);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : paused ? "Não foi possível pausar a conta" : "Não foi possível retomar a conta");
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [accId],
  );

  const paused = Boolean(acc?.paused);
  return {
    paused,
    /** Pausa pedida, esperando o fim do combate para ir ao Pokécentro. */
    pending: Boolean(acc?.farmPausePending),
    busy,
    error,
    clearError: useCallback(() => setError(null), []),
    setPaused,
    toggle: useCallback(() => setPaused(!accRef.current?.paused), [setPaused]),
    label: paused ? "Retomar" : "Pausar",
    title: paused
      ? "Retomar: reconecta a conta e volta para a hunt (no Auto-Hunt, recalcula a melhor antes)"
      : "Pausar: vai ao Pokécentro e desconecta, sem tentar reconectar",
  };
}
