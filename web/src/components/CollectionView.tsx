import { BookmarkCheck, Check, Filter, Loader2, Lock, LockOpen, Search, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PokemonSprite, ShinyMark } from "@/components/Sprites";
import { actions } from "@/lib/actions";
import { usePokemons } from "@/lib/api";
import { accountNumber, useSheet } from "@/lib/sheet";
import { useAccountIds, useAccountsMap } from "@/lib/telemetry";
import type { AutoColecaoRule, PokemonRow } from "@/lib/types";
import { fmtInt, fmtShort } from "@/lib/utils";

type LocalFilter = "colecao" | "depot" | "equipe" | "todos";
type SortKey = "grade" | "quality" | "potency" | "level" | "ivTotal" | "recent";

const IV_STATS: { key: "hp" | "atk" | "def" | "spAtk" | "spDef" | "speed"; label: string }[] = [
  { key: "hp", label: "HP" },
  { key: "atk", label: "Atk" },
  { key: "def", label: "Def" },
  { key: "spAtk", label: "SpA" },
  { key: "spDef", label: "SpD" },
  { key: "speed", label: "Spe" },
];

const POT_OPTIONS = [2, 3, 4, 5] as const;
const QUAL_OPTIONS = [1.1, 1.3, 1.5, 1.6] as const;

const DEFAULT_RULE: AutoColecaoRule = {
  lendario: { on: true },
  shiny: { on: true },
  pot: { on: true, min: 4 },
  qual: { on: false, min: 1.5 },
  iv: { on: false, min: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, speed: 1 } },
  nota: { on: false, min: 3.5 },
  potencial: { on: false },
};

function cloneRule(r?: AutoColecaoRule | null): AutoColecaoRule {
  const base = r ?? DEFAULT_RULE;
  return {
    lendario: { on: Boolean(base.lendario?.on) },
    shiny: { on: Boolean(base.shiny?.on) },
    pot: { on: Boolean(base.pot?.on), min: Number(base.pot?.min ?? 4) },
    qual: { on: Boolean(base.qual?.on), min: Number(base.qual?.min ?? 1.5) },
    iv: {
      on: Boolean(base.iv?.on),
      min: {
        hp: Math.max(1, Math.min(32, Number(base.iv?.min?.hp ?? 1))),
        atk: Math.max(1, Math.min(32, Number(base.iv?.min?.atk ?? 1))),
        def: Math.max(1, Math.min(32, Number(base.iv?.min?.def ?? 1))),
        spAtk: Math.max(1, Math.min(32, Number(base.iv?.min?.spAtk ?? 1))),
        spDef: Math.max(1, Math.min(32, Number(base.iv?.min?.spDef ?? 1))),
        speed: Math.max(1, Math.min(32, Number(base.iv?.min?.speed ?? 1))),
      },
    },
    nota: { on: Boolean(base.nota?.on), min: Number(base.nota?.min ?? 3.5) },
    potencial: { on: Boolean(base.potencial?.on) },
  };
}

function localOf(p: PokemonRow): "equipe" | "colecao" | "depot" {
  if (p.slot != null) return "equipe";
  return p.inCollection ? "colecao" : "depot";
}

function RuleToggle({
  label,
  hint,
  on,
  onToggle,
  children,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-3 transition-colors ${
        on ? "border-edge bg-[#261c0e]/75" : "border-line bg-tile/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-extrabold text-fg sm:text-sm">{label}</div>
          {hint && <div className="text-[11px] text-mute">{hint}</div>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={onToggle}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
            on
              ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
              : "border-line bg-void text-mute hover:border-edge hover:text-fg"
          }`}
        >
          <span className={`size-2 rounded-full ${on ? "bg-poke-green" : "bg-mute/50"}`} />
          {on ? "Ativo" : "Desligado"}
        </button>
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}

export function CollectionView({ account }: { account: string }) {
  const ids = useAccountIds();
  const accounts = useAccountsMap();
  const openSheet = useSheet();

  const [refreshNonce, setRefreshNonce] = useState(0);
  const { rows, error } = usePokemons(account, refreshNonce);

  // Conta alvo para editar as regras do Auto-Coleção (se estiver em "all", usa a 1ª online ou 1ª da lista).
  const [ruleAccId, setRuleAccId] = useState<string>("");
  const effectiveRuleAccId = useMemo(() => {
    if (account !== "all" && accounts[account]) return account;
    if (ruleAccId && accounts[ruleAccId]) return ruleAccId;
    return ids.find((i) => accounts[i]?.status === "online") ?? ids[0] ?? "";
  }, [account, ruleAccId, accounts, ids]);

  const ruleAcc = effectiveRuleAccId ? accounts[effectiveRuleAccId] : undefined;
  const serverRuleJson = JSON.stringify(ruleAcc?.automation?.autoColecao ?? null);

  const [draft, setDraft] = useState<AutoColecaoRule>(() => cloneRule(ruleAcc?.automation?.autoColecao));
  const [savingRule, setSavingRule] = useState<false | "one" | "all">(false);
  const [ruleMsg, setRuleMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(true);

  useEffect(() => {
    setDraft(cloneRule(ruleAcc?.automation?.autoColecao));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRuleAccId, serverRuleJson]);

  // Filtros da lista de Pokémons
  const [localFilter, setLocalFilter] = useState<LocalFilter>("colecao");
  const [search, setSearch] = useState("");
  const [onlyShiny, setOnlyShiny] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("grade");
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(80);

  const counts = useMemo(() => {
    const c = { colecao: 0, depot: 0, equipe: 0, todos: 0 };
    for (const p of rows ?? []) {
      c.todos += 1;
      c[localOf(p)] += 1;
    }
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (rows ?? []).filter((p) => {
      if (localFilter !== "todos" && localOf(p) !== localFilter) return false;
      if (onlyShiny && !p.shiny) return false;
      if (q && !(p.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) => {
      switch (sortBy) {
        case "quality":
          return (b.quality ?? 0) - (a.quality ?? 0) || (b.grade ?? 0) - (a.grade ?? 0);
        case "potency":
          return (b.potency ?? 0) - (a.potency ?? 0) || (b.grade ?? 0) - (a.grade ?? 0);
        case "level":
          return (b.level ?? 0) - (a.level ?? 0) || (b.grade ?? 0) - (a.grade ?? 0);
        case "ivTotal":
          return (b.ivTotal ?? 0) - (a.ivTotal ?? 0) || (b.grade ?? 0) - (a.grade ?? 0);
        case "recent":
          return (b.caughtAt ?? 0) - (a.caughtAt ?? 0);
        default:
          return (b.grade ?? 0) - (a.grade ?? 0) || (b.quality ?? 0) - (a.quality ?? 0);
      }
    });
    return list;
  }, [rows, localFilter, search, onlyShiny, sortBy]);

  const saveRule = async (allOnline: boolean) => {
    setSavingRule(allOnline ? "all" : "one");
    setRuleMsg(null);
    try {
      if (allOnline) {
        const targets = ids.filter((i) => accounts[i]?.status === "online");
        if (targets.length === 0) throw new Error("Nenhuma conta online para aplicar.");
        await Promise.all(targets.map((i) => actions.setAutoColecao(i, draft)));
        setRuleMsg({ tone: "ok", text: `Auto-Coleção salvo e aplicado em ${targets.length} conta(s) online!` });
      } else {
        if (!effectiveRuleAccId) throw new Error("Selecione uma conta.");
        await actions.setAutoColecao(effectiveRuleAccId, draft);
        setRuleMsg({ tone: "ok", text: `Auto-Coleção salvo em ${ruleAcc?.nick ?? effectiveRuleAccId}!` });
      }
      setTimeout(() => setRefreshNonce((n) => n + 1), 900);
    } catch (e) {
      setRuleMsg({ tone: "err", text: e instanceof Error ? e.message : "Erro ao salvar Auto-Coleção." });
    } finally {
      setSavingRule(false);
    }
  };

  const toggleCollection = async (p: PokemonRow) => {
    const key = `${p.account}:${p.id}`;
    if (movingKey) return;
    const to = p.inCollection ? "depot" : "colecao";
    setMovingKey(key);
    try {
      await actions.moveCollection(p.account, p.id, to);
      setRefreshNonce((n) => n + 1);
    } catch {
      /* erro tratado no próximo refresh */
    } finally {
      setMovingKey(null);
    }
  };

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Resumo */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => setLocalFilter("colecao")}
          className={`card flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
            localFilter === "colecao" ? "!border-poke-gold bg-[#2a1f0b]/60" : "hover:border-edge"
          }`}
        >
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Na Coleção</div>
            <div className="tnum text-xl font-black text-poke-gold sm:text-2xl">{fmtInt(counts.colecao)}</div>
          </div>
          <BookmarkCheck className="size-6 text-poke-gold opacity-80" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setLocalFilter("depot")}
          className={`card flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
            localFilter === "depot" ? "!border-poke-gold bg-[#2a1f0b]/60" : "hover:border-edge"
          }`}
        >
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">No Depot</div>
            <div className="tnum text-xl font-black text-fg sm:text-2xl">{fmtInt(counts.depot)}</div>
          </div>
          <LockOpen className="size-6 text-mute opacity-80" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setLocalFilter("equipe")}
          className={`card flex items-center justify-between px-3 py-2.5 text-left transition-colors ${
            localFilter === "equipe" ? "!border-poke-gold bg-[#2a1f0b]/60" : "hover:border-edge"
          }`}
        >
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-mute">Na Equipe</div>
            <div className="tnum text-xl font-black text-poke-green sm:text-2xl">{fmtInt(counts.equipe)}</div>
          </div>
          <Star className="size-6 text-poke-green opacity-80" aria-hidden />
        </button>
      </div>

      {/* Painel de Critérios do Auto-Coleção */}
      <section className="card p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Filter className="size-4 text-poke-gold" aria-hidden />
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-fg sm:text-base">
                Critérios do Auto-Coleção
              </h2>
              <p className="text-xs text-mute">
                Pokémons capturados que atenderem a qualquer critério ativo vão direto para a Coleção (protegidos de venda).
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {account === "all" && ids.length > 0 && (
              <select
                className="field text-xs sm:text-sm"
                value={effectiveRuleAccId}
                onChange={(e) => setRuleAccId(e.target.value)}
                aria-label="Conta para configurar Auto-Coleção"
              >
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {accounts[id]?.nick ?? id} {accounts[id]?.status === "online" ? "" : "(offline)"}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setRulesOpen((v) => !v)}
              className="btn px-2.5 text-xs font-bold"
            >
              {rulesOpen ? "Ocultar" : "Configurar"}
            </button>
          </div>
        </div>

        {rulesOpen && (
          <div className="mt-3 space-y-3 border-t border-line pt-3">
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              <RuleToggle
                label="Lendário / Mítico"
                hint="Guarda automaticamente lendários e míticos"
                on={draft.lendario.on}
                onToggle={() => setDraft((d) => ({ ...d, lendario: { on: !d.lendario.on } }))}
              />

              <RuleToggle
                label="Shiny"
                hint="Guarda automaticamente qualquer Pokémon Shiny"
                on={draft.shiny.on}
                onToggle={() => setDraft((d) => ({ ...d, shiny: { on: !d.shiny.on } }))}
              />

              <RuleToggle
                label="Potencial"
                hint="Guarda Pokémons marcados com potencial alto"
                on={draft.potencial.on}
                onToggle={() => setDraft((d) => ({ ...d, potencial: { on: !d.potencial.on } }))}
              />

              <RuleToggle
                label="Potência mínima"
                hint="Guarda se potência ≥ escolhida"
                on={draft.pot.on}
                onToggle={() => setDraft((d) => ({ ...d, pot: { ...d.pot, on: !d.pot.on } }))}
              >
                <div className="flex gap-1.5">
                  {POT_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, pot: { on: true, min: p } }))}
                      className={`flex-1 rounded-lg border py-1 text-xs font-extrabold transition-colors ${
                        draft.pot.min === p
                          ? "border-poke-gold bg-poke-gold text-void"
                          : "border-line bg-void text-mute hover:border-edge hover:text-fg"
                      }`}
                    >
                      P{p}
                    </button>
                  ))}
                </div>
              </RuleToggle>

              <RuleToggle
                label="Qualidade mínima"
                hint="Guarda se qualidade ≥ escolhida"
                on={draft.qual.on}
                onToggle={() => setDraft((d) => ({ ...d, qual: { ...d.qual, on: !d.qual.on } }))}
              >
                <div className="flex gap-1.5">
                  {QUAL_OPTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, qual: { on: true, min: q } }))}
                      className={`tnum flex-1 rounded-lg border py-1 text-xs font-extrabold transition-colors ${
                        Math.abs(draft.qual.min - q) < 0.01
                          ? "border-poke-gold bg-poke-gold text-void"
                          : "border-line bg-void text-mute hover:border-edge hover:text-fg"
                      }`}
                    >
                      {q.toFixed(1)}
                    </button>
                  ))}
                </div>
              </RuleToggle>

              <RuleToggle
                label="Nota mínima"
                hint="Guarda se nota geral ≥ valor (0 a 10)"
                on={draft.nota.on}
                onToggle={() => setDraft((d) => ({ ...d, nota: { ...d.nota, on: !d.nota.on } }))}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={0.5}
                    value={draft.nota.min}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(10, Number(e.target.value) || 0));
                      setDraft((d) => ({ ...d, nota: { ...d.nota, min: v } }));
                    }}
                    className="field tnum w-24 text-sm font-bold"
                  />
                  <span className="text-xs text-mute">Nota ≥ {draft.nota.min.toFixed(1)}</span>
                </div>
              </RuleToggle>
            </div>

            {/* IV mínimo por atributo */}
            <RuleToggle
              label="IV mínimo por atributo"
              hint="Só guarda se TODOS os atributos atingirem o piso definido (1 a 32; 1 = ignora o atributo)"
              on={draft.iv.on}
              onToggle={() => setDraft((d) => ({ ...d, iv: { ...d.iv, on: !d.iv.on } }))}
            >
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {IV_STATS.map(({ key, label }) => (
                  <label key={key} className="block space-y-1">
                    <span className="text-[11px] font-bold uppercase text-mute">{label}</span>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={draft.iv.min[key]}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(32, Math.floor(Number(e.target.value) || 1)));
                        setDraft((d) => ({
                          ...d,
                          iv: { on: v > 1 ? true : d.iv.on, min: { ...d.iv.min, [key]: v } },
                        }));
                      }}
                      className="field tnum w-full text-center text-xs font-bold sm:text-sm"
                    />
                  </label>
                ))}
              </div>
            </RuleToggle>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="text-xs">
                {ruleMsg ? (
                  <span className={ruleMsg.tone === "ok" ? "font-bold text-poke-green" : "font-bold text-poke-red"}>
                    {ruleMsg.text}
                  </span>
                ) : ruleAcc && ruleAcc.status !== "online" ? (
                  <span className="text-poke-red">Conta {ruleAcc.nick} está offline — conecte para salvar no jogo.</span>
                ) : (
                  <span className="text-mute">
                    Editando regras de <b className="text-fg">{ruleAcc?.nick ?? "—"}</b>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={Boolean(savingRule) || !ruleAcc || ruleAcc.status !== "online"}
                  onClick={() => void saveRule(false)}
                  className="btn border-poke-gold/70 bg-[#33260e] px-3 text-xs font-extrabold text-poke-gold hover:bg-[#463413] disabled:opacity-50"
                >
                  {savingRule === "one" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Salvar em {ruleAcc?.nick ?? "conta"}
                </button>
                {ids.length > 1 && (
                  <button
                    type="button"
                    disabled={Boolean(savingRule)}
                    onClick={() => void saveRule(true)}
                    className="btn px-3 text-xs font-bold disabled:opacity-50"
                  >
                    {savingRule === "all" && <Loader2 className="size-3.5 animate-spin" />}
                    Aplicar em todas online
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Filtros e Lista de Pokémons */}
      <section className="card space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ["colecao", `Coleção (${counts.colecao})`],
                ["depot", `Depot (${counts.depot})`],
                ["equipe", `Equipe (${counts.equipe})`],
                ["todos", `Todos (${counts.todos})`],
              ] as [LocalFilter, string][]
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setLocalFilter(k);
                  setLimit(80);
                }}
                className={`rounded-lg border px-2.5 py-1 text-xs font-bold transition-colors ${
                  localFilter === k
                    ? "border-poke-gold bg-poke-gold text-void"
                    : "border-line bg-tile text-mute hover:border-edge hover:text-fg"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
              <input
                type="search"
                placeholder="Buscar Pokémon…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="field w-40 pl-8 text-xs sm:w-48"
              />
            </div>
            <button
              type="button"
              onClick={() => setOnlyShiny((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                onlyShiny
                  ? "border-poke-gold bg-[#33260e] text-poke-gold"
                  : "border-line bg-tile text-mute hover:border-edge hover:text-fg"
              }`}
            >
              <Sparkles className="size-3.5" aria-hidden />
              Shiny
            </button>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="field text-xs"
              aria-label="Ordenar por"
            >
              <option value="grade">Ordenar: Nota</option>
              <option value="quality">Ordenar: Qualidade</option>
              <option value="potency">Ordenar: Potência</option>
              <option value="level">Ordenar: Nível</option>
              <option value="ivTotal">Ordenar: IV Total</option>
              <option value="recent">Ordenar: Mais recentes</option>
            </select>
          </div>
        </div>

        {error && <p className="text-xs font-bold text-poke-red">Erro ao carregar Pokémons: {error}</p>}

        {rows === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-mute">
            <Loader2 className="size-4 animate-spin" /> Carregando Pokémons…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-mute">
            {localFilter === "colecao"
              ? "Nenhum Pokémon encontrado na Coleção com estes filtros."
              : "Nenhum Pokémon encontrado."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.slice(0, limit).map((p) => {
                const loc = localOf(p);
                const accObj = accounts[p.account];
                const isOnline = accObj?.status === "online";
                const mKey = `${p.account}:${p.id}`;
                return (
                  <div
                    key={mKey}
                    className={`flex items-center gap-2.5 rounded-xl border p-2.5 transition-colors ${
                      loc === "colecao"
                        ? "border-poke-gold/50 bg-[#261c0e]/70"
                        : loc === "equipe"
                          ? "border-[#2f6b3a]/60 bg-[#16301c]/35"
                          : "border-line bg-tile"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => openSheet({ kind: "own", account: accountNumber(p.account), id: p.id }, e.currentTarget)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      title="Clique para abrir a ficha completa"
                    >
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-line bg-void/70">
                        <PokemonSprite looktype={p.looktype} species={p.speciesId} size={40} shiny={p.shiny} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="truncate text-sm font-extrabold text-fg">{p.name}</span>
                          {p.shiny && <ShinyMark />}
                          {account === "all" && accObj && (
                            <span className="ml-auto shrink-0 rounded bg-void/80 px-1.5 py-0.5 text-[10px] font-bold text-mute">
                              {accObj.nick}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-mute">
                          <span className="tnum font-bold text-fg">Nv.{fmtShort(p.level)}</span>
                          {p.grade != null && <span className="tnum text-poke-gold">Nota {p.grade.toFixed(1)}</span>}
                          {p.quality != null && <span className="tnum">Q {p.quality.toFixed(2)}</span>}
                          {p.potency != null && <span className="tnum">P{p.potency}</span>}
                          <span className="tnum">IV {p.ivTotal}</span>
                        </div>
                      </div>
                    </button>

                    {loc === "equipe" ? (
                      <span className="shrink-0 rounded-md border border-[#2f6b3a] bg-[#16301c] px-2 py-1 text-[10px] font-extrabold uppercase text-poke-green">
                        Equipe
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!isOnline || movingKey === mKey}
                        onClick={() => void toggleCollection(p)}
                        title={
                          !isOnline
                            ? "Conta offline"
                            : p.inCollection
                              ? "Remover da Coleção (mover para o Depot)"
                              : "Mover para a Coleção (protege contra venda)"
                        }
                        className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors disabled:opacity-50 ${
                          p.inCollection
                            ? "border-poke-gold/70 bg-[#33260e] text-poke-gold hover:border-poke-red hover:text-poke-red"
                            : "border-line bg-void text-mute hover:border-poke-gold hover:text-poke-gold"
                        }`}
                      >
                        {movingKey === mKey ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : p.inCollection ? (
                          <Lock className="size-3.5" />
                        ) : (
                          <LockOpen className="size-3.5" />
                        )}
                        <span>{p.inCollection ? "Coleção" : "Guardar"}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {filtered.length > limit && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setLimit((l) => l + 80)}
                  className="btn px-4 text-xs font-bold"
                >
                  Mostrar mais ({fmtInt(filtered.length - limit)} restantes)
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
