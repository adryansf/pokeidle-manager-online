import { call } from "./admin";
import { numId } from "./actions";

/** Um evento recente da conta (vendas, ovos, boss, prey, coins...). */
export interface FeatureEvent {
  id: number;
  ts: number;
  kind: string;
  text: string;
}

export interface PreyOption {
  pokeId: number;
  nome: string;
}

export interface PreyCard {
  lista: number[] | null;
  pk: number | null;
  pkNome?: string | null;
  bonus: "dano" | "defesa" | "captura" | "spawn" | null;
  est: number | null;
  valor?: number | null;
  n: number[];
  opcoes: PreyOption[];
}

export interface BossInfo {
  key: string;
  name: string;
  level: number;
  minLevel: number;
  levelOk: boolean;
  entry: { itemId: number | null; qty: number; name?: string | null };
  have: number;
  entries: number;
}

export interface MarketRules {
  precoMinGold: number;
  precoMinOrb: number;
  taxaDiaria: number;
  diasMin: number;
  diasMax: number;
  taxaGoldPct: number;
}

export interface FeaturesView {
  account: string;
  online: boolean;
  gold: number;
  level: number;
  autoVendaDepot: boolean;
  autoPrey: boolean;
  prey: { dia: string; liberadas: number; cartelas: (PreyCard | null)[]; auto: boolean };
  boss: { auto: boolean; autoKey: string | null; bosses: BossInfo[] };
  bank: { min: number; feePct: number; levelMin: number; cooldownS: number };
  market: MarketRules;
  events: FeatureEvent[];
}

export interface Confirmed {
  ok: boolean;
  confirmed: boolean;
  error?: string;
}

export interface ConsolidateRow {
  account: string;
  id: number;
  nick: string | null;
  gold: number;
  level: number;
  amount: number;
  fee: number;
  net: number;
  /** ok (vai enviar) | skip | enviado | recusado | timeout | incerto | offline */
  status: string;
  detail: string;
}

export interface ConsolidateTotal {
  accounts: number;
  amount: number;
  fee: number;
  net: number;
}

export interface DestroyCandidate {
  id: number;
  nome: string | null;
  speciesId: number | null;
  level: number | null;
  nota: number | null;
  shiny: boolean;
  looktype: number | null;
  allowed: boolean;
  reason: string | null;
}

export interface DestroyResult extends Confirmed {
  sent: number[];
  blocked: { id: number; nome: string | null; reason: string }[];
}

export interface NewListing {
  tipo: "item" | "pokemon";
  itemId?: number;
  pokemonId?: number;
  qtd: number;
  preco: number;
  moeda: "gold" | "orb";
  dias?: number | null;
}

const acc = (accId: string) => `/api/accounts/${numId(accId)}`;

export const featuresApi = {
  view: (accId: string) => call<FeaturesView>("GET", `${acc(accId)}/features`),
  setAutoVenda: (accId: string, ativo: boolean) =>
    call<{ ok: boolean; autoVendaDepot: boolean }>("POST", `${acc(accId)}/features/auto-venda`, { ativo }),
  setAutoPrey: (accId: string, ativo: boolean) =>
    call<{ ok: boolean; autoPrey: boolean }>("POST", `${acc(accId)}/features/auto-prey`, { ativo }),
  preyRoll: (accId: string, cartela: number) => call<Confirmed>("POST", `${acc(accId)}/prey/roll`, { cartela }),
  preyChoose: (accId: string, cartela: number, pk: number) =>
    call<Confirmed>("POST", `${acc(accId)}/prey/choose`, { cartela, pk }),
  bossAuto: (accId: string, ativo: boolean, key: string) =>
    call<{ ok: boolean; auto: boolean; key: string }>("POST", `${acc(accId)}/boss/auto`, { ativo, key }),
  bossEnter: (accId: string, key: string) => call<{ ok: boolean }>("POST", `${acc(accId)}/boss/enter`, { key }),
  bossLeave: (accId: string) => call<{ ok: boolean }>("POST", `${acc(accId)}/boss/leave`),
  createListing: (accId: string, l: NewListing) =>
    call<Confirmed & { descricao?: string }>("POST", `${acc(accId)}/market/listings`, { ...l, confirm: true }),
  cancelListing: (accId: string, id: number) =>
    call<Confirmed>("POST", `${acc(accId)}/market/listings/${id}/cancel`, { confirm: true }),
  editListing: (accId: string, id: number, patch: { preco?: number; moeda?: "gold" | "orb"; dias?: number }) =>
    call<{ ok: boolean; error?: string }>("PATCH", `${acc(accId)}/market/listings/${id}`, { ...patch, confirm: true }),
  destroyCandidates: (accId: string) =>
    call<{ ok: boolean; protegidos: number; pokemons: DestroyCandidate[] }>("GET", `${acc(accId)}/destroy/candidates`),
  oferenda: (accId: string, pokemonIds: number[]) =>
    call<DestroyResult>("POST", `${acc(accId)}/oferenda`, { pokemonIds, confirm: true }),
  sacrificio: (accId: string, pokemonIds: number[]) =>
    call<DestroyResult>("POST", `${acc(accId)}/sacrificio`, { pokemonIds, confirm: true }),
  sacrificioResgatar: (accId: string) => call<Confirmed>("POST", `${acc(accId)}/sacrificio/resgatar`),
  consolidatePreview: (target: string, accounts: number[], reserve: number) =>
    call<{ ok: boolean; target: string; reserve: number; min: number; plan: ConsolidateRow[]; total: ConsolidateTotal }>(
      "POST",
      "/api/coins/consolidate/preview",
      { target, accounts, reserve },
    ),
  consolidate: (target: string, accounts: number[], reserve: number) =>
    call<{ ok: boolean; target: string; results: ConsolidateRow[]; total: ConsolidateTotal }>(
      "POST",
      "/api/coins/consolidate",
      { target, accounts, reserve, confirm: true },
    ),
};

export const PREY_BONUS_LABEL: Record<string, string> = {
  dano: "Dano",
  defesa: "Defensivo",
  captura: "Capture Boost",
  spawn: "Spawn",
};

/** Texto do valor do bônus como o jogo mostra (−% na defesa, +N no spawn). */
export function preyValueText(bonus: string | null, valor: number | null | undefined) {
  if (!bonus || valor == null) return "";
  if (bonus === "defesa") return `−${valor}%`;
  if (bonus === "spawn") return `+${valor}`;
  return `+${valor}%`;
}

/** Taxa do Banco: Math.ceil(valor × 15%), queimada. */
export const bankFee = (valor: number, pct = 15) => Math.ceil((valor * pct) / 100);
