import { ArrowRight, Check, Loader2, Shield, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { HuntRow, type HuntCalc } from "@/components/HuntRow";
import { PokemonSprite } from "@/components/Sprites";
import type { Creature, Hunt } from "@/lib/actions";
import {
  type BestHunts,
  type HuntLine,
  type HuntOrder,
  type HuntSafety,
  type HuntSimOptions,
  fmtTimeUntil,
  lineMetric,
  rankLines,
} from "@/lib/huntAdvisor";
import { fmtInt, fmtShort } from "@/lib/utils";

const ORDERS: { id: HuntOrder; label: string; unit: string }[] = [
  { id: "xp", label: "XP/h (Pk)", unit: "XP/h" },
  { id: "xpTreinador", label: "XP/h (Trein.)", unit: "XP/h" },
  { id: "ouro", label: "Ouro/h", unit: "ouro/h" },
  { id: "shiny", label: "Shiny/h", unit: "p/ Shiny" },
  { id: "fragmento", label: "Fragmento/h", unit: "p/ Frag." },
];

const SAFETY_OPTS: { id: HuntSafety; label: string; title: string }[] = [
  { id: "all", label: "Qualquer risco", title: "Mostra todas as hunts viáveis, incluindo as com risco de morte" },
  { id: "no_death", label: "Sem mortes", title: "Oculta hunts onde o Pokémon pode levar 1-hit ou morrer com frequência" },
  { id: "safe50", label: "Ultra-seguras (<50% HP)", title: "Só hunts onde o pior golpe do selvagem tira menos de 50% do HP" },
];

const REGION_ORDER: { id: string; label: string }[] = [
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

const SEASONAL_TYPES = [
  "NORMAL", "FIRE", "WATER", "GRASS", "ELECTRIC", "ICE", "FIGHTING", "POISON", "GROUND",
  "FLYING", "PSYCHIC", "BUG", "ROCK", "GHOST", "DRAGON", "DARK", "STEEL", "FAIRY",
];

const SHOWN = 5;
const MAX = 15;
const HUB = "https://pokeidleguide.io/#hunt";

const per = (n: number) => fmtShort(Math.round(n));
const fmtSec = (s?: number | null) => (s != null && Number.isFinite(s) ? `${s.toFixed(1).replace(".", ",")}s` : null);
const fmtChipVal = (l: HuntLine, o: HuntOrder) =>
  o === "shiny" || o === "fragmento" ? fmtTimeUntil(lineMetric(l, o)) : per(lineMetric(l, o));

function calcOf(l: HuntLine, rank: number, order: HuntOrder, porOvo: number): HuntCalc {
  const approx = l.ritmo && l.ritmo !== "jogo" ? "≈" : "";
  const killsTxt = `${approx}${fmtInt(Math.round(l.kph))} abates/h`;
  const ttkTxt = fmtSec(l.ttk);
  const moveTxt = l.melhorGolpe
    ? `${l.melhorGolpe.nome}${l.efetividade && l.efetividade !== 1 ? ` ×${l.efetividade.toFixed(1).replace(".", ",")}` : ""}`
    : null;

  let main: string;
  let unit: string;
  let extra: string;

  if (order === "shiny") {
    main = fmtTimeUntil(l.shinyH ?? 0);
    unit = "até Shiny";
    extra = `${(l.capturasH ?? 0).toFixed(1).replace(".", ",")} cap/h · XP ${per(l.xpPokemonH)}/h`;
  } else if (order === "fragmento") {
    main = fmtTimeUntil(l.fragmentoH ?? 0);
    unit = "até Frag.";
    const ovo = fmtTimeUntil((l.fragmentoH ?? 0) / Math.max(1, porOvo));
    extra = `Ovo: ${ovo} · XP ${per(l.xpPokemonH)}/h`;
  } else if (order === "ouro") {
    main = per(l.ouroH);
    unit = "ouro/h";
    extra = `XP ${per(l.xpPokemonH)}/h`;
  } else if (order === "xpTreinador") {
    main = per(l.xpTreinadorH);
    unit = "XP trein./h";
    extra = `Ouro ${per(l.ouroH)}/h`;
  } else {
    main = per(l.xpPokemonH);
    unit = "XP pk/h";
    extra = `Ouro ${per(l.ouroH)}/h`;
  }

  const subParts = [killsTxt, ttkTxt ? `mata em ${ttkTxt}` : null, moveTxt, extra].filter(Boolean);
  return {
    rank,
    main,
    unit,
    sub: subParts.join(" · "),
    risk: l.umHit ? "one" : l.mortesH,
    hitPct: l.hitPct,
  };
}

/** Melhor hunt para o Pokémon equipado agora (motor completo do PokéIdle Guide), com prioridades, regiões e filtros. */
export function BestHuntCard({
  nick, order, onOrder, simOptions, onSimOptions, best, loading, error, onRetry, online, level, hunts, creatures,
  currentSlug, pendingSlug, focusSlug, busy, canHunt, onFocus, onHunt,
}: {
  nick: string;
  order: HuntOrder;
  onOrder: (o: HuntOrder) => void;
  simOptions: HuntSimOptions;
  onSimOptions: (patch: Partial<HuntSimOptions>) => void;
  best: BestHunts | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  online: boolean;
  level: number;
  hunts: Hunt[];
  creatures: Record<string, Creature> | null;
  currentSlug: string | null;
  pendingSlug: string | null;
  focusSlug: string | null;
  busy: boolean;
  canHunt: boolean;
  onFocus: (slug: string) => void;
  onHunt: (h: Hunt) => void;
}) {
  const [more, setMore] = useState(false);
  const [regionFilter, setRegionFilter] = useState("");
  const [safety, setSafety] = useState<HuntSafety>("no_death");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [optsOpen, setOptsOpen] = useState(false);

  const bySlug = useMemo(() => new Map(hunts.map((h) => [h.slug, h])), [hunts]);
  const sheet = best?.sheet;
  const fragMin = best?.fragmento?.nivelMin ?? 5000;
  const fragUnlocked = level >= fragMin || !onlyOpen;
  const activeOrder: HuntOrder = order === "fragmento" && !fragUnlocked ? "xp" : order;

  // Todas as hunts viáveis (sem filtro de região) para montar os chips de região com o melhor valor de cada uma.
  const allRanked = useMemo(
    () => rankLines(best?.lines, activeOrder, { safety, onlyOpen }).filter((l) => bySlug.has(l.slug)),
    [best, activeOrder, safety, onlyOpen, bySlug],
  );
  const regionTops = useMemo(() => {
    const map = new Map<string, HuntLine>();
    for (const l of allRanked) {
      if (l.regiao && !map.has(l.regiao)) map.set(l.regiao, l);
    }
    return map;
  }, [allRanked]);
  const activeRegion = regionFilter && regionTops.has(regionFilter) ? regionFilter : "";
  const ranked = useMemo(
    () => (activeRegion ? allRanked.filter((l) => l.regiao === activeRegion) : allRanked),
    [allRanked, activeRegion],
  );
  const shown = ranked.slice(0, more ? MAX : SHOWN);
  const cur = best?.lines.find((l) => l.slug === currentSlug);
  const top = ranked[0];
  const curMetric = cur ? lineMetric(cur, activeOrder) : 0;
  const gain = top && curMetric > 0 && top.slug !== cur?.slug ? lineMetric(top, activeOrder) / curMetric - 1 : 0;
  const orderInfo = ORDERS.find((o) => o.id === activeOrder) ?? ORDERS[0];

  const effectiveDia = simOptions.tipoDoDia !== undefined ? simOptions.tipoDoDia : (sheet?.tipoDoDia ?? "");
  const effectiveEscudo = simOptions.escudo !== undefined ? simOptions.escudo : Boolean(sheet?.escudo);
  const effectivePocao = simOptions.comPocao !== undefined ? simOptions.comPocao : (sheet?.comPocao ?? true);
  const effectiveAoe = simOptions.aoe !== undefined ? simOptions.aoe : Boolean(sheet?.tmAoe);
  const effectiveBola = simOptions.bola ?? sheet?.ballId ?? best?.captura?.bola?.id ?? null;

  return (
    <section className="card space-y-2.5 p-3" aria-labelledby="best-hunt">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-edge/70" style={{ background: "radial-gradient(circle at 50% 35%, #4a3519, #1a120a 75%)" }}>
          {sheet ? <PokemonSprite looktype={sheet.looktype} size={40} /> : <Loader2 className="size-5 animate-spin text-mute motion-reduce:animate-none" aria-hidden />}
        </span>
        <div className="min-w-[11rem] flex-1">
          <h2 id="best-hunt" className="font-extrabold leading-tight">
            Melhor hunt para {sheet ? sheet.nome : "o Pokémon equipado"}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-mute">
            <span>{sheet ? `Nv ${fmtInt(sheet.level)} · conta ${nick}` : `Conta ${nick}`}</span>
            {effectiveDia && (
              <span className="rounded border border-[#7a5a1c] bg-[#33260e] px-1.5 py-0.5 text-[10px] font-bold text-poke-gold">
                Dia {effectiveDia}{effectiveEscudo ? " (Shield)" : ""}
              </span>
            )}
            {effectiveAoe && (
              <span className="rounded border border-edge/60 bg-tile px-1.5 py-0.5 text-[10px] font-bold text-fg">
                AoE
              </span>
            )}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto" role="group" aria-label="Priorizar por">
          {ORDERS.filter((o) => o.id !== "fragmento" || fragUnlocked).map((o) => (
            <button
              key={o.id}
              type="button"
              className="btn flex-1 px-2.5 py-1 text-xs sm:flex-none"
              data-active={activeOrder === o.id}
              aria-pressed={activeOrder === o.id}
              onClick={() => onOrder(o.id)}
            >
              {o.label}
            </button>
          ))}
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            data-active={optsOpen}
            aria-expanded={optsOpen}
            title="Configurar parâmetros do simulador (poção, AoE, tipo do dia, bola, hunts trancadas)"
            onClick={() => setOptsOpen((v) => !v)}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Simulador</span>
          </button>
        </div>
      </header>

      {/* Barra de filtros de segurança + controles avançados do simulador */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-mute">
          <Shield className="size-3.5 text-poke-green" aria-hidden /> Risco:
        </span>
        {SAFETY_OPTS.map((s) => (
          <button
            key={s.id}
            type="button"
            title={s.title}
            onClick={() => setSafety(s.id)}
            className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${
              safety === s.id
                ? "border-poke-gold bg-[#33260e] text-poke-gold"
                : "border-line bg-tile text-mute hover:text-fg"
            }`}
          >
            {s.label}
          </button>
        ))}

        {activeOrder === "shiny" && (best?.bolas?.length ?? 0) > 0 && (
          <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-mute">
            Bola:
            <select
              className="field py-0.5 text-xs"
              value={effectiveBola ?? ""}
              onChange={(e) => onSimOptions({ bola: e.target.value ? Number(e.target.value) : null })}
            >
              {best!.bolas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nome}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {optsOpen && (
        <div className="tile grid gap-2.5 p-2.5 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex cursor-pointer items-center gap-2 font-semibold">
            <input
              type="checkbox"
              className="size-4 accent-[#f3c04a]"
              checked={onlyOpen}
              onChange={(e) => setOnlyOpen(e.target.checked)}
            />
            Só hunts liberadas
          </label>
          <label className="flex cursor-pointer items-center gap-2 font-semibold" title="Simular considerando uso de poção automática">
            <input
              type="checkbox"
              className="size-4 accent-[#f3c04a]"
              checked={effectivePocao}
              onChange={(e) => onSimOptions({ comPocao: e.target.checked })}
            />
            Com poção automática
          </label>
          <label className="flex cursor-pointer items-center gap-2 font-semibold" title="Disco de AoE (estimativa ≈): acerta múltiplos alvos no 11×11">
            <input
              type="checkbox"
              className="size-4 accent-[#f3c04a]"
              checked={effectiveAoe}
              onChange={(e) => onSimOptions({ aoe: e.target.checked })}
            />
            Simular com AoE (≈)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 font-semibold">
              <span className="text-mute">Dia:</span>
              <select
                className="field py-0.5 text-xs"
                value={effectiveDia}
                onChange={(e) => onSimOptions({ tipoDoDia: e.target.value })}
              >
                <option value="">Nenhum</option>
                {SEASONAL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {effectiveDia && (
              <label className="flex cursor-pointer items-center gap-1.5 font-semibold" title="Shield do Novato (selvagens do tipo do dia não ganham 2×)">
                <input
                  type="checkbox"
                  className="size-3.5 accent-[#f3c04a]"
                  checked={effectiveEscudo}
                  onChange={(e) => onSimOptions({ escudo: e.target.checked })}
                />
                Shield
              </label>
            )}
          </div>
        </div>
      )}

      {!online ? (
        <p className="tile px-3 py-3 text-sm text-mute">Conecte a conta para calcular a melhor hunt do Pokémon equipado.</p>
      ) : error && !best ? (
        <div className="tile flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
          <p className="text-poke-red">{error}</p>
          <button type="button" className="btn" onClick={onRetry}>
            Tentar de novo
          </button>
        </div>
      ) : !best ? (
        <p className="tile flex items-center gap-2 px-3 py-3 text-sm text-mute" role="status">
          <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> Calculando as hunts no motor do PokéIdle Guide…
        </p>
      ) : allRanked.length === 0 ? (
        <p className="tile px-3 py-3 text-sm text-mute">
          Nenhuma hunt encontrada com esse filtro de segurança. Tente mudar o risco para{" "}
          <button type="button" className="font-bold text-poke-gold underline" onClick={() => setSafety("all")}>
            Qualquer risco
          </button>
          .
        </p>
      ) : (
        <>
          {/* Categorização por Região com o melhor valor de cada aba (igual ao PokéIdle Guide) */}
          <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Filtrar por região">
            <button
              type="button"
              onClick={() => setRegionFilter("")}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold transition-colors ${
                activeRegion === ""
                  ? "border-poke-gold bg-[#33260e] text-poke-gold"
                  : "border-line bg-tile text-mute hover:text-fg"
              }`}
            >
              Todas
              {allRanked[0] && (
                <span className="tnum text-[10px] opacity-85">{fmtChipVal(allRanked[0], activeOrder)}</span>
              )}
            </button>
            {REGION_ORDER.filter((r) => regionTops.has(r.id)).map((r) => {
              const bestReg = regionTops.get(r.id)!;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRegionFilter(r.id)}
                  title={`Melhor em ${r.label}: ${bestReg.nome}`}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold transition-colors ${
                    activeRegion === r.id
                      ? "border-poke-gold bg-[#33260e] text-poke-gold"
                      : "border-line bg-tile text-mute hover:text-fg"
                  }`}
                >
                  {r.label}
                  <span className="tnum text-[10px] opacity-85">{fmtChipVal(bestReg, activeOrder)}</span>
                </button>
              );
            })}
          </div>

          {cur && top && (
            <p className={`tile flex flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 text-xs ${gain < 0.05 && !cur.umHit && cur.mortesH < 0.5 ? "!border-poke-green/50 text-poke-green" : "text-mute"}`} aria-live="polite">
              {cur.umHit || cur.mortesH >= 0.5 ? (
                <>
                  <b className="text-poke-red">⚠ Hunt atual ({cur.nome}) tem risco alto!</b>
                  <ArrowRight className="size-3.5 shrink-0" aria-hidden /> Recomendado trocar para{" "}
                  <b className="text-fg">{top.nome}</b> ({fmtChipVal(top, activeOrder)} {orderInfo.unit})
                </>
              ) : gain < 0.05 ? (
                <>
                  <Check className="size-3.5 shrink-0" aria-hidden /> <b>Você já caça numa das melhores hunts</b>
                </>
              ) : (
                <>
                  Hoje em <b className="text-fg">{cur.nome}</b>:{" "}
                  <b className="tnum text-fg">{fmtChipVal(cur, activeOrder)}</b> {orderInfo.unit}
                  <ArrowRight className="size-3.5 shrink-0" aria-hidden /> em <b className="text-fg">{top.nome}</b> rende{" "}
                  <b className="tnum text-poke-green">+{fmtInt(Math.round(gain * 100))}%</b>
                </>
              )}
            </p>
          )}

          <div className="space-y-1.5">
            {shown.map((l, i) => {
              const h = bySlug.get(l.slug)!;
              return (
                <HuntRow
                  key={l.slug}
                  h={h}
                  creatures={creatures}
                  level={level}
                  current={l.slug === currentSlug}
                  queued={l.slug === pendingSlug}
                  focused={l.slug === focusSlug}
                  canHunt={canHunt}
                  busy={busy}
                  calc={calcOf(l, i + 1, activeOrder, best.fragmento.porOvo)}
                  onFocus={onFocus}
                  onHunt={onHunt}
                />
              );
            })}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {ranked.length > SHOWN ? (
              <button type="button" className="text-xs font-semibold text-poke-gold hover:underline" onClick={() => setMore((v) => !v)}>
                {more ? "Mostrar menos" : `Mostrar mais ${Math.min(MAX, ranked.length) - SHOWN} (de ${ranked.length})`}
              </button>
            ) : (
              <span />
            )}
            <p className="flex items-center gap-1.5 text-[11px] text-mute">
              {loading && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-label="Recalculando" />}
              Motor do{" "}
              <a className="underline hover:text-fg" href={HUB} target="_blank" rel="noopener noreferrer">
                PokéIdle Guide
              </a>
              {best.versao ? ` (jogo ${best.versao})` : ""} · sem bônus de VIP ou boosts
            </p>
          </footer>
        </>
      )}
    </section>
  );
}
