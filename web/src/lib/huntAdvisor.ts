import { useCallback, useEffect, useRef, useState } from "react";
import { actions, type PokemonSheet } from "./actions";

/**
 * "Melhor hunt" para o Pokémon equipado. O cálculo é o motor da calculadora de hunt do PokéIdle Guide
 * (https://pokeidleguide.io), que roda num worker (public/hunt-worker.js) carregando o código do site deles.
 * O Pokémon vem direto do estado do jogo (sem colar ficha) e nada dele sai do navegador.
 */
export type HuntOrder = "xp" | "xpTreinador" | "ouro" | "shiny" | "fragmento";
export type HuntSafety = "all" | "no_death" | "safe50";

export interface HuntSimOptions {
  comPocao?: boolean;
  aoe?: boolean;
  tipoDoDia?: string;
  escudo?: boolean;
  bola?: number | null;
}

export interface HuntBallInfo {
  id: number;
  nome: string;
  catchRate: number;
}

export interface HuntFragmentInfo {
  nivelMin: number;
  porOvo: number;
  horasChoca: number;
}

export interface HuntLine {
  slug: string;
  nome: string;
  regiao: string | null;
  nivel: number;
  liberada: boolean;
  inviavel: boolean;
  motivo?: string | null;
  xpPokemonH: number;
  xpTreinadorH: number;
  ouroH: number;
  kph: number;
  kphFaixa?: [number, number] | null;
  ttk?: number | null;
  mortesH: number;
  umHit: boolean;
  hitPct: number;
  ritmo?: string | null;
  mapa?: string | null;
  aoe?: { porGolpe?: number; estimado?: boolean } | null;
  melhorGolpe: { nome: string; tipo: string } | null;
  efetividade?: number;
  capturaChance?: number | null;
  capturasH?: number;
  shinyChance?: number | null;
  shinyH?: number;
  fragmentoChance?: number;
  fragmentoH?: number;
}

interface Result {
  versao: string | null;
  total: number;
  linhas: HuntLine[];
  bolas?: HuntBallInfo[];
  fragmento?: HuntFragmentInfo | null;
  captura?: { bola?: HuntBallInfo | null; chanceShiny?: number } | null;
}

export interface BestHunts {
  sheet: PokemonSheet;
  lines: HuntLine[];
  versao: string | null;
  bolas: HuntBallInfo[];
  fragmento: HuntFragmentInfo;
  captura: { bola?: HuntBallInfo | null; chanceShiny?: number } | null;
}

export const lineMetric = (l: HuntLine, o: HuntOrder): number => {
  switch (o) {
    case "ouro":
      return l.ouroH;
    case "xpTreinador":
      return l.xpTreinadorH;
    case "shiny":
      return l.shinyH ?? 0;
    case "fragmento":
      return l.fragmentoH ?? 0;
    default:
      return l.xpPokemonH;
  }
};

export function fmtTimeUntil(perHour: number): string {
  if (!(perHour > 0)) return "—";
  const h = 1 / perHour;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 100) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

export interface RankFilter {
  region?: string;
  safety?: HuntSafety;
  onlyOpen?: boolean;
}

/** As hunts viáveis filtradas por região/segurança/liberação, ordenadas pela métrica escolhida. */
export const rankLines = (lines: HuntLine[] | undefined, order: HuntOrder, filter?: RankFilter) => {
  const onlyOpen = filter?.onlyOpen ?? true;
  const safety = filter?.safety ?? "all";
  const region = filter?.region || "";
  return (lines ?? [])
    .filter((l) => {
      if (l.inviavel) return false;
      if (onlyOpen && !l.liberada) return false;
      if (region && l.regiao !== region) return false;
      if (safety === "no_death" && (l.umHit || l.mortesH >= 0.5)) return false;
      if (safety === "safe50" && (l.umHit || l.mortesH >= 0.5 || l.hitPct >= 0.5)) return false;
      return lineMetric(l, order) > 0;
    })
    .sort((a, b) => lineMetric(b, order) - lineMetric(a, order) || b.xpPokemonH - a.xpPokemonH || a.nivel - b.nivel);
};

// ----------------------------------------------------------------- worker
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (r: Result) => void; fail: (e: Error) => void }>();

function failAll(msg: string) {
  for (const w of waiting.values()) w.fail(new Error(msg));
  waiting.clear();
  worker?.terminate();
  worker = null;
}

function run(entrada: { sheet: PokemonSheet; nivelTreinador: number; opcoes?: HuntSimOptions }): Promise<Result> {
  if (!worker) {
    worker = new Worker(`${import.meta.env.BASE_URL}hunt-worker.js`, { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; dados?: Result; erro?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok && e.data.dados) w.ok(e.data.dados);
      else w.fail(new Error(e.data.erro ?? "Falha no cálculo"));
    };
    worker.onerror = () => failAll("Não consegui carregar a calculadora de hunt.");
  }
  const id = ++seq;
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail });
    worker?.postMessage({ id, entrada });
  });
}

// ----------------------------------------------------------------- hook
const cache = new Map<string, BestHunts>();
const keyOf = (s: PokemonSheet, op?: HuntSimOptions) =>
  [
    s.speciesId,
    s.level,
    s.potencia,
    s.quality,
    s.shiny,
    s.trainerLevel,
    Object.values(s.stats).join("-"),
    Object.values(s.refino ?? {}).join("-"),
    op?.comPocao ?? s.comPocao ?? true,
    op?.aoe ?? s.tmAoe,
    op?.tipoDoDia !== undefined ? op.tipoDoDia : (s.tipoDoDia ?? ""),
    op?.escudo ?? s.escudo ?? false,
    op?.bola ?? s.ballId ?? "",
  ].join("|");

const RECALC_MS = 45_000; // subir de nível muda os stats: recalcula, mas sem exagero

/** `trigger` muda quando o Pokémon equipado ou o nível da conta muda; `enabled` só com a conta online. */
export function useBestHunts(
  accId: string | null,
  trigger: string,
  enabled: boolean,
  opcoes?: HuntSimOptions,
) {
  const [data, setData] = useState<BestHunts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const last = useRef({ acc: "", optKey: "", at: 0 });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const optKey = JSON.stringify(opcoes ?? {});

  useEffect(() => {
    if (!accId || !enabled) return;
    let alive = true;
    const switched = last.current.acc !== accId;
    const optChanged = last.current.optKey !== optKey;
    if (switched) setData(null);
    const wait = switched || optChanged || !last.current.at ? 250 : Math.max(250, last.current.at + RECALC_MS - Date.now());
    const t = setTimeout(async () => {
      try {
        const sheet = await actions.sheet(accId);
        const key = keyOf(sheet, opcoes);
        const hit = cache.get(key);
        if (hit) {
          if (alive) (setData(hit), setError(null));
          return;
        }
        if (alive) setLoading(true);
        const r = await run({ sheet, nivelTreinador: sheet.trainerLevel, opcoes });
        const out: BestHunts = {
          sheet,
          lines: r.linhas,
          versao: r.versao,
          bolas: r.bolas ?? [],
          fragmento: r.fragmento ?? { nivelMin: 5000, porOvo: 10, horasChoca: 48 },
          captura: r.captura ?? null,
        };
        cache.set(key, out);
        if (cache.size > 20) cache.delete(cache.keys().next().value as string);
        last.current = { acc: accId, optKey, at: Date.now() };
        if (alive) (setData(out), setError(null));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Erro inesperado");
      } finally {
        if (alive) setLoading(false);
      }
    }, wait);
    last.current.acc = accId;
    last.current.optKey = optKey;
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accId, trigger, enabled, nonce, optKey]);

  return { data, error, loading, reload };
}

/** Calcula a melhor hunt #1 usando o mesmo simulador do Mapa (hunt-worker.js) para sincronizar com o Auto-Hunt. */
export async function computeBestHuntSlug(
  accId: string,
  priority: HuntOrder = "xp",
  region: string = "all",
): Promise<{ slug: string; nome: string } | null> {
  const sheet = await actions.sheet(accId);
  const key = keyOf(sheet);
  let out = cache.get(key);
  if (!out) {
    const r = await run({ sheet, nivelTreinador: sheet.trainerLevel });
    out = {
      sheet,
      lines: r.linhas,
      versao: r.versao,
      bolas: r.bolas ?? [],
      fragmento: r.fragmento ?? { nivelMin: 5000, porOvo: 10, horasChoca: 48 },
      captura: r.captura ?? null,
    };
    cache.set(key, out);
    if (cache.size > 20) cache.delete(cache.keys().next().value as string);
  }
  const reg = region && region !== "all" ? region : "";
  const safe = rankLines(out.lines, priority, { region: reg, safety: "no_death", onlyOpen: true });
  const ranked = safe.length > 0 ? safe : rankLines(out.lines, priority, { region: reg, safety: "all", onlyOpen: true });
  const top = ranked[0];
  return top ? { slug: top.slug, nome: top.nome } : null;
}
