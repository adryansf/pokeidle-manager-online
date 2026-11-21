import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bot,
  Globe,
  HeartPulse,
  Package,
  Pause,
  Play,
  Radio,
  Sparkles,
  Swords,
  Target,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CapturesView } from "@/components/CapturesView";
import { ItemSprite, PokemonSprite, ShinyMark } from "@/components/Sprites";
import { StatusPill } from "@/components/StatusPill";
import { AnimatedNumber, Coin } from "@/components/ui";
import { actions, type AutomationPatch } from "@/lib/actions";
import { usePokemons } from "@/lib/api";
import { accountNumber, useSheet } from "@/lib/sheet";
import { serverNow, useAccount } from "@/lib/telemetry";
import type { TeamPokemon } from "@/lib/types";
import { fmtDuration, fmtShort } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

type DetailTab = "geral" | "equipe" | "automacao" | "inventario" | "capturas";

const TABS: { id: DetailTab; label: string; Icon: typeof Activity }[] = [
  { id: "geral", label: "Visão Geral", Icon: Activity },
  { id: "equipe", label: "Equipe & Pokémons", Icon: Swords },
  { id: "automacao", label: "Automação", Icon: Bot },
  { id: "inventario", label: "Inventário", Icon: Package },
  { id: "capturas", label: "Capturas", Icon: Target },
];

function hpColor(pct: number) {
  return pct > 50 ? "#6fd47c" : pct > 20 ? "#f3c04a" : "#ef6b5b";
}

function fmtSessionClock(startedAt: number | null | undefined) {
  if (!startedAt) return "—";
  const s = Math.max(0, Math.floor((serverNow() - startedAt) / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function ToggleRow({
  label,
  desc,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  desc: string;
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

function TeamCard({
  mon,
  onOpenSheet,
}: {
  mon: TeamPokemon;
  onOpenSheet: (id: number, el: Element) => void;
}) {
  const pct = mon.maxHp > 0 ? Math.max(0, Math.min(100, (mon.hp / mon.maxHp) * 100)) : 0;
  return (
    <button
      type="button"
      disabled={!mon.id}
      onClick={(e) => mon.id && onOpenSheet(mon.id, e.currentTarget)}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-edge disabled:cursor-default ${
        mon.active ? "border-poke-gold/70 bg-[#2a1f0b]/60" : "border-line bg-tile"
      }`}
    >
      <div className="relative flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-void">
        <PokemonSprite looktype={mon.looktype} species={mon.speciesId} size={48} shiny={mon.shiny} />
        {mon.active && (
          <span className="absolute -bottom-1 rounded bg-poke-gold px-1 py-0.5 text-[9px] font-black uppercase leading-none text-void">
            Ativo
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1 font-extrabold">
            <span className="truncate text-sm sm:text-base">{mon.name}</span>
            {mon.shiny && <ShinyMark />}
          </div>
          <span className="tnum shrink-0 text-xs font-bold text-poke-gold">Nv. {fmtShort(mon.level)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/55">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: hpColor(pct) }} />
          </div>
          <span className="tnum shrink-0 text-[11px] font-semibold text-mute">
            {fmtShort(mon.hp)}/{fmtShort(mon.maxHp)} HP ({Math.round(pct)}%)
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-mute">
          {mon.grade != null && (
            <span>
              Nota <b className="tnum text-fg">{mon.grade.toFixed(2)}</b>
            </span>
          )}
          {mon.ivTotal != null && (
            <span>
              IV <b className="tnum text-fg">{mon.ivTotal}</b>
            </span>
          )}
          {mon.potency != null && (
            <span>
              P<b className="tnum text-poke-gold">{mon.potency}</b>
            </span>
          )}
          <span className="ml-auto font-semibold text-poke-gold/90">Ver ficha →</span>
        </div>
      </div>
    </button>
  );
}

function AllAccountPokemons({ accId, onOpenSheet }: { accId: string; onOpenSheet: (id: number, el: Element) => void }) {
  const { rows } = usePokemons(accId, 0);
  const top = (rows ?? []).slice().sort((a, b) => (b.power ?? 0) - (a.power ?? 0)).slice(0, 18);
  if (!rows) return <p className="text-xs text-mute">Carregando Pokémons da conta…</p>;
  if (top.length === 0) return <p className="text-xs text-mute">Nenhum outro Pokémon encontrado.</p>;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {top.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={(e) => onOpenSheet(p.id, e.currentTarget)}
          className="flex items-center gap-2.5 rounded-lg border border-line bg-void/60 p-2 text-left transition-colors hover:border-edge"
        >
          <PokemonSprite looktype={p.looktype} species={p.speciesId} size={36} shiny={p.shiny} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-xs font-bold">
              <span className="truncate">{p.name}</span>
              {p.shiny && <ShinyMark />}
            </div>
            <div className="tnum text-[11px] text-mute">
              Nv.{fmtShort(p.level)} · IV {p.ivTotal}
              {p.grade != null ? ` · Nota ${p.grade.toFixed(1)}` : ""}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function AccountDetailModal({
  accId,
  open,
  onClose,
  onOpenLive,
}: {
  accId: string;
  open: boolean;
  onClose: () => void;
  onOpenLive: () => void;
}) {
  const acc = useAccount(accId);
  const openSheet = useSheet();
  const [tab, setTab] = useState<DetailTab>("geral");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [autoDraft, setAutoDraft] = useState<{
    hpLimiarPct: string;
    potionThreshold: string;
    potionQty: string;
    ballThreshold: string;
    ballQty: string;
    goldReserve: string;
    autoCenterHpPct: string;
  }>({
    hpLimiarPct: "40",
    potionThreshold: "10",
    potionQty: "100",
    ballThreshold: "10",
    ballQty: "100",
    goldReserve: "0",
    autoCenterHpPct: "20",
  });

  useEffect(() => {
    if (!open || !acc?.automation) return;
    const a = acc.automation;
    setAutoDraft({
      hpLimiarPct: String(a.hpLimiarPct ?? (a.hpLimiar != null ? Math.round(a.hpLimiar * 100) : 40)),
      potionThreshold: String(a.potionThreshold ?? 10),
      potionQty: String(a.potionQty ?? 100),
      ballThreshold: String(a.ballThreshold ?? 10),
      ballQty: String(a.ballQty ?? 100),
      goldReserve: String(a.goldReserve ?? 0),
      autoCenterHpPct: String(a.autoCenterHpPct ?? 20),
    });
    // Sincroniza quando abre o modal ou muda de conta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined" || !acc) return null;

  const pk = acc.pokemon;
  const hpPct = pk && pk.maxHp > 0 ? Math.max(0, Math.min(100, (pk.hp / pk.maxHp) * 100)) : 0;
  const team = acc.team ?? [];
  const auto = acc.automation;
  const accNum = accountNumber(accId);

  const openMonSheet = (monId: number, el: Element) => {
    openSheet({ kind: "own", account: accNum, id: monId }, el);
  };

  const toggleAuto = async (key: string, patch: AutomationPatch) => {
    setBusyKey(key);
    setMsg(null);
    try {
      await actions.setAutomation(accId, patch);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao atualizar automação" });
    } finally {
      setBusyKey(null);
    }
  };

  const togglePause = async () => {
    setBusyKey("pause");
    setMsg(null);
    try {
      await actions.pause(accId, !acc.paused);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao alterar pausa" });
    } finally {
      setBusyKey(null);
    }
  };

  const sendCenter = async () => {
    setBusyKey("center");
    setMsg(null);
    try {
      await actions.goCenter(accId);
      setMsg({ tone: "ok", text: "Comando para ir ao Centro Pokémon enviado." });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Não foi possível ir ao Centro" });
    } finally {
      setBusyKey(null);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2.5 backdrop-blur-sm sm:p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          role="presentation"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Detalhes da conta ${acc.nick}`}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97, transition: { duration: 0.15 } }}
            transition={{ duration: 0.24, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="card flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden p-0"
          >
            {/* Cabeçalho */}
            <div className="border-b border-line bg-tile/75 px-3.5 py-3 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    disabled={!pk?.id}
                    onClick={(e) => pk?.id && openMonSheet(pk.id, e.currentTarget)}
                    title={pk?.id ? "Abrir ficha completa do Pokémon ativo" : undefined}
                    className="flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-edge transition-transform hover:scale-105 disabled:cursor-default"
                    style={{ background: "radial-gradient(circle at 50% 35%, #4a3519, #1a120a 75%)" }}
                  >
                    <PokemonSprite looktype={pk?.looktype} species={pk?.speciesId} size={42} shiny={pk?.shiny} />
                  </button>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-extrabold sm:text-xl">{acc.nick}</h2>
                      <StatusPill status={acc.status} />
                      {acc.proxy ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-[#2f6b3a] bg-[#16301c] px-2 py-0.5 text-[11px] font-bold text-poke-green"
                          title={`${acc.proxy.scheme}://${acc.proxy.host}:${acc.proxy.port}${acc.proxy.exitIp ? ` · IP ${acc.proxy.exitIp}` : ""}`}
                        >
                          <Globe className="size-3" aria-hidden />
                          {acc.proxy.name}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md border border-line bg-void px-2 py-0.5 text-[11px] font-semibold text-mute">
                          <Globe className="size-3 opacity-60" aria-hidden />
                          Direto
                        </span>
                      )}
                    </div>
                    <p className="tnum mt-0.5 truncate text-xs text-mute">
                      Treinador Nv. {fmtShort(acc.level)}
                      {acc.map ? ` · ${acc.map.label}` : ""}
                      {acc.huntName ? ` · Hunt ${acc.huntName}` : ""}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="btn px-2.5 py-1.5 text-xs font-bold"
                    onClick={() => {
                      onClose();
                      onOpenLive();
                    }}
                  >
                    <Radio className="size-3.5 text-poke-red" aria-hidden />
                    Live
                  </button>
                  {acc.status === "online" && (
                    <button
                      type="button"
                      disabled={busyKey === "center" || (acc.combatLockMs ?? 0) > 0}
                      onClick={() => void sendCenter()}
                      className="btn px-2.5 py-1.5 text-xs font-bold disabled:opacity-50"
                    >
                      <HeartPulse className="size-3.5 text-poke-red" aria-hidden />
                      Centro
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyKey === "pause"}
                    onClick={() => void togglePause()}
                    className={`btn px-2.5 py-1.5 text-xs font-bold ${
                      acc.paused
                        ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
                        : "border-[#7a5a1c] bg-[#33260e] text-poke-gold"
                    }`}
                  >
                    {acc.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                    {acc.paused ? "Retomar" : "Pausar"}
                  </button>
                  <button type="button" onClick={onClose} aria-label="Fechar" className="btn p-1.5 text-mute hover:text-fg">
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              </div>

              {/* Barra de Abas */}
              <div className="mt-3 flex gap-1 overflow-x-auto pb-0.5" role="tablist">
                {TABS.map(({ id: tid, label, Icon }) => (
                  <button
                    key={tid}
                    type="button"
                    role="tab"
                    aria-selected={tab === tid}
                    data-active={tab === tid}
                    onClick={() => setTab(tid)}
                    className="btn shrink-0 px-3 py-1.5 text-xs font-bold sm:text-sm"
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {label}
                    {tid === "equipe" && team.length > 0 && (
                      <span className="tnum ml-0.5 rounded bg-black/30 px-1 text-[10px]">{team.length}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Conteúdo rolável */}
            <div className="flex-1 space-y-4 overflow-y-auto p-3.5 sm:p-5">
              {msg && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                    msg.tone === "ok"
                      ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
                      : "border-[#7a2f27] bg-[#32140f] text-poke-red"
                  }`}
                >
                  {msg.text}
                </div>
              )}

              {/* ABA 1: VISÃO GERAL */}
              {tab === "geral" && (
                <div className="space-y-4">
                  {/* Pokémon Ativo + HP */}
                  <section className="rounded-xl border border-edge/60 bg-tile p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <PokemonSprite looktype={pk?.looktype} species={pk?.speciesId} size={56} shiny={pk?.shiny} />
                        <div>
                          <div className="flex items-center gap-1.5 text-base font-extrabold">
                            <span>{pk?.name ?? "Sem Pokémon ativo"}</span>
                            {pk?.shiny && <ShinyMark />}
                            {pk?.level != null && <span className="tnum text-sm text-poke-gold">Nv. {fmtShort(pk.level)}</span>}
                          </div>
                          <div className="tnum mt-0.5 text-xs text-mute">
                            HP:{" "}
                            <b className="text-fg">
                              {pk ? `${fmtShort(pk.hp)} / ${fmtShort(pk.maxHp)} (${Math.round(hpPct)}%)` : "—"}
                            </b>
                          </div>
                        </div>
                      </div>
                      {pk?.id && (
                        <button
                          type="button"
                          onClick={(e) => openMonSheet(pk.id!, e.currentTarget)}
                          className="btn border-edge/70 text-xs font-bold text-poke-gold"
                        >
                          <Sparkles className="size-3.5" aria-hidden />
                          Ver Ficha Completa
                        </button>
                      )}
                    </div>
                    <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-black/55">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${hpPct}%`, backgroundColor: hpColor(hpPct) }}
                      />
                    </div>
                  </section>

                  {/* Métricas */}
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <div className="tile p-3">
                      <div className="text-[11px] font-bold uppercase text-mute">Gold</div>
                      <div className="mt-1 flex items-center gap-1.5 text-base font-extrabold">
                        <Coin kind="gold" size={18} />
                        <AnimatedNumber value={acc.gold} />
                      </div>
                    </div>
                    <div className="tile p-3">
                      <div className="text-[11px] font-bold uppercase text-mute">Gemas</div>
                      <div className="mt-1 flex items-center gap-1.5 text-base font-extrabold">
                        <Coin kind="gem" size={18} />
                        <AnimatedNumber value={acc.gems} />
                      </div>
                    </div>
                    <div className="tile p-3">
                      <div className="text-[11px] font-bold uppercase text-mute">XP / hora</div>
                      <div className="mt-1 text-base font-extrabold text-poke-green">
                        +<AnimatedNumber value={acc.xpPerHour} />
                      </div>
                    </div>
                    <div className="tile p-3">
                      <div className="text-[11px] font-bold uppercase text-mute">Ouro / hora</div>
                      <div className="mt-1 text-base font-extrabold text-poke-gold">
                        +<AnimatedNumber value={acc.goldPerHour} />
                      </div>
                    </div>
                  </div>

                  {/* Conexão & Proxy */}
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="rounded-xl border border-line bg-void/50 p-3 text-xs space-y-1">
                      <div className="font-bold uppercase tracking-wide text-mute">Conexão & Proxy</div>
                      <div>
                        Proxy:{" "}
                        <b className="text-fg">
                          {acc.proxy ? `${acc.proxy.name} (${acc.proxy.scheme}://${acc.proxy.host}:${acc.proxy.port})` : "Direto (IP do servidor)"}
                        </b>
                      </div>
                      {acc.proxy?.exitIp && (
                        <div>
                          IP de saída: <b className="tnum text-poke-green">{acc.proxy.exitIp}</b>
                        </div>
                      )}
                      {acc.lastReason && (
                        <div className="text-poke-gold">Último aviso: {acc.lastReason}</div>
                      )}
                    </div>
                    <div className="rounded-xl border border-line bg-void/50 p-3 text-xs space-y-1">
                      <div className="font-bold uppercase tracking-wide text-mute">Hunt & Sessão</div>
                      <div>
                        Hunt: <b className="text-fg">{acc.huntName ?? acc.hunt?.slug ?? "—"}</b>
                        {acc.hunt && ` · ${fmtShort(acc.hunt.kills)} abates · ${fmtDuration(acc.hunt.minutes)}`}
                      </div>
                      <div>
                        Tempo de sessão: <b className="tnum text-fg">{fmtSessionClock(acc.session?.startedAt)}</b>
                      </div>
                      {acc.captured && (
                        <div>
                          Pokémons: <b className="tnum text-fg">{fmtShort(acc.captured.total)}</b> · Sessão:{" "}
                          <b className="tnum text-poke-green">{acc.captured.session}</b> capturados /{" "}
                          <b className="tnum text-poke-red">{acc.captured.failed}</b> falhas
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ABA 2: EQUIPE & POKÉMONS */}
              {tab === "equipe" && (
                <div className="space-y-4">
                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold uppercase tracking-wide text-poke-gold">
                        Equipe Atual ({team.length})
                      </h3>
                      <span className="text-xs text-mute">Clique em qualquer Pokémon para abrir a ficha completa</span>
                    </div>
                    {team.length > 0 ? (
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {team.map((m, idx) => (
                          <TeamCard key={m.id ?? idx} mon={m} onOpenSheet={openMonSheet} />
                        ))}
                      </div>
                    ) : (
                      <p className="rounded-xl border border-dashed border-line py-6 text-center text-xs text-mute">
                        Nenhum Pokémon da equipe carregado ainda.
                      </p>
                    )}
                  </section>

                  <section className="space-y-2.5 border-t border-line pt-3">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-mute">
                      Melhores Pokémons da Conta (por Poder)
                    </h3>
                    <AllAccountPokemons accId={accId} onOpenSheet={openMonSheet} />
                  </section>
                </div>
              )}

              {/* ABA 3: AUTOMAÇÃO */}
              {tab === "automacao" && (
                <div className="space-y-4">
                  <p className="text-xs text-mute">
                    Todas as alterações aqui são aplicadas <b>em tempo real</b> sem desconectar a conta.
                  </p>
                  {auto ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <ToggleRow
                          label="Captura automática"
                          desc="Lança Pokébolas automaticamente nos selvagens derrotados (não precisa de VIP)."
                          checked={auto.autoCatch}
                          disabled={busyKey === "autoCatch"}
                          onToggle={() => void toggleAuto("autoCatch", { autoCatch: !auto.autoCatch })}
                        />
                        <ToggleRow
                          label={`Cura automática no jogo (≤ ${auto.hpLimiarPct ?? 40}% HP)`}
                          desc="Usa a poção equipada automaticamente quando o HP cair abaixo da % definida."
                          checked={auto.gameAutoPotion}
                          disabled={busyKey === "gameAutoPotion" || acc.status !== "online"}
                          onToggle={() => void toggleAuto("gameAutoPotion", { gameAutoPotion: !auto.gameAutoPotion })}
                        />
                        <ToggleRow
                          label={`Autocompra de Poções (< ${auto.potionThreshold} → +${auto.potionQty})`}
                          desc={`Compra ${auto.potionQty} un. quando o estoque ficar abaixo de ${auto.potionThreshold}${auto.goldReserve > 0 ? ` · piso ${fmtShort(auto.goldReserve)}g` : ""}.`}
                          checked={auto.autoPotion}
                          disabled={busyKey === "autoPotion"}
                          onToggle={() => void toggleAuto("autoPotion", { autoPotion: !auto.autoPotion })}
                        />
                        <ToggleRow
                          label={`Autocompra de Pokébolas (< ${auto.ballThreshold} → +${auto.ballQty})`}
                          desc={`Compra ${auto.ballQty} un. quando o estoque ficar abaixo de ${auto.ballThreshold}${auto.goldReserve > 0 ? ` · piso ${fmtShort(auto.goldReserve)}g` : ""}.`}
                          checked={auto.autoBallRestock}
                          disabled={busyKey === "autoBallRestock"}
                          onToggle={() => void toggleAuto("autoBallRestock", { autoBallRestock: !auto.autoBallRestock })}
                        />
                        <ToggleRow
                          label="Fallback automático de Poção"
                          desc="Se a poção equipada zerar, troca para a próxima poção disponível na mochila."
                          checked={auto.autoPotionFallback}
                          disabled={busyKey === "autoPotionFallback"}
                          onToggle={() =>
                            void toggleAuto("autoPotionFallback", { autoPotionFallback: !auto.autoPotionFallback })
                          }
                        />
                        <ToggleRow
                          label={`Auto-Centro de emergência (≤ ${auto.autoCenterHpPct}% HP)`}
                          desc="Vai ao Centro Pokémon se ficar sem poções e o HP cair demais."
                          checked={auto.autoCenter}
                          disabled={busyKey === "autoCenter"}
                          onToggle={() => void toggleAuto("autoCenter", { autoCenter: !auto.autoCenter })}
                        />
                        <ToggleRow
                          label="PVP Ranqueado automático"
                          desc="Entra automaticamente na fila do PVP ranqueado."
                          checked={auto.pvpAuto}
                          disabled={busyKey === "pvpAuto"}
                          onToggle={() => void toggleAuto("pvpAuto", { pvpAuto: !auto.pvpAuto })}
                        />
                      </div>

                      {/* Ajuste numérico de % de cura e quantidades de recompra */}
                      <div className="space-y-3 rounded-xl border border-edge/60 bg-void/50 p-3.5">
                        <h3 className="text-xs font-bold uppercase tracking-wide text-poke-gold">
                          Limiares & Quantidades (aplica em tempo real)
                        </h3>

                        {/* % da cura automática do jogo */}
                        <div className="space-y-1.5 rounded-lg border border-line bg-tile p-3">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-bold text-fg">Usar poção quando HP ficar abaixo de:</span>
                            <span className="tnum rounded bg-void px-2 py-0.5 text-sm font-extrabold text-poke-green">
                              {autoDraft.hpLimiarPct}%
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min={10}
                              max={95}
                              step={5}
                              value={Math.min(95, Math.max(10, Number(autoDraft.hpLimiarPct || 40)))}
                              onChange={(e) => setAutoDraft({ ...autoDraft, hpLimiarPct: e.target.value })}
                              className="flex-1 accent-[#f3c04a]"
                            />
                            <input
                              type="number"
                              min={10}
                              max={95}
                              value={autoDraft.hpLimiarPct}
                              onChange={(e) => setAutoDraft({ ...autoDraft, hpLimiarPct: e.target.value.replace(/\D/g, "") })}
                              className="field w-20 text-center text-sm font-bold"
                            />
                          </div>
                          <p className="text-[11px] text-mute">
                            Controla o gatilho oficial de cura do jogo (<code>hpLimiar</code>, de 10% a 95%).
                          </p>
                        </div>

                        {/* Quantidades de Poção, Bola, Piso de Ouro e Auto-Centro */}
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Poção: repor abaixo de</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.potionThreshold}
                              onChange={(e) => setAutoDraft({ ...autoDraft, potionThreshold: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Poção: comprar qtd</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.potionQty}
                              onChange={(e) => setAutoDraft({ ...autoDraft, potionQty: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Auto-Centro (% HP)</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.autoCenterHpPct}
                              onChange={(e) => setAutoDraft({ ...autoDraft, autoCenterHpPct: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Bola: repor abaixo de</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.ballThreshold}
                              onChange={(e) => setAutoDraft({ ...autoDraft, ballThreshold: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Bola: comprar qtd</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.ballQty}
                              onChange={(e) => setAutoDraft({ ...autoDraft, ballQty: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold text-mute">Reserva mín. de Gold</span>
                            <input
                              className="field w-full text-sm"
                              inputMode="numeric"
                              value={autoDraft.goldReserve}
                              onChange={(e) => setAutoDraft({ ...autoDraft, goldReserve: e.target.value.replace(/\D/g, "") })}
                            />
                          </label>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={busyKey === "saveNums"}
                            onClick={async () => {
                              setBusyKey("saveNums");
                              setMsg(null);
                              try {
                                const patch: AutomationPatch = {
                                  potionThreshold: Number(autoDraft.potionThreshold || 10),
                                  potionQty: Math.max(1, Number(autoDraft.potionQty || 100)),
                                  ballThreshold: Number(autoDraft.ballThreshold || 10),
                                  ballQty: Math.max(1, Number(autoDraft.ballQty || 100)),
                                  goldReserve: Number(autoDraft.goldReserve || 0),
                                  autoCenterHpPct: Math.min(80, Math.max(5, Number(autoDraft.autoCenterHpPct || 20))),
                                  ...(acc.status === "online"
                                    ? { hpLimiarPct: Math.min(95, Math.max(10, Number(autoDraft.hpLimiarPct || 40))) }
                                    : {}),
                                };
                                await actions.setAutomation(accId, patch);
                                setMsg({
                                  tone: "ok",
                                  text:
                                    acc.status === "online"
                                      ? "Limiares, % de cura e quantidades aplicados em tempo real!"
                                      : "Quantidades salvas! (A % de cura no jogo só pode ser enviada quando a conta estiver online.)",
                                });
                              } catch (e) {
                                setMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao salvar parâmetros" });
                              } finally {
                                setBusyKey(null);
                              }
                            }}
                            className="btn border-0 bg-poke-gold px-4 py-1.5 text-xs font-bold text-void hover:bg-[#f6ca5e]"
                          >
                            {busyKey === "saveNums" ? "Aplicando…" : "Salvar parâmetros"}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-mute">Dados de automação indisponíveis.</p>
                  )}
                </div>
              )}

              {/* ABA 4: INVENTÁRIO */}
              {tab === "inventario" && (
                <div className="space-y-4">
                  <section className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-poke-gold">Pokébolas</h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {(acc.inventory?.balls ?? []).map((b) => (
                        <div key={b.id} className="flex items-center gap-2 rounded-lg border border-line bg-tile px-2.5 py-2">
                          <ItemSprite icon={b.icon} size={26} alt={b.name} />
                          <div className="min-w-0">
                            <div className="truncate text-xs font-bold">{b.name}</div>
                            <div className="tnum text-xs text-mute">×{fmtShort(b.qty)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-mute">
                      Itens ({acc.inventory?.items.length ?? 0})
                    </h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {(acc.inventory?.items ?? []).slice(0, 30).map((it) => (
                        <div key={it.id} className="flex items-center gap-2 rounded-lg border border-line bg-void/60 px-2.5 py-1.5">
                          <ItemSprite icon={it.icon} size={24} alt={it.name} />
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold">{it.name}</div>
                            <div className="tnum text-[11px] text-mute">×{fmtShort(it.qty)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}

              {/* ABA 5: CAPTURAS DA CONTA */}
              {tab === "capturas" && <CapturesView fixedAccount={accId} compact />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
