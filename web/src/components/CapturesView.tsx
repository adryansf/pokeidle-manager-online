import { CheckCircle2, RefreshCw, Sparkles, Target, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PokemonSprite, ShinyMark } from "@/components/Sprites";
import { actions, type CaptureRow, type CapturesResponse } from "@/lib/actions";
import { useAccountIds, useAccountsMap } from "@/lib/telemetry";
import { fmtShort } from "@/lib/utils";

function fmtTime(ts: number) {
  const d = new Date(ts);
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const clock = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (diff < 60) return `${clock} (há ${diff}s)`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${clock} (há ${m}min)`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${clock} (há ${h}h)`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + clock;
}

const prettySlug = (s?: string | null) =>
  s ? s.replace(/[_-]+/g, " ").replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase()) : "";

/** `account` vem do filtro de conta do cabeçalho (aba Capturas); `fixedAccount` trava numa conta só. */
export function CapturesView({ fixedAccount, account: headerAccount, compact = false }: { fixedAccount?: string; account?: string; compact?: boolean }) {
  const ids = useAccountIds();
  const accounts = useAccountsMap();
  const [account, setAccount] = useState(fixedAccount ?? "all");
  const [onlyCaught, setOnlyCaught] = useState(false);
  const [onlyShiny, setOnlyShiny] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<CapturesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const effectiveAccount = fixedAccount ?? headerAccount ?? account;

  const load = useCallback(async () => {
    try {
      const res = await actions.captures({
        account: effectiveAccount,
        onlyCaught,
        onlyShiny,
        limit: compact ? 80 : 250,
      });
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar capturas");
    } finally {
      setLoading(false);
    }
  }, [effectiveAccount, onlyCaught, onlyShiny, compact]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.nick.toLowerCase().includes(q) ||
        (it.ballName ?? "").toLowerCase().includes(q) ||
        (it.huntSlug ?? "").toLowerCase().includes(q),
    );
  }, [data, query]);

  const st = data?.stats;

  return (
    <div className={compact ? "space-y-3" : "space-y-3 sm:space-y-4"}>
      {/* Resumo estatístico */}
      {st && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="tile p-2.5 sm:p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Capturados</div>
            <div className="tnum mt-0.5 text-xl font-extrabold text-poke-green sm:text-2xl">{fmtShort(st.caught)}</div>
            <div className="tnum text-[11px] text-mute">de {fmtShort(st.total)} tentativas</div>
          </div>
          <div className="tile p-2.5 sm:p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Taxa de sucesso</div>
            <div className="tnum mt-0.5 text-xl font-extrabold text-poke-gold sm:text-2xl">{st.rate.toFixed(1)}%</div>
            <div className="tnum text-[11px] text-mute">{fmtShort(st.failed)} escaparam</div>
          </div>
          <div className="tile p-2.5 sm:p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Shinies</div>
            <div className="tnum mt-0.5 text-xl font-extrabold text-poke-gold sm:text-2xl">
              ✨ {st.shinyCaught}
              <span className="text-sm font-semibold text-mute">/{st.shinySeen}</span>
            </div>
            <div className="text-[11px] text-mute">capturados / tentados</div>
          </div>
          <div className="tile p-2.5 sm:p-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Bolas usadas</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {st.byBall.length > 0 ? (
                st.byBall.map((b) => (
                  <span
                    key={b.ballId}
                    className="tnum rounded border border-line bg-void px-1.5 py-0.5 text-[11px] font-semibold"
                    title={`${b.ballName}: ${b.caught} capturas em ${b.used} lançamentos`}
                  >
                    {b.ballName}: <b>{fmtShort(b.used)}</b>
                  </span>
                ))
              ) : (
                <span className="text-xs text-mute">—</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className={`${compact ? "" : "card p-3 sm:p-4"} space-y-3`}>
        <div className="flex flex-wrap items-center gap-2">
          {!fixedAccount && headerAccount === undefined && (
            <select
              className="field text-sm"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              aria-label="Filtrar por conta"
            >
              <option value="all">Todas as contas</option>
              {ids.map((id) => (
                <option key={id} value={id}>
                  {accounts[id]?.nick ?? id}
                </option>
              ))}
            </select>
          )}
          <input
            className="field min-w-[160px] flex-1 text-sm"
            placeholder="Buscar Pokémon, bola ou hunt…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn text-xs sm:text-sm"
            data-active={onlyCaught}
            onClick={() => setOnlyCaught((v) => !v)}
          >
            <CheckCircle2 className="size-3.5" aria-hidden />
            Só capturados
          </button>
          <button
            type="button"
            className="btn text-xs sm:text-sm"
            data-active={onlyShiny}
            onClick={() => setOnlyShiny((v) => !v)}
          >
            <Sparkles className="size-3.5" aria-hidden />
            Só Shiny
          </button>
          <button type="button" className="btn text-xs sm:text-sm" onClick={() => void load()} title="Atualizar lista">
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-[#7a2f27] bg-[#32140f] px-3 py-2 text-xs font-semibold text-poke-red">
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-8 text-center text-sm text-mute">Carregando histórico de capturas…</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line py-10 text-center text-sm text-mute">
            <Target className="mb-2 size-6 opacity-60" aria-hidden />
            <p>Nenhuma captura registrada ainda para este filtro.</p>
            <p className="mt-1 text-xs">Cada lançamento de bola das suas contas fica salvo automaticamente aqui.</p>
          </div>
        ) : (
          <ul className={`space-y-1.5 ${compact ? "max-h-[45vh] overflow-y-auto pr-1" : ""}`}>
            {filtered.map((row: CaptureRow) => (
              <li
                key={row.id}
                className={`flex items-center justify-between gap-2.5 rounded-xl border px-3 py-2 ${
                  row.shiny
                    ? "border-poke-gold/70 bg-[#2a1f0b]/80"
                    : row.success
                      ? "border-[#2f6b3a]/60 bg-[#142719]/50"
                      : "border-line bg-tile/70"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-void">
                    <PokemonSprite looktype={row.looktype} species={row.pokeId} size={36} shiny={row.shiny} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 font-bold leading-tight">
                      <span className="truncate text-sm">{row.name}</span>
                      {row.shiny && <ShinyMark />}
                      {row.level != null && <span className="tnum text-xs font-medium text-mute">Nv.{row.level}</span>}
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                          row.success
                            ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
                            : "border-[#7a2f27] bg-[#32140f] text-poke-red"
                        }`}
                      >
                        {row.success ? <CheckCircle2 className="size-3" aria-hidden /> : <XCircle className="size-3" aria-hidden />}
                        {row.success ? "Capturado" : "Escapou"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-mute">
                      {!fixedAccount && <b className="text-fg">{row.nick}</b>}
                      {row.ballName && (
                        <span>
                          {row.ballName}
                          {row.chance != null ? ` (${row.chance}%)` : ""}
                        </span>
                      )}
                      {row.huntSlug && <span>· {prettySlug(row.huntSlug)}</span>}
                    </div>
                  </div>
                </div>
                <span className="tnum shrink-0 text-right text-[11px] text-mute">{fmtTime(row.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
