import { useEffect, useState } from "react";
import { call } from "./admin";

/** "acc3" -> 3 (as rotas de ação usam o id numérico da conta). */
export const numId = (accId: string) => Number(accId.replace(/\D/g, ""));

export interface EquipResult {
  ok: boolean;
  stock: number;
  /** O bot vai comprar agora (estoque abaixo do mínimo e reposição ligada). */
  willBuy: boolean;
  restockEnabled: boolean;
  buyable: boolean;
}
export interface HuntResult {
  ok: boolean;
  /** O jogo confirmou a troca (evento `hunt`). false = ignorou (em combate, nível baixo...). */
  confirmed: boolean;
  slug: string;
  /** A conta estava em combate: a troca ficou na fila e o bot faz sozinho quando a trava acabar. */
  queued?: boolean;
  waitMs?: number;
}

/** O Pokémon equipado de uma conta, como a calculadora de hunt precisa. */
export interface PokemonSheet {
  id: number;
  speciesId: number;
  nome: string;
  looktype?: number | null;
  level: number;
  shiny: boolean;
  quality: number;
  potencia: number;
  stats: Record<string, number>;
  ivs: Record<string, number>;
  refino?: Record<string, number>;
  tmAoe: boolean;
  trainerLevel: number;
  tipoDoDia?: string | null;
  escudo?: boolean;
  ballId?: number | null;
  comPocao?: boolean;
}

export interface PauseResult {
  ok: boolean;
  paused: boolean;
  state: string;
}

export interface LiveDrop {
  name: string;
  qty: number;
}

export interface LiveSlot {
  slot: number;
  name: string;
  pokeId?: number | null;
  looktype?: number | null;
  level?: number | null;
  shiny: boolean;
  inferred?: boolean;
  hp?: number | null;
  maxHp?: number | null;
  state: "fighting" | "corpse" | "caught" | "escaped" | string;
  lastMove?: string | null;
  lastDamage?: number | null;
  ballId?: number | null;
  ballName?: string | null;
  chance?: number | null;
  xp?: number | null;
  gold?: number | null;
  drops: LiveDrop[];
  ageMs: number;
}

export interface LiveEvent {
  id?: number;
  ts: number;
  kind: "attack" | "kill" | "ball" | "flee" | "hunt" | "buy" | "potion" | "center" | string;
  slot?: number | null;
  name?: string | null;
  slug?: string | null;
  move?: string | null;
  damage?: number | null;
  hp?: number | null;
  hpPct?: number | null;
  manual?: boolean;
  level?: number | null;
  shiny?: boolean;
  xp?: number | null;
  gold?: number | null;
  drops?: LiveDrop[];
  ballId?: number | null;
  caught?: boolean;
  chance?: number | null;
  qty?: number | null;
  cost?: number | null;
  reason?: string | null;
}

export interface LiveHuntSpecies {
  pokeId: number;
  name: string;
  points: number;
  looktype?: number | null;
}

export interface AccountLive {
  account: string;
  numericId: number;
  nick: string;
  state: string;
  paused: boolean;
  farmPaused?: boolean;
  farmPausePending?: boolean;
  location?: import("./types").AccountLocation | null;
  escapeRopes?: number;
  lastReason?: string;
  combatLockMs: number;
  hunt: {
    slug: string;
    name: string;
    level: number;
    kills: number;
    minutes: number;
    species: LiveHuntSpecies[];
  } | null;
  pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    level?: number | null;
    looktype?: number | null;
    shiny?: boolean;
  } | null;
  slots: LiveSlot[];
  events: LiveEvent[];
}

export interface CaptureRow {
  id: number;
  ts: number;
  accountId: number;
  account: string;
  nick: string;
  name: string;
  pokeId?: number | null;
  looktype?: number | null;
  level?: number | null;
  shiny: boolean;
  ballId?: number | null;
  ballName?: string | null;
  success: boolean;
  chance?: number | null;
  huntSlug: string;
}

export interface CaptureStats {
  total: number;
  caught: number;
  failed: number;
  rate: number;
  shinySeen: number;
  shinyCaught: number;
  byBall: { ballId: number; ballName: string; used: number; caught: number }[];
}

export interface CapturesResponse {
  stats: CaptureStats;
  items: CaptureRow[];
}

export type AutomationPatch = Partial<{
  autoCatch: boolean;
  autoPotion: boolean;
  potionThreshold: number;
  potionQty: number;
  autoBallRestock: boolean;
  ballThreshold: number;
  ballQty: number;
  autoReviveRestock: boolean;
  reviveId: number;
  reviveThreshold: number;
  reviveQty: number;
  autoPotionFallback: boolean;
  autoCenter: boolean;
  autoCenterHpPct: number;
  goldReserve: number;
  huntSlug: string;
  autoBestHunt: boolean;
  autoBestHuntRegion: string;
  autoPassClaim: boolean;
  gameAutoPotion: boolean;
  gameAutoRevive: boolean;
  autoVoltarHunt: boolean;
  hpLimiarPct: number;
  pvpAuto: boolean;
}>;

export const actions = {
  equip: (accId: string, kind: "ball" | "potion", id: number) =>
    call<EquipResult>("POST", `/api/accounts/${numId(accId)}/equip`, { kind, id }),
  setActivePokemon: (accId: string, pokemonId: number) =>
    call<{ ok: boolean; confirmed: boolean; pokemonId: number }>(
      "POST",
      `/api/accounts/${numId(accId)}/team/active`,
      { pokemonId },
    ),
  selectHunt: (accId: string, slug: string) => call<HuntResult>("POST", `/api/accounts/${numId(accId)}/hunt`, { slug }),
  selectOutlandTier: (accId: string, tier: number) =>
    call<{ ok: boolean; confirmed: boolean; tier: number }>("POST", `/api/accounts/${numId(accId)}/outland-tier`, { tier }),
  sheet: (accId: string) => call<PokemonSheet>("GET", `/api/accounts/${numId(accId)}/sheet`),
  resetSession: () => call<{ ok: boolean; reset: string[] }>("POST", "/api/session/reset"),
  cancelHuntQueue: (accId: string) => call<{ ok: boolean }>("DELETE", `/api/accounts/${numId(accId)}/hunt/queue`),
  pause: (accId: string, paused?: boolean) =>
    call<PauseResult>("POST", `/api/accounts/${numId(accId)}/pause`, paused === undefined ? {} : { paused }),
  farmPause: (accId: string, paused?: boolean, force?: "rope" | "forfeit") =>
    call<{ ok: boolean; farmPaused: boolean; sentCenter?: boolean; queued?: boolean; inCenter?: boolean; method?: string; resumeSlug?: string | null }>(
      "POST",
      `/api/accounts/${numId(accId)}/farm-pause`,
      force ? { paused: true, force } : paused === undefined ? {} : { paused },
    ),
  live: (accId: string) => call<AccountLive>("GET", `/api/accounts/${numId(accId)}/live`),
  goCenter: (accId: string, force?: "rope" | "forfeit") =>
    call<{ ok: boolean; method?: string }>("POST", `/api/accounts/${numId(accId)}/center`, force ? { force } : {}),
  setAutomation: (accId: string, patch: AutomationPatch) =>
    call<{ ok: boolean; automation: import("./types").AccountAutomation }>("POST", `/api/accounts/${numId(accId)}/automation`, patch),
  captures: (opts?: { account?: string; onlyCaught?: boolean; onlyShiny?: boolean; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.account && opts.account !== "all") q.set("account", opts.account);
    if (opts?.onlyCaught) q.set("only_caught", "true");
    if (opts?.onlyShiny) q.set("only_shiny", "true");
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return call<CapturesResponse>("GET", `/api/captures${qs ? `?${qs}` : ""}`);
  },
  bulkPause: (paused: boolean) => call<{ ok: boolean; paused: boolean; count: number }>("POST", "/api/bulk/pause", { paused }),
  bulkFarmPause: (paused: boolean) => call<{ ok: boolean; farmPaused: boolean; count: number }>("POST", "/api/bulk/farm-pause", { paused }),
  bulkCenter: () => call<{ ok: boolean; sent: string[]; skipped: string[] }>("POST", "/api/bulk/center"),
  bulkEquip: (kind: "ball" | "potion", id: number) =>
    call<{ ok: boolean; updated: string[]; skipped: string[] }>("POST", "/api/bulk/equip", { kind, id }),
  bulkHunt: (slug: string) =>
    call<{ ok: boolean; sent: string[]; queued: string[]; skipped: string[] }>("POST", "/api/bulk/hunt", { slug }),
};

export interface HuntSpecies {
  pokeId: number;
  nome: string;
  pontos: number;
}
export interface Hunt {
  slug: string;
  nome: string;
  area: string;
  nivel: number;
  regiao?: string | null;
  pixel?: [number, number] | null;
  looktype?: number | null;
  totalSpawns: number;
  especies: HuntSpecies[];
}
/** Um nível (tier) de Outland: `nivel` é o nível de treinador que libera, `mult` o multiplicador de itens raros. */
export interface OutlandTier {
  tier: number;
  rotulo: string;
  nivel: number;
  mult: number;
}
export interface HuntCatalog {
  account: string | null;
  level: number;
  current: string | null;
  hunts: Hunt[];
  outland?: { tiers: OutlandTier[]; tier: number };
}
/** Dados do jogo por espécie: nome, tipos, nomes do loot e looktype. */
export interface Creature {
  n: string;
  t: string[];
  l: string[];
  lk: number | null;
}

/** Catálogo de hunts (vem do `welcome` de uma conta conectada). */
export function useHuntCatalog(account: string | null) {
  const [data, setData] = useState<HuntCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      call<HuntCatalog>("GET", `/api/hunts${account ? `?account=${account}` : ""}`)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : "Erro inesperado"));
    void load();
    // Se o catálogo veio vazio (contas ainda conectando), tenta de novo logo.
    const i = setInterval(() => void load(), 6000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [account]);
  return { data, error };
}

let creaturesCache: Promise<Record<string, Creature>> | null = null;
/** Tipos e loot das espécies (um download só, guardado enquanto a página estiver aberta). */
export function useCreatures() {
  const [data, setData] = useState<Record<string, Creature> | null>(null);
  useEffect(() => {
    let alive = true;
    creaturesCache ??= call<Record<string, Creature>>("GET", "/api/creatures").catch((e) => {
      creaturesCache = null;
      throw e;
    });
    creaturesCache.then((d) => alive && setData(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return data;
}
