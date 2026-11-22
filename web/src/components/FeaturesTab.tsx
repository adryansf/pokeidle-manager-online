import { Coins, Crown, Flame, Gift, Loader2, RefreshCw, ShoppingBag, Store, Target } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui";
import { numId } from "@/lib/actions";
import {
  bankFee,
  featuresApi,
  PREY_BONUS_LABEL,
  preyValueText,
  type ConsolidateRow,
  type ConsolidateTotal,
  type DestroyCandidate,
  type FeaturesView,
  type NewListing,
} from "@/lib/features";
import { marketApi, type Listing } from "@/lib/market";
import { useAccount, useAccountIds, useAccountsMap } from "@/lib/telemetry";
import { fmtInt, fmtShort } from "@/lib/utils";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ToggleRow({
  label,
  desc,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  desc: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-tile px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-bold leading-tight text-fg">{label}</div>
        <div className="mt-0.5 text-xs text-mute">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
          checked ? "border-[#2f6b3a] bg-[#24592f]" : "border-line bg-void"
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full transition-transform ${
            checked ? "translate-x-5 bg-poke-green" : "translate-x-1 bg-mute"
          }`}
        />
      </button>
    </div>
  );
}

function Section({ title, Icon, children, right }: { title: string; Icon: typeof Coins; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="space-y-2.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-mute">
          <Icon className="size-3.5" aria-hidden /> {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const inputCls = "w-full rounded-lg border border-line bg-void px-2.5 py-1.5 text-sm text-fg outline-none focus:border-edge";

type Pending = { title: string; message: React.ReactNode; label: string; danger?: boolean; run: () => Promise<void> } | null;

/** Painel por conta com os recursos extras: auto-venda, prey, boss, vender no mercado, oferenda/sacrifício e eventos. */
export function FeaturesTab({ accId }: { accId: string }) {
  const acc = useAccount(accId);
  const [view, setView] = useState<FeaturesView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setView(await featuresApi.view(accId));
      setLoadErr(null);
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, [accId]);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(t);
  }, [reload]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      const r = (await fn()) as { confirmed?: boolean; ok?: boolean; error?: string } | undefined;
      if (r && r.ok === false) setMsg({ ok: false, text: r.error || "O jogo recusou." });
      else if (ok) setMsg({ ok: true, text: r && r.confirmed === false ? `${ok} (enviado; o jogo ainda não confirmou)` : ok });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const ask = (p: NonNullable<Pending>) => setPending(p);
  const runPending = async () => {
    if (!pending) return;
    setConfirmBusy(true);
    try {
      await pending.run();
    } finally {
      setConfirmBusy(false);
      setPending(null);
    }
  };

  if (!view) {
    return (
      <div className="flex items-center gap-2 text-sm text-mute">
        {loadErr ? <span className="text-poke-red">{loadErr}</span> : <><Loader2 className="size-4 animate-spin" /> Carregando…</>}
      </div>
    );
  }
  const offline = !view.online;

  return (
    <div className="space-y-4">
      {offline && <p className="rounded-lg border border-line bg-tile px-3 py-2 text-xs text-mute">A conta está offline: as ações ficam desativadas até ela voltar.</p>}
      {msg && (
        <p className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? "border-[#2f6b3a] text-poke-green" : "border-poke-red/50 text-poke-red"}`}>{msg.text}</p>
      )}

      <Section title="Automação extra" Icon={ShoppingBag}>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow
            label="Auto-venda do Depot (jogo)"
            desc="Vende ao NPC, na hora da captura, todo pokémon que iria para o Depot. Nunca vende shiny, lendário, mega, P5, refinado, com TM, o inicial nem a equipe; o que o Auto-Coleção guarda fica."
            checked={view.autoVendaDepot}
            disabled={offline || busy === "venda"}
            onToggle={() =>
              view.autoVendaDepot
                ? void act("venda", () => featuresApi.setAutoVenda(accId, false), "Auto-venda desligada.")
                : ask({
                    title: "Ligar a Auto-venda do Depot?",
                    label: "Ligar",
                    message: (
                      <>
                        Todo pokémon capturado (hunt e Safari) que iria para o Depot é <b>vendido ao NPC na hora</b>. Ajuste o Auto-Coleção antes:{" "}
                        <b>o vendido não volta</b>. O que já está no Depot fica onde está.
                      </>
                    ),
                    run: () => act("venda", () => featuresApi.setAutoVenda(accId, true), "Auto-venda ligada."),
                  })
            }
          />
          <ToggleRow
            label="Prey diário automático"
            desc="Faz só a roletada GRÁTIS de cada cartela e escolhe a espécie da hunt atual (ou da hunt mais alta liberada). Nunca usa roletada paga."
            checked={view.autoPrey}
            disabled={busy === "prey-auto"}
            onToggle={() => void act("prey-auto", () => featuresApi.setAutoPrey(accId, !view.autoPrey))}
          />
        </div>
      </Section>

      <Section title={`Prey · dia ${view.prey.dia}`} Icon={Target}>
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => {
            const c = view.prey.cartelas[i];
            const locked = i >= view.prey.liberadas;
            return (
              <div key={i} className={`rounded-xl border border-line bg-tile p-3 ${locked ? "opacity-50" : ""}`}>
                <div className="flex items-center justify-between text-sm font-bold">
                  <span>Cartela {i + 1}</span>
                  {c?.bonus && (
                    <span className="text-xs text-poke-gold">
                      {PREY_BONUS_LABEL[c.bonus]} {preyValueText(c.bonus, c.valor)} · {"★".repeat(c.est ?? 0)}
                    </span>
                  )}
                </div>
                {locked ? (
                  <p className="mt-1 text-xs text-mute">Bloqueada (desbloqueia no jogo com diamantes).</p>
                ) : !c?.bonus ? (
                  <button className="btn mt-2 w-full" disabled={offline || busy === `roll${i}`} onClick={() => void act(`roll${i}`, () => featuresApi.preyRoll(accId, i), "Roletada grátis feita.")}>
                    Roletar grátis
                  </button>
                ) : c.pk != null ? (
                  <p className="mt-1 text-xs text-mute">
                    Ativa em <b className="text-fg">{c.pkNome ?? `#${c.pk}`}</b>.
                  </p>
                ) : (
                  <div className="mt-2">
                    <p className="mb-1 text-xs text-mute">Escolha a espécie (fica até a virada das 18:00):</p>
                    <div className="flex flex-wrap gap-1">
                      {c.opcoes.map((o) => (
                        <button
                          key={o.pokeId}
                          className="btn px-2 py-1 text-xs"
                          disabled={offline || busy === `pick${i}`}
                          onClick={() =>
                            ask({
                              title: `Escolher ${o.nome}?`,
                              label: "Escolher",
                              danger: false,
                              message: <>A escolha não se troca até a virada do dia (ou uma roletada paga no jogo).</>,
                              run: () => act(`pick${i}`, () => featuresApi.preyChoose(accId, i, o.pokeId), `Cartela ${i + 1}: ${o.nome}.`),
                            })
                          }
                        >
                          {o.nome}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <BossSection accId={accId} view={view} busy={busy} act={act} offline={offline} />

      <MarketSection accId={accId} view={view} offline={offline} ask={ask} act={act} inventory={acc?.inventory?.items ?? []} />

      <DestroySection accId={accId} offline={offline} ask={ask} act={act} />

      <Section title="Eventos recentes" Icon={Gift} right={<button className="btn px-2 py-1 text-xs" onClick={() => void reload()}><RefreshCw className="size-3" /></button>}>
        {view.events.length === 0 ? (
          <p className="text-xs text-mute">Nada por enquanto (vendas, ovos, boss, prey e coins aparecem aqui).</p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-auto text-xs">
            {view.events.map((e) => (
              <li key={e.id} className="flex gap-2 rounded-lg bg-tile px-2.5 py-1.5">
                <span className="shrink-0 tabular-nums text-mute">{new Date(e.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="text-fg">{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={pending != null}
        title={pending?.title ?? ""}
        message={pending?.message ?? ""}
        confirmLabel={pending?.label}
        danger={pending?.danger ?? true}
        busy={confirmBusy}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

type Act = (key: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;
type Ask = (p: NonNullable<Pending>) => void;

function BossSection({ accId, view, busy, act, offline }: { accId: string; view: FeaturesView; busy: string | null; act: Act; offline: boolean }) {
  const bosses = view.boss.bosses;
  const [key, setKey] = useState<string>(view.boss.autoKey ?? bosses[0]?.key ?? "");
  useEffect(() => {
    if (!key && bosses[0]) setKey(view.boss.autoKey ?? bosses[0].key);
  }, [bosses, key, view.boss.autoKey]);
  const sel = bosses.find((b) => b.key === key);
  return (
    <Section title="Boss" Icon={Crown}>
      {bosses.length === 0 ? (
        <p className="text-xs text-mute">O jogo não informou arenas de boss para esta conta (reconecte para atualizar).</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${inputCls} w-auto`} value={key} onChange={(e) => setKey(e.target.value)}>
              {bosses.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.name} · Nv {b.minLevel}+ · {b.entries} entrada(s)
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={offline || !sel || !sel.levelOk || sel.entries < 1 || busy === "boss-enter"}
              onClick={() => void act("boss-enter", () => featuresApi.bossEnter(accId, key), "Entrando na arena.")}
            >
              Entrar
            </button>
            <button className="btn" disabled={offline || busy === "boss-leave"} onClick={() => void act("boss-leave", () => featuresApi.bossLeave(accId), "Saindo da arena.")}>
              Sair
            </button>
          </div>
          {sel && (
            <p className="text-xs text-mute">
              Entrada: {sel.entry.qty}× {sel.entry.name ?? `item #${sel.entry.itemId}`} (tem {fmtInt(sel.have)}){!sel.levelOk && ` · precisa de nível ${sel.minLevel}`}
            </p>
          )}
          <ToggleRow
            label="Repetir boss automaticamente (jogo)"
            desc={
              view.boss.auto && view.boss.autoKey && view.boss.autoKey !== key
                ? `Ligado em outro boss (${bosses.find((b) => b.key === view.boss.autoKey)?.name ?? view.boss.autoKey}).`
                : "Ao fim de cada luta, cura no Centro e volta enquanto houver entradas."
            }
            checked={view.boss.auto}
            disabled={offline || !key || busy === "boss-auto"}
            onToggle={() => void act("boss-auto", () => featuresApi.bossAuto(accId, !view.boss.auto, view.boss.auto ? view.boss.autoKey ?? key : key))}
          />
        </div>
      )}
    </Section>
  );
}

function MarketSection({
  accId,
  view,
  offline,
  ask,
  act,
  inventory,
}: {
  accId: string;
  view: FeaturesView;
  offline: boolean;
  ask: Ask;
  act: Act;
  inventory: { id: number; name: string; qty: number }[];
}) {
  const [tipo, setTipo] = useState<"item" | "pokemon">("item");
  const [itemId, setItemId] = useState<number>(0);
  const [pokemonId, setPokemonId] = useState("");
  const [qtd, setQtd] = useState(1);
  const [preco, setPreco] = useState(0);
  const [moeda, setMoeda] = useState<"gold" | "orb">("gold");
  const [dias, setDias] = useState(view.market.diasMin);
  const [mine, setMine] = useState<Listing[] | null>(null);
  const [mineErr, setMineErr] = useState<string | null>(null);
  const items = useMemo(() => inventory.filter((i) => i.qty > 0).sort((a, b) => a.name.localeCompare(b.name)), [inventory]);
  const item = items.find((i) => i.id === itemId);
  const min = moeda === "orb" ? view.market.precoMinOrb : view.market.precoMinGold;
  const units = tipo === "item" ? qtd : 1;
  const net = moeda === "gold" ? Math.floor(units * preco * (1 - view.market.taxaGoldPct / 100)) : null;
  const stay = tipo === "pokemon" ? view.market.taxaDiaria * dias : 0;
  const valid = preco >= min && (tipo === "item" ? !!item && qtd >= 1 && qtd <= item.qty : Number(pokemonId) > 0 && dias >= view.market.diasMin && dias <= view.market.diasMax);

  const loadMine = useCallback(async () => {
    try {
      setMine((await marketApi.mine(numId(accId))).listings);
      setMineErr(null);
    } catch (e) {
      setMineErr(errMsg(e));
    }
  }, [accId]);

  const submit = () => {
    const l: NewListing = tipo === "item" ? { tipo, itemId, qtd, preco, moeda } : { tipo, pokemonId: Number(pokemonId), qtd: 1, preco, moeda, dias };
    ask({
      title: "Publicar anúncio?",
      label: "Publicar",
      message: (
        <>
          {tipo === "item" ? `${qtd}× ${item?.name}` : `Pokémon #${pokemonId}`} por <b>{fmtInt(preco)}</b> {moeda === "orb" ? "Gemas" : "coins"}
          {tipo === "item" && qtd > 1 ? " cada" : ""}.{net != null && <> Você recebe ≈ <b>{fmtInt(net)}</b> coins após a taxa.</>}
          {tipo === "pokemon" && <> A estadia de {dias} dia(s) custa <b>{fmtInt(stay)}</b> coins agora (experimental).</>}
        </>
      ),
      run: () => act("mk-create", () => featuresApi.createListing(accId, l), "Anúncio publicado.").then(() => void loadMine()),
    });
  };

  return (
    <Section title="Vender no mercado" Icon={Store}>
      <div className="grid gap-2 rounded-xl border border-line bg-tile p-3 sm:grid-cols-2">
        <label className="text-xs text-mute">
          Tipo
          <select className={inputCls} value={tipo} onChange={(e) => setTipo(e.target.value as "item" | "pokemon")}>
            <option value="item">Item</option>
            <option value="pokemon">Pokémon (experimental)</option>
          </select>
        </label>
        {tipo === "item" ? (
          <label className="text-xs text-mute">
            Item
            <select className={inputCls} value={itemId} onChange={(e) => setItemId(Number(e.target.value))}>
              <option value={0}>Escolha…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} (×{fmtInt(i.qty)})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="text-xs text-mute">
            ID do pokémon (fora da equipe e da Coleção)
            <input className={inputCls} inputMode="numeric" value={pokemonId} onChange={(e) => setPokemonId(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
        {tipo === "item" ? (
          <label className="text-xs text-mute">
            Quantidade
            <input className={inputCls} type="number" min={1} max={item?.qty ?? 1} value={qtd} onChange={(e) => setQtd(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          </label>
        ) : (
          <label className="text-xs text-mute">
            Dias ({view.market.diasMin}–{view.market.diasMax}) · {fmtShort(view.market.taxaDiaria)}/dia
            <input className={inputCls} type="number" min={view.market.diasMin} max={view.market.diasMax} value={dias} onChange={(e) => setDias(Math.floor(Number(e.target.value) || view.market.diasMin))} />
          </label>
        )}
        <label className="text-xs text-mute">
          Preço {tipo === "item" ? "por unidade" : ""} (mín. {min})
          <div className="flex gap-1">
            <input className={inputCls} type="number" min={min} value={preco || ""} onChange={(e) => setPreco(Math.floor(Number(e.target.value) || 0))} />
            <select className={`${inputCls} w-24`} value={moeda} onChange={(e) => setMoeda(e.target.value as "gold" | "orb")}>
              <option value="gold">coins</option>
              <option value="orb">Gemas</option>
            </select>
          </div>
        </label>
        <div className="flex items-end justify-between gap-2 sm:col-span-2">
          <span className="text-xs text-mute">{net != null && preco > 0 ? `Recebe ≈ ${fmtInt(net)} coins (taxa ${view.market.taxaGoldPct}%).` : moeda === "orb" ? "Gemas: taxa por faixa, calculada pelo jogo." : ""}</span>
          <button className="btn" disabled={offline || !valid} onClick={submit}>
            Anunciar
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-mute">Meus anúncios</span>
        <button className="btn px-2 py-1 text-xs" disabled={offline} onClick={() => void loadMine()}>
          {mine ? "Atualizar" : "Carregar"}
        </button>
      </div>
      {mineErr && <p className="text-xs text-poke-red">{mineErr}</p>}
      {mine && mine.length === 0 && <p className="text-xs text-mute">Nenhum anúncio ativo.</p>}
      {mine && mine.length > 0 && (
        <ul className="space-y-1">
          {mine.map((l) => (
            <ListingRow key={l.id} l={l} accId={accId} ask={ask} act={act} offline={offline} reload={loadMine} diasMax={view.market.diasMax} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ListingRow({ l, accId, ask, act, offline, reload, diasMax }: { l: Listing; accId: string; ask: Ask; act: Act; offline: boolean; reload: () => Promise<void>; diasMax: number }) {
  const [preco, setPreco] = useState(l.preco);
  const [dias, setDias] = useState(0);
  const name = l.tipo === "pokemon" ? `${String(l.ficha?.nome ?? "Pokémon")}${l.ficha?.level ? ` Nv ${l.ficha.level}` : ""}` : `${l.qtd}× item #${l.itemId}`;
  const changed = preco !== l.preco || dias > 0;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-tile px-2.5 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
      <input className={`${inputCls} w-28 py-1 text-xs`} type="number" min={1} value={preco} onChange={(e) => setPreco(Math.floor(Number(e.target.value) || 0))} />
      <span className="text-mute">{l.moeda === "orb" ? "Gemas" : "coins"}</span>
      {l.tipo === "pokemon" && (
        <input className={`${inputCls} w-16 py-1 text-xs`} type="number" min={0} max={diasMax} title="Dias a estender" value={dias} onChange={(e) => setDias(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
      )}
      <button
        className="btn px-2 py-1 text-xs"
        disabled={offline || !changed || preco < 1}
        onClick={() =>
          ask({
            title: "Salvar anúncio?",
            label: "Salvar",
            danger: false,
            message: (
              <>
                {preco !== l.preco && <>Novo preço: <b>{fmtInt(preco)}</b>. </>}
                {dias > 0 && <>Estender {dias} dia(s) (cobra a estadia em coins).</>}
              </>
            ),
            run: () =>
              act("mk-edit", () => featuresApi.editListing(accId, l.id, { ...(preco !== l.preco ? { preco, moeda: l.moeda } : {}), ...(dias > 0 ? { dias } : {}) }), "Anúncio atualizado.").then(() => void reload()),
          })
        }
      >
        Salvar
      </button>
      <button
        className="btn px-2 py-1 text-xs"
        disabled={offline}
        onClick={() =>
          ask({
            title: "Remover anúncio?",
            label: "Remover",
            message: <>{name} sai do mercado e volta para a conta.</>,
            run: () => act("mk-cancel", () => featuresApi.cancelListing(accId, l.id), "Anúncio removido.").then(() => void reload()),
          })
        }
      >
        Remover
      </button>
    </li>
  );
}

function DestroySection({ accId, offline, ask, act }: { accId: string; offline: boolean; ask: Ask; act: Act }) {
  const [rows, setRows] = useState<DestroyCandidate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const load = async () => {
    setLoading(true);
    try {
      setRows((await featuresApi.destroyCandidates(accId)).pokemons);
      setSel([]);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  const allowed = rows?.filter((r) => r.allowed) ?? [];
  const blocked = rows ? rows.length - allowed.length : 0;
  const names = (rows ?? []).filter((r) => sel.includes(r.id)).map((r) => `${r.nome ?? "#" + r.id} Nv ${r.level ?? "?"}`);
  const run = (kind: "oferenda" | "sacrificio") =>
    ask({
      title: kind === "oferenda" ? `Oferenda com ${sel.length} pokémon?` : `Sacrificar ${sel.length} pokémon?`,
      label: kind === "oferenda" ? "Girar a Oferenda" : "Sacrificar",
      message: (
        <>
          <b>Os pokémon somem para sempre</b>: {names.join(", ")}.{" "}
          {kind === "oferenda" ? "Em troca, a roleta sorteia pedras de evolução." : "Em troca, enchem a barra de boost de XP (só nota 3,5+ dá pontos)."}
        </>
      ),
      run: () =>
        act(kind, () => (kind === "oferenda" ? featuresApi.oferenda(accId, sel) : featuresApi.sacrificio(accId, sel)), kind === "oferenda" ? "Oferenda girada." : "Sacrifício feito.").then(() => void load()),
    });
  return (
    <Section title="Oferenda e Sacrifício (manual)" Icon={Flame}>
      <p className="text-xs text-mute">
        Só pokémon do Depot entram. Shiny, Coleção/travados, vitrine, equipe, ativo, inicial, P5, refinados, com TM ou item, lendários, formas especiais e os protegidos do jogo
        são sempre bloqueados.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={offline || loading} onClick={() => void load()}>
          {loading ? "Carregando…" : rows ? "Atualizar lista" : "Carregar pokémon"}
        </button>
        <button className="btn" disabled={offline || sel.length < 1 || sel.length > 5} onClick={() => run("oferenda")}>
          Oferenda ({sel.length}/5)
        </button>
        <button className="btn" disabled={offline || sel.length < 1 || sel.length > 50} onClick={() => run("sacrificio")}>
          Sacrificar ({sel.length}/50)
        </button>
        <button className="btn" disabled={offline} onClick={() => void act("sac-resgatar", () => featuresApi.sacrificioResgatar(accId), "Boost do Sacrifício resgatado.")}>
          Resgatar boost
        </button>
      </div>
      {err && <p className="text-xs text-poke-red">{err}</p>}
      {rows && (
        <>
          <p className="text-xs text-mute">
            {allowed.length} liberado(s) · {blocked} bloqueado(s)
          </p>
          <ul className="grid max-h-60 gap-1 overflow-auto sm:grid-cols-2">
            {allowed.map((r) => (
              <li key={r.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-tile px-2.5 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={sel.includes(r.id)}
                    onChange={(e) => setSel((s) => (e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id)))}
                  />
                  <span className="flex-1 truncate text-fg">
                    {r.nome ?? `#${r.id}`} Nv {r.level ?? "?"}
                  </span>
                  {r.nota != null && <span className="text-mute">nota {Number(r.nota).toFixed(2)}</span>}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/** "Juntar coins": envia o ouro acima da reserva de várias contas para um nick (Banco do jogo, taxa de 15% queimada). */
export function ConsolidateCoinsPanel() {
  const ids = useAccountIds();
  const accounts = useAccountsMap();
  const [target, setTarget] = useState("");
  const [reserve, setReserve] = useState(100_000);
  const [sel, setSel] = useState<string[]>([]);
  const [plan, setPlan] = useState<{ rows: ConsolidateRow[]; total: ConsolidateTotal } | null>(null);
  const [results, setResults] = useState<{ rows: ConsolidateRow[]; total: ConsolidateTotal } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const nums = sel.map(numId);
  const nickOk = /^[a-zA-Z0-9_]{3,16}$/.test(target.trim());

  const preview = async () => {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const r = await featuresApi.consolidatePreview(target.trim(), nums, reserve);
      setPlan({ rows: r.plan, total: r.total });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await featuresApi.consolidate(target.trim(), nums, reserve);
      setResults({ rows: r.results, total: r.total });
      setPlan(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const rows = results?.rows ?? plan?.rows ?? [];
  const total = results?.total ?? plan?.total;

  return (
    <div className="space-y-3">
      <p className="text-xs text-mute">
        Envia, pelo Banco do jogo, o ouro <b>acima da reserva</b> de cada conta marcada para o nick de destino. A taxa de <b>15% é queimada</b>, o mínimo é 1.000 coins por
        envio, as duas pontas precisam de nível 10 e <b>o envio não se desfaz</b>. Nada é enviado sem a sua confirmação.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-mute">
          Nick de destino
          <input className={inputCls} value={target} maxLength={16} onChange={(e) => { setTarget(e.target.value); setPlan(null); }} list="consolidate-nicks" />
          <datalist id="consolidate-nicks">
            {ids.map((id) => accounts[id] && <option key={id} value={accounts[id].nick} />)}
          </datalist>
        </label>
        <label className="text-xs text-mute">
          Reserva por conta (coins que ficam)
          <input className={inputCls} type="number" min={0} value={reserve} onChange={(e) => { setReserve(Math.max(0, Math.floor(Number(e.target.value) || 0))); setPlan(null); }} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button className="btn px-2 py-1 text-xs" onClick={() => { setSel(ids.filter((id) => accounts[id]?.nick.toLowerCase() !== target.trim().toLowerCase())); setPlan(null); }}>
          Marcar todas
        </button>
        <button className="btn px-2 py-1 text-xs" onClick={() => { setSel([]); setPlan(null); }}>
          Limpar
        </button>
        {ids.map((id) => {
          const a = accounts[id];
          if (!a) return null;
          const on = sel.includes(id);
          return (
            <button
              key={id}
              className={`btn px-2 py-1 text-xs ${on ? "border-poke-gold/70 text-poke-gold" : ""}`}
              onClick={() => { setSel((s) => (on ? s.filter((x) => x !== id) : [...s, id])); setPlan(null); }}
            >
              {a.nick} · {fmtShort(a.gold)}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <button className="btn" disabled={busy || !nickOk || sel.length === 0} onClick={() => void preview()}>
          Simular
        </button>
        <button
          className="btn border-0 bg-poke-gold font-bold text-void hover:bg-[#f6ca5e]"
          disabled={busy || !plan || plan.total.accounts === 0}
          onClick={() => setConfirm(true)}
        >
          Enviar coins
        </button>
      </div>
      {err && <p className="text-xs text-poke-red">{err}</p>}
      {rows.length > 0 && (
        <div className="overflow-auto rounded-xl border border-line">
          <table className="w-full text-xs">
            <thead className="bg-tile text-left text-mute">
              <tr>
                <th className="px-2 py-1.5">Conta</th>
                <th className="px-2 py-1.5 text-right">Saldo</th>
                <th className="px-2 py-1.5 text-right">Envia</th>
                <th className="px-2 py-1.5 text-right">Taxa</th>
                <th className="px-2 py-1.5 text-right">Chega</th>
                <th className="px-2 py-1.5">Situação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.account} className="border-t border-line">
                  <td className="px-2 py-1.5 text-fg">{r.nick ?? r.account}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(r.gold)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.amount ? fmtInt(r.amount) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.amount ? fmtInt(r.fee || bankFee(r.amount)) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.amount ? fmtInt(r.net) : "—"}</td>
                  <td className={`px-2 py-1.5 ${r.status === "enviado" || r.status === "ok" ? "text-poke-green" : r.status === "skip" ? "text-mute" : "text-poke-red"}`}>
                    {r.status === "ok" ? "vai enviar" : r.status}
                    {r.detail ? ` · ${r.detail}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total && (
        <p className="text-xs text-mute">
          {results ? "Enviado" : "Total"}: <b className="text-fg">{fmtInt(total.amount)}</b> coins de {total.accounts} conta(s) · taxa {fmtInt(total.fee)} · chegam{" "}
          <b className="text-poke-gold">{fmtInt(total.net)}</b> em {target.trim()}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title="Confirmar transferência?"
        confirmLabel="Enviar"
        busy={busy}
        message={
          plan ? (
            <>
              Enviar <b>{fmtInt(plan.total.amount)}</b> coins de {plan.total.accounts} conta(s) para <b>{target.trim()}</b>. Chegam {fmtInt(plan.total.net)}; a taxa de{" "}
              {fmtInt(plan.total.fee)} é queimada. <b>Confira o nick: o envio não se desfaz.</b>
            </>
          ) : (
            ""
          )
        }
        onConfirm={() => void send()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
