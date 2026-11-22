import type { AccountAutomation } from "./types";

/** Modo de hunt da conta. Manual = fica onde está; Fixa = sempre a mesma hunt; Automática = melhor hunt do simulador. */
export type HuntMode = "manual" | "fixa" | "auto";

export const huntModeOf = (a?: AccountAutomation | null): HuntMode =>
  a?.autoBestHunt ? "auto" : a?.huntSlug ? "fixa" : "manual";

export const HUNT_PRIORITIES: { id: string; label: string; short: string }[] = [
  { id: "xp", label: "XP/h (Pokémon)", short: "XP" },
  { id: "xpTreinador", label: "XP/h (Treinador)", short: "XP Trein." },
  { id: "ouro", label: "Ouro/h", short: "Ouro" },
  { id: "shiny", label: "Shiny/h", short: "Shiny" },
  { id: "fragmento", label: "Fragmento/h", short: "Frag." },
];

export const HUNT_REGIONS: { id: string; label: string }[] = [
  { id: "all", label: "Todas as regiões" },
  { id: "kanto", label: "Kanto" },
  { id: "outland", label: "Outland" },
  { id: "johto", label: "Johto" },
  { id: "hoenn", label: "Hoenn" },
  { id: "sinnoh", label: "Sinnoh" },
  { id: "unova", label: "Unova" },
  { id: "kalos", label: "Kalos" },
  { id: "alola", label: "Alola" },
  { id: "galar", label: "Galar" },
  { id: "paldea", label: "Paldea" },
  { id: "orre", label: "Orre" },
];

export const prettySlug = (s?: string | null) =>
  s ? s.replace(/[_-]+/g, " ").replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase()) : "—";

/** "Auto · XP · Johto" / "Fixa · Onix Cave" / "Manual" (rótulo curto para o card). */
export function huntModeLabel(a: AccountAutomation | null | undefined, fixedName?: string | null): string {
  const mode = huntModeOf(a);
  if (mode === "auto") {
    const p = HUNT_PRIORITIES.find((x) => x.id === (a?.autoBestHuntPriority || "xp"))?.short ?? "XP";
    const r = a?.autoBestHuntRegion && a.autoBestHuntRegion !== "all" ? HUNT_REGIONS.find((x) => x.id === a.autoBestHuntRegion)?.label ?? a.autoBestHuntRegion : "";
    return `Auto · ${p}${r ? ` · ${r}` : ""}`;
  }
  if (mode === "fixa") return `Fixa · ${fixedName || prettySlug(a?.huntSlug)}`;
  return "Manual";
}

/** As automações liga/desliga mostradas no resumo do card (o modo de hunt fica à parte). */
export const AUTOMATION_FLAGS: { key: keyof AccountAutomation; label: string }[] = [
  { key: "gameAutoPotion", label: "Cura automática" },
  { key: "gameAutoRevive", label: "Revive ao desmaiar" },
  { key: "autoPotionFallback", label: "Fallback de poção" },
  { key: "autoCenter", label: "Auto-Centro" },
  { key: "autoPotion", label: "Repor poções" },
  { key: "autoBallRestock", label: "Repor Pokébolas" },
  { key: "autoReviveRestock", label: "Repor Revives" },
  { key: "autoCatch", label: "Captura" },
  { key: "autoPassClaim", label: "Passe" },
  { key: "pvpAuto", label: "PVP" },
  { key: "autoVoltarHunt", label: "Voltar à hunt" },
];

export function automationCount(a?: AccountAutomation | null) {
  if (!a) return { on: 0, total: AUTOMATION_FLAGS.length };
  return { on: AUTOMATION_FLAGS.filter((f) => Boolean(a[f.key])).length, total: AUTOMATION_FLAGS.length };
}
