import { AnimatePresence, motion } from "framer-motion";
import {
  Crosshair,
  ExternalLink,
  HeartPulse,
  Pause,
  Play,
  Radio,
  ShieldAlert,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ItemSprite, PokemonSprite, ShinyMark } from "@/components/Sprites";
import { StatusPill } from "@/components/StatusPill";
import { AnimatedNumber } from "@/components/ui";
import { actions, type AccountLive, type LiveEvent, type LiveSlot } from "@/lib/actions";
import { useAccount } from "@/lib/telemetry";
import { usePauseToggle } from "@/lib/usePauseToggle";
import { fmtDuration, fmtShort } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

function hpColor(pct: number) {
  return pct > 50 ? "#6fd47c" : pct > 20 ? "#f3c04a" : "#ef6b5b";
}

function fmtAgo(tsMs: number, nowMs: number) {
  const s = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (s < 2) return "agora";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const SLOT_BADGE: Record<string, { label: string; cls: string }> = {
  fighting: { label: "Em combate", cls: "border-[#2f6b3a] bg-[#16301c] text-poke-green" },
  corpse: { label: "Derrotado", cls: "border-line bg-void text-mute" },
  caught: { label: "Capturado!", cls: "border-[#7a5a1c] bg-[#33260e] text-poke-gold" },
  escaped: { label: "Escapou", cls: "border-[#7a2f27] bg-[#32140f] text-poke-red" },
};

const BALL_LABELS: Record<number, string> = {
  1: "Poké Ball",
  2: "Great Ball",
  3: "Super Ball",
  4: "Ultra Ball",
  5: "Beast Ball",
};

function WildSlotCard({ slot }: { slot: LiveSlot }) {
  const badge = SLOT_BADGE[slot.state] ?? SLOT_BADGE.fighting;
  const hasHp = slot.hp != null && slot.maxHp != null && slot.maxHp > 0;
  const pct = hasHp ? Math.max(0, Math.min(100, (slot.hp! / slot.maxHp!) * 100)) : slot.state === "fighting" ? 100 : 0;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: slot.state === "corpse" || slot.state === "escaped" ? 0.72 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ duration: 0.2 }}
      className={`rounded-xl border p-2.5 ${
        slot.shiny
          ? "border-poke-gold/80 bg-[#2a1f0b]/90 shadow-[0_0_20px_-6px_rgba(243,192,74,.45)]"
          : slot.state === "caught"
            ? "border-[#2f6b3a] bg-[#132618]/90"
            : "border-line bg-tile"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="relative flex size-12 shrink-0 items-center justify-center rounded-lg border border-line bg-void">
          <PokemonSprite looktype={slot.looktype} species={slot.pokeId} size={44} shiny={slot.shiny} />
          <span className="tnum absolute -left-1 -top-1 rounded bg-void/95 px-1 text-[10px] font-bold text-mute ring-1 ring-line">
            #{slot.slot}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1 font-bold leading-tight">
              <span className="truncate text-sm" title={slot.inferred ? "Espécie estimada da hunt atual (aguardando confirmação exata do servidor)" : undefined}>
                {slot.inferred ? `~${slot.name}` : slot.name}
              </span>
              {slot.shiny && <ShinyMark />}
              {slot.level != null && <span className="tnum shrink-0 text-xs font-medium text-mute">Nv.{slot.level}</span>}
            </div>
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
              {badge.label}
            </span>
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/55">
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${pct}%`, backgroundColor: hpColor(pct) }}
                transition={{ duration: 0.35, ease: EASE }}
              />
            </div>
            {hasHp && (
              <span className="tnum shrink-0 text-[11px] font-semibold text-mute">
                {fmtShort(slot.hp!)}/{fmtShort(slot.maxHp!)}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-mute">
            {slot.lastMove && (
              <span>
                <b className="text-fg">{slot.lastMove}</b>
                {slot.lastDamage != null && slot.lastDamage > 0 && (
                  <span className="tnum ml-1 font-bold text-poke-red">-{fmtShort(slot.lastDamage)}</span>
                )}
              </span>
            )}
            {slot.ballName && (
              <span className={slot.state === "caught" ? "font-semibold text-poke-gold" : "text-mute"}>
                {slot.ballName}
                {slot.chance != null ? ` (${slot.chance}%)` : ""}
              </span>
            )}
            {slot.xp != null && slot.xp > 0 && <span className="tnum text-poke-green">+{fmtShort(slot.xp)} XP</span>}
            {slot.gold != null && slot.gold > 0 && <span className="tnum text-poke-gold">+{fmtShort(slot.gold)}g</span>}
            {slot.drops.length > 0 && (
              <span className="truncate font-semibold text-poke-gold">
                🎁 {slot.drops.map((d) => (d.qty > 1 ? `${d.qty}× ${d.name}` : d.name)).join(", ")}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function formatLiveEvent(ev: LiveEvent): string {
  const target = ev.name || (ev.slot != null ? `Selvagem #${ev.slot}` : "Selvagem");
  const shinyTag = ev.shiny ? "✨ " : "";
  switch (ev.kind) {
    case "attack": {
      const move = ev.move ? ` usou ${ev.move}` : " atacado";
      const dmg = ev.damage != null ? ` (-${fmtShort(ev.damage)})` : "";
      const hp = ev.hp != null ? ` · HP ${fmtShort(ev.hp)}` : "";
      return `⚔️ ${shinyTag}${target}${move}${dmg}${hp}`;
    }
    case "kill": {
      const parts: string[] = [];
      if (ev.xp) parts.push(`+${fmtShort(ev.xp)} XP`);
      if (ev.gold) parts.push(`+${fmtShort(ev.gold)}g`);
      if (ev.drops && ev.drops.length > 0) {
        parts.push(`🎁 ${ev.drops.map((d) => (d.qty > 1 ? `${d.qty}× ${d.name}` : d.name)).join(", ")}`);
      }
      return `💀 Derrotou ${shinyTag}${target}${ev.level ? ` Nv.${ev.level}` : ""}${parts.length ? ` (${parts.join(" · ")})` : ""}`;
    }
    case "ball": {
      const bname = (ev.ballId != null && BALL_LABELS[ev.ballId]) || "Bola";
      const ch = ev.chance != null ? ` · ${ev.chance}%` : "";
      return ev.caught
        ? `🎉 Capturou ${shinyTag}${target} com ${bname}${ch}!`
        : `💨 ${shinyTag}${target} escapou da ${bname}${ch}`;
    }
    case "flee":
      return `🏃 ${shinyTag}${target}${ev.level ? ` Nv.${ev.level}` : ""} fugiu`;
    case "hunt":
      return `🗺️ Entrou na hunt ${ev.name || ev.slug || "?"}`;
    case "buy":
      return `🛒 Comprou ${ev.qty ?? 1}× ${ev.name || "item"}${ev.cost ? ` (${fmtShort(ev.cost)}g)` : ""}`;
    case "buy_error":
      return `❌ Erro ao comprar ${ev.qty ?? 1}× ${ev.name || "item"}${ev.reason ? ` — ${ev.reason}` : ""}`;
    case "potion":
      return `🧪 Fallback de poção: trocou para ${ev.name || "outra poção"}${ev.qty ? ` (×${fmtShort(ev.qty)})` : ""}`;
    case "center":
      if (ev.reason === "morte") return `🏥 Foi ao Centro Pokémon (Pokémon derrotado)`;
      if (ev.reason === "desistencia") return `🏥 Foi ao Centro Pokémon (desistência do combate)`;
      if (ev.reason === "vitoria") return `🏥 Retornou ao Centro Pokémon após vitória`;
      return ev.manual
        ? `🏥 Enviado ao Centro Pokémon pelo painel`
        : `🏥 Auto-Centro de emergência (${ev.name || "Pokémon"} com ${ev.hpPct ?? "?"}% HP)`;
    default:
      return `${ev.kind}: ${target}`;
  }
}

function eventTone(ev: LiveEvent) {
  if (ev.shiny) return "border-poke-gold/50 bg-[#2a1f0b]/60 text-poke-gold";
  switch (ev.kind) {
    case "ball":
      return ev.caught
        ? "border-[#2f6b3a] bg-[#16301c]/60 text-poke-green"
        : "border-line bg-void/60 text-mute";
    case "kill":
      return "border-line bg-tile/70 text-fg";
    case "buy_error":
      return "border-[#7a2f27] bg-[#32140f]/80 text-poke-red";
    case "buy":
    case "potion":
    case "center":
      return "border-[#7a5a1c] bg-[#33260e]/50 text-poke-gold";
    case "hunt":
      return "border-edge/50 bg-tile text-poke-gold";
    default:
      return "border-line/70 bg-void/50 text-mute";
  }
}

export function LiveModal({ accId, open, onClose }: { accId: string; open: boolean; onClose: () => void }) {
  const acc = useAccount(accId);
  const [live, setLive] = useState<AccountLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pause = usePauseToggle(accId);
  const pauseBusy = pause.busy;
  const [centerBusy, setCenterBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inFlight = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const fetchLive = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await actions.live(accId);
      setLive(data);
      setError(null);
      setNowMs(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao carregar visão ao vivo");
    } finally {
      inFlight.current = false;
    }
  }, [accId]);

  useEffect(() => {
    if (!open) return;
    void fetchLive();
    const timer = window.setInterval(() => void fetchLive(), 800);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, fetchLive]);

  const sendToCenter = async (force?: "rope" | "forfeit") => {
    setCenterBusy(true);
    setError(null);
    try {
      await actions.goCenter(accId, force);
      await fetchLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível ir ao Centro Pokémon");
    } finally {
      setCenterBusy(false);
    }
  };

  // Mesmo Pausar/Retomar do card e dos detalhes (inclui recalcular o Auto-Hunt antes de retomar).
  const togglePause = async () => {
    if (await pause.setPaused(!(live?.paused ?? acc?.paused ?? false))) await fetchLive();
  };

  const pauseAndOpenGame = async () => {
    if (!(live?.paused ?? acc?.paused)) {
      if (!(await pause.setPaused(true))) return;
      await fetchLive();
    }
    window.open("https://pokeidle.io/app", "_blank", "noopener,noreferrer");
  };

  if (typeof document === "undefined") return null;

  const isPaused = Boolean(live?.paused ?? acc?.paused);
  const isOnline = acc?.status === "online" && !isPaused;
  const pk = live?.pokemon ?? acc?.pokemon ?? null;
  const pkHpPct = pk && pk.maxHp > 0 ? Math.max(0, Math.min(100, (pk.hp / pk.maxHp) * 100)) : 0;
  const slots = live?.slots ?? [];
  const events = live?.events ?? [];

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
            aria-label={`Ao vivo — ${acc?.nick ?? live?.nick ?? accId}`}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97, transition: { duration: 0.15 } }}
            transition={{ duration: 0.24, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="card flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden p-0"
          >
            {/* Topo do modal */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-tile/70 px-3.5 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-wider ${
                    isOnline
                      ? "border-[#7a2f27] bg-[#32140f] text-poke-red"
                      : isPaused
                        ? "border-[#7a5a1c] bg-[#33260e] text-poke-gold"
                        : "border-line bg-void text-mute"
                  }`}
                >
                  <Radio className={`size-3.5 ${isOnline ? "animate-pulse" : ""}`} aria-hidden />
                  {isOnline ? "Ao Vivo" : isPaused ? "Pausada" : "Offline"}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-base font-extrabold leading-tight sm:text-lg">
                    {acc?.nick ?? live?.nick ?? accId}
                    {acc?.map && (
                      <span className="ml-2 text-xs font-semibold text-poke-gold">{acc.map.label}</span>
                    )}
                  </h2>
                  <p className="truncate text-xs text-mute">
                    {(live?.location ?? acc?.location)?.inCenter ? (
                      <span className="font-semibold text-poke-green">🏥 No Centro Pokémon (seguro, fora de combate)</span>
                    ) : (live?.location ?? acc?.location) && !(live?.location ?? acc?.location)?.inHunt ? (
                      <>
                        Local: <b className="text-fg">{(live?.location ?? acc?.location)?.label}</b>
                      </>
                    ) : live?.hunt ? (
                      <>
                        Hunt <b className="text-fg">{live.hunt.name}</b>
                        {live.hunt.kills > 0 && <> · {fmtShort(live.hunt.kills)} abates</>}
                        {live.hunt.minutes > 0 && <> · {fmtDuration(live.hunt.minutes)}</>}
                      </>
                    ) : (
                      "Aguardando dados da hunt…"
                    )}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                {acc && <StatusPill status={acc.status} />}
                {isOnline && !(live?.location ?? acc?.location)?.inCenter && (
                  <button
                    type="button"
                    onClick={() => void sendToCenter()}
                    disabled={centerBusy || (live?.combatLockMs ?? 0) > 0}
                    title={
                      (live?.combatLockMs ?? 0) > 0
                        ? "Aguarde a trava de combate acabar para ir ao Centro Pokémon"
                        : "Enviar esta conta ao Centro Pokémon para curar"
                    }
                    className="btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold disabled:opacity-50"
                  >
                    <HeartPulse className="size-3.5 text-poke-red" aria-hidden />
                    <span className="hidden sm:inline">{centerBusy ? "Indo…" : "Centro"}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void togglePause()}
                  disabled={pauseBusy}
                  className={`btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold ${
                    isPaused
                      ? "border-[#2f6b3a] bg-[#16301c] text-poke-green hover:bg-[#1e4226]"
                      : "border-[#7a5a1c] bg-[#33260e] text-poke-gold hover:bg-[#463413]"
                  }`}
                >
                  {isPaused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                  {pauseBusy ? "Aguarde…" : isPaused ? "Retomar" : "Pausar"}
                </button>
                <button
                  type="button"
                  onClick={() => void pauseAndOpenGame()}
                  disabled={pauseBusy}
                  title="Pausa esta conta no manager (evitando desconexão 4001) e abre pokeidle.io/app em uma nova aba"
                  className="btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold"
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">Pausar e abrir jogo</span>
                  <span className="sm:hidden">Abrir jogo</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Fechar"
                  className="btn p-1.5 text-mute hover:text-fg"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </div>

            {/* Corpo rolável */}
            <div className="flex-1 space-y-4 overflow-y-auto p-3.5 sm:p-5">
              {(error || pause.error) && (
                <div className="rounded-lg border border-[#7a2f27] bg-[#32140f] px-3 py-2 text-xs font-semibold text-poke-red">
                  {pause.error ?? error}
                </div>
              )}

              {isPaused && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#7a5a1c] bg-[#33260e]/80 px-3.5 py-2.5 text-xs text-poke-gold sm:text-sm">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden />
                    <span>
                      Conta pausada manualmente. O bot não vai reconectar sozinho — você pode abrir{" "}
                      <b>pokeidle.io/app</b> no navegador sem tomar <b>4001 (login externo)</b>.
                    </span>
                  </div>
                </div>
              )}

              {/* Arena de Batalha: Seu Pokémon vs Selvagens */}
              <div className="grid gap-3 lg:grid-cols-[270px_1fr]">
                {/* Seu Pokémon Ativo */}
                <section className="rounded-xl border border-edge/60 bg-tile p-3.5">
                  <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-mute">
                    <span>Seu Pokémon</span>
                    {live && live.combatLockMs > 0 && (
                      <span className="tnum rounded bg-[#33260e] px-1.5 py-0.5 text-[10px] text-poke-gold">
                        Combate {Math.ceil(live.combatLockMs / 1000)}s
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <div
                      className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-edge"
                      style={{ background: "radial-gradient(circle at 50% 35%, #4a3519, #1a120a 75%)" }}
                    >
                      <PokemonSprite looktype={pk?.looktype} size={54} shiny={pk?.shiny} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 font-extrabold leading-tight">
                        <span className="truncate text-base">{pk?.name ?? "—"}</span>
                        {pk?.shiny && <ShinyMark />}
                      </div>
                      <div className="tnum mt-0.5 text-xs text-mute">
                        {pk?.level != null ? `Pokémon Nv. ${fmtShort(pk.level)}` : "Sem Pokémon ativo"}
                        {acc && <> · Trein. Nv. {fmtShort(acc.level)}</>}
                      </div>
                    </div>
                  </div>

                  {/* Barra de HP */}
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-semibold text-mute">HP</span>
                      <span className="tnum font-bold">
                        {pk ? `${fmtShort(pk.hp)} / ${fmtShort(pk.maxHp)}` : "—"}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-black/55">
                      <motion.div
                        className="h-full rounded-full"
                        animate={{ width: `${pkHpPct}%`, backgroundColor: hpColor(pkHpPct) }}
                        transition={{ duration: 0.4, ease: EASE }}
                      />
                    </div>
                  </div>

                  {/* Equipados e taxas */}
                  {acc && (
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-2.5 text-xs">
                      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-void/60 px-2 py-1.5">
                        <ItemSprite icon={acc.equipped?.potion?.icon} size={20} alt="" />
                        <span className="tnum truncate font-bold">×{fmtShort(acc.equipped?.potion?.qty ?? acc.potions)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg border border-line bg-void/60 px-2 py-1.5">
                        <ItemSprite icon={acc.equipped?.ball?.icon} size={20} alt="" />
                        <span className="tnum truncate font-bold">×{fmtShort(acc.equipped?.ball?.qty ?? acc.balls)}</span>
                      </div>
                      <div className="rounded-lg border border-line bg-void/60 px-2 py-1.5">
                        <div className="text-[10px] text-mute">XP/h</div>
                        <div className="tnum font-bold text-poke-green">
                          +<AnimatedNumber value={acc.xpPerHour} />
                        </div>
                      </div>
                      <div className="rounded-lg border border-line bg-void/60 px-2 py-1.5">
                        <div className="text-[10px] text-mute">Ouro/h</div>
                        <div className="tnum font-bold text-poke-gold">
                          +<AnimatedNumber value={acc.goldPerHour} />
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                {/* Campo de Batalha (Selvagens) */}
                <section className="rounded-xl border border-line bg-void/50 p-3.5">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-mute">
                      <Swords className="size-3.5 text-poke-gold" aria-hidden />
                      <span>Campo de Batalha ({slots.length})</span>
                    </div>
                    <span className="text-[11px] text-mute">Atualiza a cada 1s sem desconectar o bot</span>
                  </div>

                  {slots.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <AnimatePresence initial={false}>
                        {slots.map((s) => (
                          <WildSlotCard key={s.slot} slot={s} />
                        ))}
                      </AnimatePresence>
                    </div>
                  ) : (
                    <div className="flex min-h-[152px] flex-col items-center justify-center rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-mute">
                      <Sparkles className="mb-1.5 size-5 text-poke-gold/70" aria-hidden />
                      {isPaused ? (
                        <p>Conta pausada. Clique em <b>Retomar bot</b> para acompanhar as batalhas ao vivo novamente.</p>
                      ) : (
                        <p>
                          Aguardando o próximo frame de combate do servidor…
                          <br />
                          Assim que o Pokémon atacar ou derrotar um selvagem, os alvos aparecem aqui em tempo real.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Spawns da Hunt */}
                  {live?.hunt && live.hunt.species.length > 0 && (
                    <div className="mt-3 border-t border-line pt-2.5">
                      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-mute">
                        <Crosshair className="size-3.5 text-poke-gold" aria-hidden />
                        <span>Spawns da Hunt ({live.hunt.name})</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {live.hunt.species.map((sp) => (
                          <span
                            key={sp.pokeId}
                            className="inline-flex items-center gap-1 rounded-full border border-line bg-tile px-2 py-0.5 text-xs font-semibold"
                          >
                            <PokemonSprite looktype={sp.looktype} species={sp.pokeId} size={20} />
                            <span>{sp.name}</span>
                            {sp.points > 0 && <span className="tnum text-[10px] text-mute">×{sp.points}</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </div>

              {/* Feed de Combate em Tempo Real */}
              <section className="rounded-xl border border-line bg-void/40 p-3.5">
                <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-mute">
                  <span>Feed em Tempo Real</span>
                  <span className="tnum">{events.length} eventos recentes</span>
                </div>
                {events.length > 0 ? (
                  <ul className="max-h-52 space-y-1.5 overflow-y-auto pr-1 text-xs">
                    {events.map((ev, i) => (
                      <li
                        key={ev.id ?? `${ev.ts}-${i}`}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${eventTone(ev)}`}
                      >
                        <span className="min-w-0 truncate font-medium">{formatLiveEvent(ev)}</span>
                        <span className="tnum shrink-0 text-[10px] opacity-75">{fmtAgo(ev.ts, nowMs)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-3 text-center text-xs text-mute">Nenhum evento registrado ainda nesta sessão.</p>
                )}
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
