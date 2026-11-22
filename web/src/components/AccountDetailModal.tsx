import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bot,
  CalendarClock,
  ExternalLink,
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
import { FeaturesTab } from "@/components/FeaturesTab";
import { PokemonSprite, ShinyMark } from "@/components/Sprites";
import { StatusPill } from "@/components/StatusPill";
import { actions, useHuntCatalog, type AutomationPatch, type Hunt } from "@/lib/actions";
import { HUNT_PRIORITIES, HUNT_REGIONS, huntModeOf, type HuntMode } from "@/lib/automation";
import { computeBestHuntSlug, type HuntOrder } from "@/lib/huntAdvisor";
import { usePokemons } from "@/lib/api";
import { goToTab } from "@/lib/nav";
import { accountNumber, useSheet } from "@/lib/sheet";
import { serverNow, useAccount } from "@/lib/telemetry";
import type { AccountAutomation, TeamPokemon } from "@/lib/types";
import { usePauseToggle } from "@/lib/usePauseToggle";
import { fmtShort } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

export type DetailTab = "geral" | "equipe" | "automacao" | "rotinas";

// Inventário e Capturas da conta ficam nas abas globais (filtradas pela conta): veja os atalhos da Visão Geral.
const TABS: { id: DetailTab; label: string; Icon: typeof Activity }[] = [
  { id: "geral", label: "Visão Geral", Icon: Activity },
  { id: "equipe", label: "Equipe & Pokémons", Icon: Swords },
  { id: "automacao", label: "Automação", Icon: Bot },
  { id: "rotinas", label: "Rotinas", Icon: CalendarClock },
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
  children,
}: {
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** Ajustes que pertencem a este toggle (limiar/quantidade), mostrados logo abaixo dele. */
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-tile px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold leading-tight text-fg">{label}</div>
          <div className="mt-0.5 text-xs text-mute">{desc}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
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
      {children && <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-line/70 pt-2.5 sm:grid-cols-3">{children}</div>}
    </div>
  );
}

/**
 * Campo numérico que aplica sozinho ao sair do campo (ou Enter), como os toggles: não há botão "Salvar".
 * O valor mostrado acompanha a telemetria enquanto o campo não está em edição.
 */
function NumField({
  label,
  value,
  min,
  max,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    let n = Number(draft === "" ? value : draft);
    if (!Number.isFinite(n)) n = value;
    n = Math.max(min, max != null ? Math.min(max, Math.round(n)) : Math.round(n));
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block truncate text-[11px] font-bold text-mute">{label}</span>
      <span className="relative block">
        <input
          className={`field w-full text-sm ${suffix ? "pr-7" : ""}`}
          inputMode="numeric"
          value={draft}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(String(value));
              e.stopPropagation();
            }
          }}
        />
        {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-mute">{suffix}</span>}
      </span>
    </label>
  );
}

function AutoGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-poke-gold">{title}</h3>
        {hint && <span className="text-[11px] text-mute">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const HUNT_MODES: { id: HuntMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Fica na hunt atual. Troque pelo Mapa ou Em massa (a troca manual fixa a hunt)." },
  { id: "fixa", label: "Fixa", hint: "Sempre volta para a hunt escolhida." },
  { id: "auto", label: "Automática", hint: "Vai para a melhor hunt do simulador do Mapa e acompanha o nível do Pokémon." },
];

/** Um único controle para a hunt: Manual, Fixa ou Automática (exclusivos entre si). */
function HuntModeSection({
  accId,
  auto,
  online,
  currentSlug,
  hunts,
  onMsg,
}: {
  accId: string;
  auto: AccountAutomation;
  online: boolean;
  currentSlug: string | null;
  hunts: Hunt[];
  onMsg: (m: { tone: "ok" | "error"; text: string } | null) => void;
}) {
  const mode = huntModeOf(auto);
  // "Fixa" escolhida sem hunt ainda: mostra o seletor e espera a escolha.
  const [uiMode, setUiMode] = useState<HuntMode | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setUiMode(null), [mode]);
  const shown = uiMode ?? mode;
  const prio = auto.autoBestHuntPriority || "xp";
  const reg = auto.autoBestHuntRegion || "all";
  const nameOf = (slug?: string | null) => hunts.find((h) => h.slug === slug)?.nome ?? slug ?? "";

  const apply = async (patch: AutomationPatch, okText: string) => {
    setBusy(true);
    onMsg(null);
    try {
      await actions.setAutomation(accId, patch);
      onMsg({ tone: "ok", text: okText });
    } catch (e) {
      onMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao trocar o modo de hunt" });
    } finally {
      setBusy(false);
    }
  };

  const applyAuto = async (p: string, r: string) => {
    setBusy(true);
    onMsg(null);
    try {
      const sim = online ? await computeBestHuntSlug(accId, p as HuntOrder, r).catch(() => null) : null;
      await actions.setAutomation(accId, {
        autoBestHunt: true,
        autoBestHuntPriority: p,
        autoBestHuntRegion: r,
        ...(sim?.slug ? { autoBestHuntSlug: sim.slug } : {}),
      });
      onMsg({ tone: "ok", text: sim?.nome ? `Hunt automática ligada: melhor hunt agora é ${sim.nome}.` : "Hunt automática ligada." });
    } catch (e) {
      onMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao ligar a hunt automática" });
    } finally {
      setBusy(false);
    }
  };

  const pick = (m: HuntMode) => {
    if (busy || m === shown) return;
    if (m === "manual") {
      setUiMode(null);
      void apply({ autoBestHunt: false, huntSlug: "" }, "Modo manual: a conta fica onde está até você trocar pelo Mapa.");
    } else if (m === "auto") {
      setUiMode(null);
      void applyAuto(prio, reg);
    } else {
      const slug = auto.huntSlug || currentSlug;
      if (slug) void apply({ huntSlug: slug }, `Hunt fixa: ${nameOf(slug)}.`);
      else setUiMode("fixa");
    }
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-edge/60 bg-void/50 p-3">
      <div className="flex rounded-xl border border-line bg-tile p-0.5" role="radiogroup" aria-label="Modo de hunt">
        {HUNT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={shown === m.id}
            disabled={busy}
            onClick={() => pick(m.id)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors disabled:opacity-60 sm:text-sm ${
              shown === m.id ? "bg-poke-gold text-void" : "text-mute hover:text-fg"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-mute">{HUNT_MODES.find((m) => m.id === shown)?.hint}</p>

      {shown === "fixa" && (
        <label className="block space-y-1">
          <span className="text-[11px] font-bold text-mute">Hunt fixa</span>
          <select
            className="field w-full text-xs sm:text-sm"
            disabled={busy}
            value={auto.huntSlug ?? ""}
            onChange={(e) => e.target.value && void apply({ huntSlug: e.target.value }, `Hunt fixa: ${nameOf(e.target.value)}.`)}
          >
            <option value="" disabled>
              — Escolha a hunt —
            </option>
            {hunts.map((h) => (
              <option key={h.slug} value={h.slug}>
                {h.nome} (Nv. {h.nivel} · {h.regiao || h.area})
              </option>
            ))}
          </select>
        </label>
      )}

      {shown === "auto" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-bold text-mute">Prioridade</span>
            <select className="field w-full text-xs sm:text-sm" disabled={busy} value={prio} onChange={(e) => void applyAuto(e.target.value, reg)}>
              {HUNT_PRIORITIES.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-bold text-mute">Região</span>
            <select className="field w-full text-xs sm:text-sm" disabled={busy} value={reg} onChange={(e) => void applyAuto(prio, e.target.value)}>
              {HUNT_REGIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {auto.autoBestHuntSlug && (
            <p className="text-xs text-mute sm:col-span-2">
              Melhor hunt agora: <b className="text-fg">{nameOf(auto.autoBestHuntSlug)}</b>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TeamCard({
  mon,
  online,
  activating,
  onActivate,
  onOpenSheet,
}: {
  mon: TeamPokemon;
  online: boolean;
  activating?: boolean;
  onActivate?: (id: number) => void;
  onOpenSheet: (id: number, el: Element) => void;
}) {
  const pct = mon.maxHp > 0 ? Math.max(0, Math.min(100, (mon.hp / mon.maxHp) * 100)) : 0;
  return (
    <div
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        mon.active ? "border-poke-gold/70 bg-[#2a1f0b]/60" : "border-line bg-tile hover:border-edge"
      }`}
    >
      <button
        type="button"
        disabled={!mon.id}
        onClick={(e) => mon.id && onOpenSheet(mon.id, e.currentTarget)}
        className="relative flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-void disabled:cursor-default"
        title="Ver ficha completa"
      >
        <PokemonSprite looktype={mon.looktype} species={mon.speciesId} size={48} shiny={mon.shiny} />
        {mon.active && (
          <span className="absolute -bottom-1 rounded bg-poke-gold px-1 py-0.5 text-[9px] font-black uppercase leading-none text-void">
            Ativo
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!mon.id}
            onClick={(e) => mon.id && onOpenSheet(mon.id, e.currentTarget)}
            className="flex min-w-0 items-center gap-1 font-extrabold hover:text-poke-gold disabled:cursor-default"
          >
            <span className="truncate text-sm sm:text-base">{mon.name}</span>
            {mon.shiny && <ShinyMark />}
          </button>
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
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-mute">
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
          <div className="ml-auto flex items-center gap-1.5">
            {!mon.active && mon.id && onActivate && (
              <button
                type="button"
                disabled={!online || activating}
                onClick={() => onActivate(mon.id!)}
                title={online ? `Deixar ${mon.name} como Pokémon ativo` : "A conta precisa estar online"}
                className="rounded border border-poke-gold/70 bg-[#33260e] px-2 py-0.5 text-[11px] font-bold text-poke-gold hover:bg-[#463413] disabled:opacity-50"
              >
                {activating ? "Ativando…" : "★ Deixar ativo"}
              </button>
            )}
            {mon.id && (
              <button
                type="button"
                onClick={(e) => onOpenSheet(mon.id!, e.currentTarget)}
                className="font-semibold text-poke-gold/90 hover:underline"
              >
                Ficha →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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
  initialTab = "geral",
}: {
  accId: string;
  open: boolean;
  onClose: () => void;
  onOpenLive: () => void;
  /** Aba aberta ao abrir o modal (ex.: o resumo de automações do card abre direto em "automacao"). */
  initialTab?: DetailTab;
}) {
  const acc = useAccount(accId);
  const { data: huntCatalog } = useHuntCatalog(open ? accId : null);
  const openSheet = useSheet();
  const pause = usePauseToggle(accId);
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setMsg(null);
    }
  }, [open, initialTab]);

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
  const online = acc.status === "online";
  const err = msg?.tone === "error" ? msg : pause.error ? { tone: "error" as const, text: pause.error } : null;
  const shownMsg = err ?? msg;

  const openMonSheet = (monId: number, el: Element) => {
    openSheet({ kind: "own", account: accNum, id: monId }, el);
  };

  const goGlobal = (t: "inventario" | "capturas" | "mapa") => {
    onClose();
    goToTab(t, t === "mapa" ? undefined : accId);
  };

  const activateMon = async (monId: number) => {
    setBusyKey(`active:${monId}`);
    setMsg(null);
    try {
      const r = await actions.setActivePokemon(accId, monId);
      setMsg({
        tone: "ok",
        text: r.confirmed ? "Pokémon ativo trocado com sucesso!" : "Pedido de troca enviado ao jogo.",
      });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Não foi possível ativar esse Pokémon" });
    } finally {
      setBusyKey(null);
    }
  };

  /** Tudo na aba Automação aplica na hora pelo mesmo caminho (toggles ao clicar, números ao sair do campo). */
  const applyAuto = async (key: string, patch: AutomationPatch, okText?: string) => {
    setBusyKey(key);
    setMsg(null);
    try {
      await actions.setAutomation(accId, patch);
      if (okText) setMsg({ tone: "ok", text: okText });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Erro ao atualizar automação" });
    } finally {
      setBusyKey(null);
    }
  };
  const flip = (key: keyof AutomationPatch & keyof AccountAutomation) => () => {
    if (!auto) return;
    void applyAuto(String(key), { [key]: !auto[key] } as AutomationPatch);
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

  const reviveName = auto?.reviveId === 206 ? "Max Revive" : "Revive";

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
                  {online && (
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
                    disabled={pause.busy}
                    title={pause.title}
                    onClick={() => {
                      setMsg(null);
                      void pause.toggle();
                    }}
                    className={`btn px-2.5 py-1.5 text-xs font-bold ${
                      pause.paused
                        ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
                        : "border-[#7a5a1c] bg-[#33260e] text-poke-gold"
                    }`}
                  >
                    {pause.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                    {pause.label}
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
              {shownMsg && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                    shownMsg.tone === "ok"
                      ? "border-[#2f6b3a] bg-[#16301c] text-poke-green"
                      : "border-[#7a2f27] bg-[#32140f] text-poke-red"
                  }`}
                >
                  {shownMsg.text}
                </div>
              )}

              {/* ABA 1: VISÃO GERAL (só o que o card não mostra) */}
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

                  {/* Conexão & Sessão */}
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1 rounded-xl border border-line bg-void/50 p-3 text-xs">
                      <div className="font-bold uppercase tracking-wide text-mute">Conexão</div>
                      {acc.proxy ? (
                        <div>
                          Proxy: <b className="text-fg">{`${acc.proxy.scheme}://${acc.proxy.host}:${acc.proxy.port}`}</b>
                          {acc.proxy.exitIp && (
                            <>
                              {" "}· IP de saída <b className="tnum text-poke-green">{acc.proxy.exitIp}</b>
                            </>
                          )}
                        </div>
                      ) : (
                        <div>Sem proxy (IP do servidor).</div>
                      )}
                      {acc.lastReason ? <div className="text-poke-gold">Último aviso: {acc.lastReason}</div> : <div className="text-mute">Sem avisos recentes.</div>}
                    </div>
                    <div className="space-y-1 rounded-xl border border-line bg-void/50 p-3 text-xs">
                      <div className="font-bold uppercase tracking-wide text-mute">Sessão</div>
                      <div>
                        Tempo de sessão: <b className="tnum text-fg">{fmtSessionClock(acc.session?.startedAt)}</b>
                      </div>
                      {acc.captured && (
                        <div>
                          Capturas na sessão: <b className="tnum text-poke-green">{acc.captured.session}</b> ·{" "}
                          <b className="tnum text-poke-red">{acc.captured.failed}</b> falhas
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Boosts ativos */}
                  {acc.boosts && acc.boosts.length > 0 && (
                    <div className="space-y-2 rounded-xl border border-[#7a5a1c]/70 bg-[#2a1f0b]/50 p-3">
                      <div className="text-xs font-bold uppercase tracking-wide text-poke-gold">
                        ⚡ Boosts Ativos ({acc.boosts.length})
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {acc.boosts.map((b) => {
                          const sec = b.expiresAt ? Math.max(0, Math.floor((b.expiresAt - serverNow()) / 1000)) : null;
                          const left =
                            sec == null
                              ? null
                              : sec < 60
                                ? "<1m"
                                : sec < 3600
                                  ? `${Math.floor(sec / 60)}m`
                                  : sec < 86400
                                    ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
                                    : `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
                          return (
                            <div
                              key={b.key}
                              className="inline-flex items-center gap-2 rounded-lg border border-[#7a5a1c] bg-tile px-2.5 py-1.5 text-xs"
                            >
                              {b.icon ? (
                                <img src={b.icon} alt="" width={20} height={20} className="size-5 object-contain [image-rendering:pixelated]" />
                              ) : (
                                <span aria-hidden>⚡</span>
                              )}
                              <div>
                                <div className="font-bold text-fg">
                                  {b.name}
                                  {b.detail && <span className="ml-1 text-poke-gold">{b.detail}</span>}
                                </div>
                                {left && <div className="tnum text-[11px] text-mute">Restam {left}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Atalhos para as abas globais, já filtradas por esta conta */}
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="btn text-xs font-bold" onClick={() => goGlobal("inventario")}>
                      <Package className="size-3.5 text-poke-gold" aria-hidden />
                      Inventário desta conta
                      <ExternalLink className="size-3 text-mute" aria-hidden />
                    </button>
                    <button type="button" className="btn text-xs font-bold" onClick={() => goGlobal("capturas")}>
                      <Target className="size-3.5 text-poke-gold" aria-hidden />
                      Capturas desta conta
                      <ExternalLink className="size-3 text-mute" aria-hidden />
                    </button>
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
                          <TeamCard
                            key={m.id ?? idx}
                            mon={m}
                            online={online}
                            activating={busyKey === `active:${m.id}`}
                            onActivate={activateMon}
                            onOpenSheet={openMonSheet}
                          />
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

              {/* ABA 3: AUTOMAÇÃO (fonte única das automações da conta) */}
              {tab === "automacao" && (
                <div className="space-y-4">
                  <p className="text-xs text-mute">
                    Tudo aqui vale <b className="text-fg">na hora</b>, sem desconectar a conta: os botões ao clicar e os números ao sair do campo (ou Enter).
                  </p>
                  {auto ? (
                    <>
                      <AutoGroup title="Hunt">
                        <HuntModeSection
                          accId={accId}
                          auto={auto}
                          online={online}
                          currentSlug={acc.hunt?.slug ?? null}
                          hunts={huntCatalog?.hunts ?? []}
                          onMsg={setMsg}
                        />
                      </AutoGroup>

                      <AutoGroup title="Combate">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <ToggleRow
                            label={`Cura automática no jogo (≤ ${auto.hpLimiarPct ?? 40}% HP)`}
                            desc={online ? "Usa a poção equipada quando o HP cair abaixo da % (ajuste em Avançado)." : "Precisa da conta online."}
                            checked={auto.gameAutoPotion}
                            disabled={busyKey === "gameAutoPotion" || !online}
                            onToggle={flip("gameAutoPotion")}
                          />
                          <ToggleRow
                            label="Usar Revive ao desmaiar (jogo)"
                            desc={online ? `Usa ${reviveName} automaticamente quando o Pokémon desmaiar.` : "Precisa da conta online."}
                            checked={Boolean(auto.gameAutoRevive)}
                            disabled={busyKey === "gameAutoRevive" || !online}
                            onToggle={flip("gameAutoRevive")}
                          />
                          <ToggleRow
                            label="Fallback de poção"
                            desc="Se a poção equipada zerar, troca para a próxima poção da mochila."
                            checked={auto.autoPotionFallback}
                            disabled={busyKey === "autoPotionFallback"}
                            onToggle={flip("autoPotionFallback")}
                          />
                          <ToggleRow
                            label={`Auto-Centro de emergência (≤ ${auto.autoCenterHpPct}% HP)`}
                            desc="Vai ao Centro Pokémon se ficar sem poções e o HP cair demais."
                            checked={auto.autoCenter}
                            disabled={busyKey === "autoCenter"}
                            onToggle={flip("autoCenter")}
                          />
                        </div>
                      </AutoGroup>

                      <AutoGroup
                        title="Loja / reposição"
                        hint={auto.goldReserve > 0 ? `Não compra com menos de ${fmtShort(auto.goldReserve)} gold (Avançado).` : "Sem piso de gold (Avançado)."}
                      >
                        <div className="space-y-2">
                          <ToggleRow
                            label="Repor poções"
                            desc={`Compra ${auto.potionQty} un. quando o estoque ficar abaixo de ${auto.potionThreshold}.`}
                            checked={auto.autoPotion}
                            disabled={busyKey === "autoPotion"}
                            onToggle={flip("autoPotion")}
                          >
                            <NumField label="Repor abaixo de" value={auto.potionThreshold} min={0} onCommit={(n) => void applyAuto("potionThreshold", { potionThreshold: n })} />
                            <NumField label="Comprar (qtd)" value={auto.potionQty} min={1} onCommit={(n) => void applyAuto("potionQty", { potionQty: n })} />
                          </ToggleRow>
                          <ToggleRow
                            label="Repor Pokébolas"
                            desc={`Compra ${auto.ballQty} un. quando o estoque ficar abaixo de ${auto.ballThreshold}.`}
                            checked={auto.autoBallRestock}
                            disabled={busyKey === "autoBallRestock"}
                            onToggle={flip("autoBallRestock")}
                          >
                            <NumField label="Repor abaixo de" value={auto.ballThreshold} min={0} onCommit={(n) => void applyAuto("ballThreshold", { ballThreshold: n })} />
                            <NumField label="Comprar (qtd)" value={auto.ballQty} min={1} onCommit={(n) => void applyAuto("ballQty", { ballQty: n })} />
                          </ToggleRow>
                          <ToggleRow
                            label={`Repor ${reviveName}`}
                            desc={`Compra ${auto.reviveQty ?? 20} un. quando o estoque ficar abaixo de ${auto.reviveThreshold ?? 5}.`}
                            checked={Boolean(auto.autoReviveRestock)}
                            disabled={busyKey === "autoReviveRestock"}
                            onToggle={flip("autoReviveRestock")}
                          >
                            <label className="block min-w-0 space-y-1">
                              <span className="block truncate text-[11px] font-bold text-mute">Revive (usar e comprar)</span>
                              <select
                                className="field w-full text-sm"
                                value={String(auto.reviveId ?? 205)}
                                disabled={busyKey === "reviveId"}
                                onChange={(e) => void applyAuto("reviveId", { reviveId: Number(e.target.value) })}
                              >
                                <option value="205">Revive (×{fmtShort(auto.reviveStock?.["205"] ?? 0)})</option>
                                <option value="206">Max Revive (×{fmtShort(auto.reviveStock?.["206"] ?? 0)})</option>
                              </select>
                            </label>
                            <NumField label="Repor abaixo de" value={auto.reviveThreshold ?? 5} min={0} onCommit={(n) => void applyAuto("reviveThreshold", { reviveThreshold: n })} />
                            <NumField label="Comprar (qtd)" value={auto.reviveQty ?? 20} min={1} onCommit={(n) => void applyAuto("reviveQty", { reviveQty: n })} />
                          </ToggleRow>
                        </div>
                      </AutoGroup>

                      <AutoGroup title="Outros">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <ToggleRow
                            label="Captura automática"
                            desc="Lança Pokébolas nos selvagens derrotados (não precisa de VIP)."
                            checked={auto.autoCatch}
                            disabled={busyKey === "autoCatch"}
                            onToggle={flip("autoCatch")}
                          />
                          <ToggleRow
                            label="Resgatar Passe de Batalha"
                            desc="Resgata os prêmios diários do Passe assim que virar o dia."
                            checked={Boolean(auto.autoPassClaim)}
                            disabled={busyKey === "autoPassClaim"}
                            onToggle={flip("autoPassClaim")}
                          />
                          <ToggleRow
                            label="PVP Ranqueado automático"
                            desc="Entra sozinho na fila do PVP ranqueado."
                            checked={auto.pvpAuto}
                            disabled={busyKey === "pvpAuto"}
                            onToggle={flip("pvpAuto")}
                          />
                        </div>
                      </AutoGroup>

                      <details className="group rounded-xl border border-line px-3 py-2.5">
                        <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-mute">Avançado</summary>
                        <div className="mt-3 space-y-2.5">
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            <NumField
                              label={online ? "Cura no jogo abaixo de" : "Cura no jogo (só online)"}
                              value={auto.hpLimiarPct ?? (auto.hpLimiar != null ? Math.round(auto.hpLimiar * 100) : 40)}
                              min={10}
                              max={95}
                              suffix="%"
                              disabled={!online}
                              onCommit={(n) => void applyAuto("hpLimiarPct", { hpLimiarPct: n }, `Cura automática agora em ${n}% de HP.`)}
                            />
                            <NumField label="Auto-Centro abaixo de" value={auto.autoCenterHpPct} min={5} max={80} suffix="%" onCommit={(n) => void applyAuto("autoCenterHpPct", { autoCenterHpPct: n })} />
                            <NumField label="Reserva mínima de gold" value={auto.goldReserve} min={0} onCommit={(n) => void applyAuto("goldReserve", { goldReserve: n })} />
                          </div>
                          <p className="text-[11px] text-mute">
                            Cura no jogo: 10% a 95% (gatilho oficial <code>hpLimiar</code>). Auto-Centro: 5% a 80%. Reserva de gold: 0 = sem piso; abaixo dela o bot não compra nada.
                          </p>
                          <ToggleRow
                            label="Voltar automático à hunt (jogo)"
                            desc="Opção do servidor: depois de desmaiar e curar no Centro, volta para a hunt. O Pausar desliga e o Retomar religa sozinho, então normalmente não precisa mexer aqui."
                            checked={Boolean(auto.autoVoltarHunt)}
                            disabled={busyKey === "autoVoltarHunt" || !online}
                            onToggle={flip("autoVoltarHunt")}
                          />
                        </div>
                      </details>
                    </>
                  ) : (
                    <p className="text-xs text-mute">Dados de automação indisponíveis.</p>
                  )}
                </div>
              )}

              {tab === "rotinas" && <FeaturesTab accId={accId} />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
