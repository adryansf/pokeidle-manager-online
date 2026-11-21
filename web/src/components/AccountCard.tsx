import { AnimatePresence, motion, useDragControls, type PanInfo } from "framer-motion";
import { ChevronDown, Clock, Crosshair, Crown, Globe, Heart, Info, MapPin, Pause, Play, Radio, Star, Swords } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AccountDetailModal } from "@/components/AccountDetailModal";
import { ItemSprite, PokemonSprite, ShinyMark } from "@/components/Sprites";
import { EquipPopover } from "@/components/EquipPopover";
import { LiveModal } from "@/components/LiveModal";
import { StatusPill } from "@/components/StatusPill";
import { XpMedallion, XpRace, XpSpark, XpVersus } from "@/components/XpMeters";
import { AnimatedNumber, Coin, GoldPerHourIcon } from "@/components/ui";
import { actions, type AutomationPatch } from "@/lib/actions";
import { computeBestHuntSlug, type HuntOrder } from "@/lib/huntAdvisor";
import { accountNumber, useSheet } from "@/lib/sheet";
import { serverNow, useAccount } from "@/lib/telemetry";
import type { EquippedItem } from "@/lib/types";
import { type CardStyle, useCardStyle } from "@/lib/cardStyle";
import { dragState, justDragged } from "@/lib/useCardOrder";
import { fmtDuration, fmtShort } from "@/lib/utils";
import type { AccountLocation, ActiveBoost, MapInfo, ProxyBadgeInfo } from "@/lib/types";

export type CardMode = "resumo" | "sessao";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Cronômetro HH:MM:SS desde o início da sessão (relógio do servidor). */
function SessionClock({ startedAt }: { startedAt: number | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (!startedAt) return <span>—</span>;
  const s = Math.max(0, Math.floor((serverNow() - startedAt) / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="tnum">
      {p(Math.floor(s / 3600))}:{p(Math.floor((s % 3600) / 60))}:{p(s % 60)}
    </span>
  );
}

// Itens raros acompanhados na sessão (ícones do próprio jogo).
// Rótulos iguais aos usados no backend (session_stats.ITEM_LABELS) e no webhook do Discord.
const SESSION_ITEMS = [
  { key: "boss", label: "Bronze Boss Token", icon: "/assets/site/assets/items/bronze_boss_token.png" },
  { key: "key", label: "Fragmento de Chave", icon: "/img/itens/fragmento-chave.png" },
  { key: "shinyStone", label: "Fragmento de Shiny Stone", icon: "/img/itens/shiny-stone.png" },
  { key: "bike", label: "Fragmento de Bicicleta", icon: "/img/itens/fragmento-bicicleta.png" },
] as const;

const prettySlug = (s?: string | null) =>
  s ? s.replace(/[_-]+/g, " ").replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase()) : "—";

/**
 * Bloco ícone + valor. Celular: uma linha compacta (ícone e valor, sem rótulo).
 * Desktop (sm+): ícone grande à esquerda, rótulo e valor empilhados.
 */
function Tile({
  icon,
  label,
  hint,
  children,
  className = "",
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
  /** Torna o bloco clicável (abre o seletor). Recebe o próprio elemento para ancorar o popover. */
  onPress?: (el: HTMLElement) => void;
}) {
  const press = onPress
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-haspopup": "dialog" as const,
        onClick: (e: React.MouseEvent<HTMLElement>) => !justDragged() && onPress(e.currentTarget),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPress(e.currentTarget);
          }
        },
      }
    : {};
  return (
    <motion.div
      title={hint ?? label}
      whileHover={{ y: -2, transition: { duration: 0.18, ease: EASE } }}
      whileTap={onPress ? { scale: 0.98 } : undefined}
      {...press}
      className={`${onPress ? "cursor-pointer hover:!border-edge " : ""}tile flex min-w-0 items-center gap-1.5 px-2 py-1.5 sm:grid sm:grid-cols-[auto_1fr] sm:grid-rows-[auto_auto] sm:gap-x-3 sm:gap-y-0.5 sm:px-3 sm:py-1.5 ${className}`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center sm:row-span-2 sm:size-9">{icon}</span>
      <div className="label hidden sm:block">{label}</div>
      <div className="min-w-0 truncate text-sm font-bold leading-tight sm:text-lg">{children}</div>
    </motion.div>
  );
}

/** Formata o tempo restante de um boost (ex.: "3d 4h", "2h 15m", "18m", "<1m"). */
function fmtBoostLeft(expiresAt?: number | null): string | null {
  if (!expiresAt) return null;
  const s = Math.max(0, Math.floor((expiresAt - serverNow()) / 1000));
  if (s <= 0) return null;
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

function BoostsBar({ boosts }: { boosts?: ActiveBoost[] }) {
  const [, tick] = useState(0);
  const hasTimed = Boolean(boosts?.some((b) => b.expiresAt));
  useEffect(() => {
    if (!hasTimed) return;
    const i = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, [hasTimed]);

  const active = (boosts ?? []).filter((b) => !b.expiresAt || b.expiresAt > serverNow());
  if (active.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-mute">Boosts</span>
      {active.map((b) => {
        const left = fmtBoostLeft(b.expiresAt);
        return (
          <span
            key={b.key}
            title={`${b.name}${b.detail ? ` (${b.detail})` : ""}${left ? ` · resta ${left}` : ""}`}
            className="inline-flex items-center gap-1 rounded-md border border-[#7a5a1c] bg-[#33260e]/80 px-1.5 py-0.5 text-[10px] font-bold leading-none text-poke-gold"
          >
            {b.icon ? (
              <img src={b.icon} alt="" width={14} height={14} className="size-3.5 object-contain [image-rendering:pixelated]" />
            ) : (
              <span aria-hidden>⚡</span>
            )}
            <span>{b.name}</span>
            {b.detail && <span className="opacity-85">{b.detail}</span>}
            {left && <span className="tnum rounded bg-black/35 px-1 py-0.5 text-[9px] text-fg">{left}</span>}
          </span>
        );
      })}
    </div>
  );
}

/** Mapa ou local atual da conta (Centro Pokémon, Arena de Boss, Safari, Casa, ou o Mapa da Hunt). */
function LocationChip({ location, map }: { location?: AccountLocation | null; map?: MapInfo | null }) {
  if (location && location.kind !== "hunt") {
    const styles: Record<string, { icon: string; cls: string }> = {
      center: { icon: "🏥", cls: "border-[#2f6b3a] bg-[#16301c] text-poke-green" },
      boss: { icon: "⚔️", cls: "border-[#7a2f27] bg-[#32140f] text-poke-red" },
      safari: { icon: "🌿", cls: "border-[#2f6b3a] bg-[#16301c] text-poke-green" },
      house: { icon: "🏠", cls: "border-edge/60 bg-tile text-fg" },
      mythic: { icon: "✨", cls: "border-poke-gold/70 bg-[#33260e] text-poke-gold" },
      idle: { icon: "⏸", cls: "border-line bg-void text-mute" },
    };
    const st = styles[location.kind] ?? { icon: "📍", cls: "border-line bg-void text-fg" };
    return (
      <span
        className={`inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-bold leading-none sm:text-sm ${st.cls}`}
        title={`Local atual: ${location.label}${location.detail ? ` (${location.detail})` : ""}`}
      >
        <span aria-hidden>{st.icon}</span>
        <span className="truncate">{location.label}</span>
      </span>
    );
  }
  return <MapChip map={map} />;
}

/** Mapa onde a conta caça. Em Outland mostra o nível dela e o multiplicador de itens raros (como no jogo). */
function MapChip({ map }: { map?: MapInfo | null }) {
  if (!map) return null;
  const o = map.outland;
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-bold leading-none sm:text-sm ${o ? "border-[#7a5a1c] bg-[#33260e] text-poke-gold" : "border-line bg-void text-fg"}`}
      title={o ? `${map.label}: itens raros ×${o.mult}` : `Mapa: ${map.label}`}
    >
      <MapPin className="size-3.5 shrink-0 sm:size-4" aria-hidden />
      <span className="truncate">{map.label}</span>
      {o && <span className="tnum font-semibold opacity-80">×{String(o.mult).replace(".", ",")}</span>}
    </span>
  );
}

/** Proxy vinculado à conta (mostra apelido da Central ou host:porta, e IP de saída no tooltip). */
function ProxyChip({ proxy }: { proxy?: ProxyBadgeInfo | null }) {
  if (!proxy) {
    return (
      <span
        className="inline-flex max-w-[160px] shrink-0 items-center gap-1 rounded-md border border-line bg-void/70 px-1.5 py-1 text-[11px] font-semibold leading-none text-mute sm:px-2 sm:text-xs"
        title="Conexão direta (sem proxy configurado — usa o IP do servidor)"
      >
        <Globe className="size-3 shrink-0 opacity-60 sm:size-3.5" aria-hidden />
        <span className="truncate">Direto</span>
      </span>
    );
  }
  const detail = `Proxy: ${proxy.scheme}://${proxy.host}:${proxy.port}${proxy.exitIp ? ` · IP de saída: ${proxy.exitIp}` : ""}`;
  return (
    <span
      className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-md border border-[#2f6b3a]/80 bg-[#16301c]/70 px-1.5 py-1 text-[11px] font-bold leading-none text-poke-green sm:px-2 sm:text-xs"
      title={detail}
    >
      <Globe className="size-3 shrink-0 sm:size-3.5" aria-hidden />
      <span className="truncate">{proxy.name}</span>
    </span>
  );
}

/** Bloco de número: ícone, rótulo e valor, sem moldura própria. */
function Stat({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-6 shrink-0 items-center justify-center sm:size-7">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-medium leading-none text-mute sm:text-xs">{label}</div>
        <div className="mt-0.5 truncate text-sm font-bold leading-tight sm:text-base">{children}</div>
      </div>
    </div>
  );
}

/** Celular: "x79". Desktop: "Golden Potion (x79)". Só no modelo Padrão. */
function Equipped({ item }: { item?: EquippedItem | null }) {
  if (!item) return <span className="text-mute">—</span>;
  return (
    <>
      <span className="hidden sm:inline">{item.name} </span>
      <span className="font-semibold text-mute sm:text-fg">
        <span className="sm:hidden">x</span>
        <span className="hidden sm:inline">(x</span>
        <AnimatedNumber value={item.qty} />
        <span className="hidden sm:inline">)</span>
      </span>
    </>
  );
}

/** Poção ou bola equipada como botão compacto; ao tocar abre o seletor para trocar. */
function EquipChip({ item, label, onPress, block = false }: { item?: EquippedItem | null; label: string; onPress?: (el: HTMLElement) => void; block?: boolean }) {
  return (
    <button
      type="button"
      disabled={!onPress}
      aria-haspopup="dialog"
      aria-label={item ? `${label}: ${item.name}, ${item.qty} unidades. Trocar` : `Escolher ${label.toLowerCase()}`}
      title={item ? `${label}: ${item.name}. Toque para trocar` : `Escolher ${label.toLowerCase()}`}
      onClick={(e) => !justDragged() && onPress?.(e.currentTarget)}
      className={`inline-flex min-h-10 min-w-0 items-center gap-1.5 rounded-full border border-line bg-tile py-1 pl-1.5 pr-2.5 text-sm font-bold transition-colors enabled:hover:border-edge enabled:active:scale-[.98] disabled:cursor-default ${block ? "w-full" : ""}`}
    >
      <ItemSprite icon={item?.icon} size={26} alt="" />
      {item ? (
        <>
          <span className="hidden min-w-0 truncate sm:inline">{item.name}</span>
          <span className="tnum shrink-0 text-mute sm:text-fg">×<AnimatedNumber value={item.qty} /></span>
        </>
      ) : (
        <span className="text-mute">—</span>
      )}
      {onPress && <ChevronDown className="ml-auto hidden size-3.5 shrink-0 text-mute min-[360px]:block" aria-hidden />}
    </button>
  );
}

function ResumoBody({ id, variant }: { id: string; variant: CardStyle }) {
  const acc = useAccount(id);
  const [picker, setPicker] = useState<{ kind: "ball" | "potion" | "revive"; anchor: DOMRect } | null>(null);
  if (!acc) return null;
  const potion = acc.equipped?.potion;
  const ball = acc.equipped?.ball;
  const revive = acc.equipped?.revive;
  const options = acc.equipped?.options;
  // Abates por hora da hunt atual (só depois de 1 minuto, para o número não oscilar no começo).
  const killsPerHour = acc.hunt && acc.hunt.minutes >= 1 ? Math.round(acc.hunt.kills / (acc.hunt.minutes / 60)) : null;
  const open = (kind: "ball" | "potion" | "revive") => (el: HTMLElement) => setPicker({ kind, anchor: el.getBoundingClientRect() });
  const pk = acc.pokemon;
  const trainer = { level: acc.level, bar: acc.xp, perHour: acc.xpPerHour };
  const mon = { level: pk?.level, bar: pk?.xp, name: pk?.name, fallbackPerHour: acc.xpPerHour };

  const xpHour = (
    <span className="text-poke-green">
      +<AnimatedNumber value={acc.xpPerHour} />
    </span>
  );
  const unitHour = <span className="text-xs font-semibold text-mute"> /h</span>;
  const stats = (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-[10px] border border-line bg-tile px-3 py-2.5 sm:grid-cols-4">
      <Stat icon={<Coin kind="gold" />} label="Gold"><AnimatedNumber value={acc.gold} /></Stat>
      <Stat icon={<Coin kind="gem" />} label="Gemas"><AnimatedNumber value={acc.gems} /></Stat>
      <Stat icon={<GoldPerHourIcon />} label="Ouro por hora">
        <span className="text-poke-gold">+<AnimatedNumber value={acc.goldPerHour} /></span>
        {unitHour}
      </Stat>
      <Stat icon={<Swords className="size-full text-fg" />} label="Abates por hora">
        {killsPerHour == null ? "—" : <AnimatedNumber value={killsPerHour} />}
        {unitHour}
      </Stat>
    </div>
  );
  const chips = (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <EquipChip item={potion} label="Poção equipada" onPress={options ? open("potion") : undefined} />
      <EquipChip item={ball} label="Bola equipada" onPress={options ? open("ball") : undefined} />
      <EquipChip item={revive} label="Revive equipado" onPress={options?.revive ? open("revive") : undefined} />
    </div>
  );
  const chipsBlock = (
    <>
      <EquipChip item={potion} label="Poção equipada" onPress={options ? open("potion") : undefined} block />
      <EquipChip item={ball} label="Bola equipada" onPress={options ? open("ball") : undefined} block />
      <EquipChip item={revive} label="Revive equipado" onPress={options?.revive ? open("revive") : undefined} block />
    </>
  );
  const huntKills =
    acc.hunt && acc.hunt.kills > 0 ? (
      <span className="tnum text-xs font-medium text-mute">
        <AnimatedNumber value={acc.hunt.kills} /> abates nesta hunt
      </span>
    ) : null;
  const xpRow = (
    <div className="mb-3 flex items-center justify-between gap-2 text-sm">
      <span className="font-semibold text-mute">XP por hora</span>
      <span className="font-extrabold">{xpHour}</span>
    </div>
  );
  const popover = (
    <AnimatePresence>
      {picker && options && (
        <EquipPopover
          key={picker.kind}
          kind={picker.kind}
          accId={id}
          options={options[picker.kind] ?? []}
          selectedId={(picker.kind === "ball" ? ball : picker.kind === "revive" ? revive : potion)?.id}
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
        />
      )}
    </AnimatePresence>
  );

  // ---------------------------------------------------------------- Padrão (o card de antes dos modelos)
  if (variant === "padrao") {
    return (
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-2 sm:gap-2">
        <Tile icon={<Coin kind="gold" />} label="Gold" className="order-6 sm:order-none">
          <AnimatedNumber value={acc.gold} />
        </Tile>
        <Tile icon={<Coin kind="gem" />} label="Gemas" className="order-3 sm:order-none">
          <AnimatedNumber value={acc.gems} />
        </Tile>
        <Tile icon={<ItemSprite icon={potion?.icon} size={32} alt={potion?.name} />} className="order-2 sm:order-none" label="Poção equipada" hint={potion ? `Poção equipada: ${potion.name}. Clique para trocar` : "Clique para escolher a poção"} onPress={options ? open("potion") : undefined}>
          <Equipped item={potion} />
        </Tile>
        <Tile icon={<ItemSprite icon={ball?.icon} size={32} alt={ball?.name} />} className="order-5 sm:order-none" label="Bola equipada" hint={ball ? `Bola equipada: ${ball.name}. Clique para trocar` : "Clique para escolher a bola"} onPress={options ? open("ball") : undefined}>
          <Equipped item={ball} />
        </Tile>
        <Tile icon={<ItemSprite icon={revive?.icon} size={32} alt={revive?.name} />} className="order-7 sm:order-none" label="Revive equipado" hint={revive ? `Revive equipado: ${revive.name}. Clique para trocar` : "Clique para escolher o revive"} onPress={options?.revive ? open("revive") : undefined}>
          <Equipped item={revive} />
        </Tile>
        <Tile icon={<Star className="size-full fill-poke-gold text-poke-gold" />} label="XP por hora" className="tile-green order-1 sm:order-none">
          <span className="text-poke-green">
            +<AnimatedNumber value={acc.xpPerHour} />
            <span className="hidden sm:inline"> XP/h</span>
          </span>
        </Tile>
        <Tile icon={<GoldPerHourIcon />} label="Ouro por hora" className="tile-gold order-4 sm:order-none">
          <span className="text-poke-gold">
            +<AnimatedNumber value={acc.goldPerHour} />
            <span className="hidden sm:inline"> Ouro/h</span>
          </span>
        </Tile>
        <Tile icon={<Swords className="size-full text-fg" />} label="Abates por hora" className="order-8 col-span-2 sm:col-span-1 sm:order-none">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-fg">
              {killsPerHour == null ? "—" : <AnimatedNumber value={killsPerHour} />}
              <span className="text-mute"> abates/h</span>
            </span>
            {huntKills && <span className="text-xs font-medium text-mute">{fmtShort(acc.hunt!.kills)} nesta hunt</span>}
          </span>
        </Tile>
        {popover}
      </div>
    );
  }

  // ---------------------------------------------------------------- Medalhão
  if (variant === "medalhao") {
    return (
      <div className="space-y-2 sm:space-y-2.5">
        <div className="tile px-3 py-3 sm:px-5 sm:py-4">
          {xpRow}
          <XpMedallion trainer={trainer} mon={mon} sprite={<PokemonSprite looktype={pk?.looktype} size={64} />} />
        </div>
        {stats}
        {chips}
        {popover}
      </div>
    );
  }

  // ---------------------------------------------------------------- Versus
  if (variant === "versus") {
    return (
      <div className="space-y-2 sm:space-y-2.5">
        <div className="tile px-2.5 py-3 sm:px-4 sm:py-4">
          <XpVersus trainer={trainer} mon={mon}>
            <div className="flex flex-col items-center gap-2.5 text-center">
              <div className="flex size-14 items-center justify-center rounded-full border-2 border-edge sm:size-16" style={{ background: "radial-gradient(circle at 50% 35%, #4a3519, #1a120a 75%)" }}>
                <span className="origin-center scale-[.8] sm:scale-100"><PokemonSprite looktype={pk?.looktype} size={52} /></span>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 text-[11px] font-medium leading-none text-mute sm:text-xs">
                  <Star className="size-3.5 fill-poke-gold text-poke-gold" aria-hidden /> XP por hora
                </div>
                <div className="mt-1 text-2xl font-extrabold leading-none sm:text-3xl">{xpHour}</div>
              </div>
              <div className="w-full max-w-[200px]"><XpSpark id={id} /></div>
              <div className="flex w-full max-w-[200px] flex-col gap-1.5">{chipsBlock}</div>
            </div>
          </XpVersus>
        </div>
        {stats}
        {huntKills && <p className="text-right">{huntKills}</p>}
        {popover}
      </div>
    );
  }

  // ---------------------------------------------------------------- Corrida
  return (
    <div className="space-y-2 sm:space-y-2.5">
      <div className="tile px-3 py-3 sm:px-4">
        {xpRow}
        <XpRace
          trainer={trainer}
          mon={mon}
          trainerRunner={<Crown className="size-5 text-poke-gold" aria-hidden />}
          monRunner={<span className="origin-center scale-[.55]"><PokemonSprite looktype={pk?.looktype} size={52} /></span>}
        />
      </div>
      {stats}
      {chips}
      {popover}
    </div>
  );
}

function SessaoBody({ id }: { id: string }) {
  const acc = useAccount(id);
  if (!acc) return null;
  // Outland só dropa itens raros e as outras áreas só têm shinies: mostra o que faz sentido para a hunt atual.
  // O que já rendeu na sessão continua aparecendo, mesmo ao trocar de área, até zerar a sessão.
  const sh = acc.session?.shinies;
  const outland = acc.session?.outland ?? null;
  const showShinies = !!sh && (outland === false || sh.seen + sh.captured > 0);
  const showItems = outland !== false || SESSION_ITEMS.some((it) => (acc.session?.items[it.key] ?? 0) > 0);
  return (
    <div className="space-y-1.5 sm:space-y-2.5">
      <Tile icon={<Clock className="size-full text-poke-gold" />} label="Tempo da sessão" className="tile-gold">
        <span className="text-xl font-extrabold leading-none text-fg sm:text-3xl">
          <SessionClock startedAt={acc.session?.startedAt} />
        </span>
      </Tile>
      {showShinies && sh && (
        <div className="grid grid-cols-2 gap-1.5 sm:gap-2.5">
          <Tile icon={<span className="text-2xl">✨</span>} label="Shinies vistos">
            <span className="font-extrabold sm:text-2xl"><AnimatedNumber value={sh.seen} /></span>
          </Tile>
          <Tile icon={<span className="text-2xl">✨</span>} label="Shinies capturados">
            <span className="font-extrabold sm:text-2xl"><AnimatedNumber value={sh.captured} /></span>
          </Tile>
        </div>
      )}
      {showItems && (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-2 sm:gap-2.5">
        {SESSION_ITEMS.map((it) => (
          <Tile key={it.key} icon={<ItemSprite icon={it.icon} size={32} alt={it.label} />} label={it.label}>
            <span className="font-extrabold sm:text-2xl">
              <AnimatedNumber value={acc.session?.items[it.key] ?? 0} />
            </span>
          </Tile>
        ))}
        </div>
      )}
    </div>
  );
}

/** Arrastar para trocar de lugar: `canDrag` só no computador; `onDragOver` recebe o ponto do ponteiro. */
export interface CardDrag {
  canDrag: boolean;
  onDragOver: (id: string, point: { x: number; y: number }) => void;
}

const HOLD_MS = 380; // quanto tempo segurar o card no celular para "levantar" e poder arrastar
const HOLD_SLOP = 10; // se o dedo andar mais que isso antes, é rolagem e não segurar
const SCROLL_EDGE = 84; // faixa junto à borda da tela que rola a página durante o arrasto

function AccountCardImpl({ id, mode, index = 0, drag }: { id: string; mode: CardMode; index?: number; drag?: CardDrag }) {
  const acc = useAccount(id);
  const openSheet = useSheet();
  const cardStyle = useCardStyle();
  const controls = useDragControls();
  const [lifted, setLifted] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState<string | null>(null);
  const closeLive = useCallback(() => setLiveOpen(false), []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);
  const openLiveFromDetail = useCallback(() => setLiveOpen(true), []);
  const liftedRef = useRef(false);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const ptr = useRef({ x: 0, y: 0 }); // posição do dedo na tela durante o arrasto
  // Celular/tablet (sem mouse): segurar o card levanta e libera o arrasto; o toque normal continua rolando a página.
  const touchMode = !!drag && !drag.canDrag;

  const clearHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const drop = () => {
    clearHold();
    if (liftedRef.current) {
      liftedRef.current = false;
      setLifted(false);
    }
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!touchMode || e.pointerType !== "touch" || (e.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    const native = e.nativeEvent;
    clearHold();
    hold.current = {
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        hold.current = null;
        liftedRef.current = true;
        ptr.current = { x: native.clientX, y: native.clientY };
        setLifted(true);
        navigator.vibrate?.(18);
        controls.start(native);
      }, HOLD_MS),
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) clearHold(); // o dedo andou: é rolagem
  };

  // Com o card levantado, o toque não pode rolar a página (o cancelável só vale antes de a rolagem começar).
  useEffect(() => {
    if (!touchMode) return;
    const block = (e: TouchEvent) => {
      if (liftedRef.current && e.cancelable) e.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, [touchMode]);

  // Arrastando perto da borda de cima/baixo, a página rola para dar para levar o card mais longe.
  useEffect(() => {
    if (!lifted || !drag) return;
    let raf = 0;
    const step = () => {
      const { x, y } = ptr.current;
      const bottom = window.innerHeight - 150; // acima da barra de abas
      const dy = y < SCROLL_EDGE ? -(SCROLL_EDGE - y) / 5 : y > bottom ? (y - bottom) / 5 : 0;
      if (dy) {
        window.scrollBy(0, Math.max(-16, Math.min(16, dy)));
        drag.onDragOver(id, { x: x + window.scrollX, y: y + window.scrollY });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [lifted, drag, id]);

  if (!acc) return null;

  const pk = acc.pokemon;
  const hpPct = pk && pk.maxHp > 0 ? Math.min(100, (pk.hp / pk.maxHp) * 100) : 0;
  const hpColor = hpPct > 50 ? "#6fd47c" : hpPct > 20 ? "#f3c04a" : "#ef6b5b";

  return (
    <motion.article
      layout="position"
      data-card-id={id}
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: acc.status === "offline" ? 0.62 : 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.5,
        ease: EASE,
        delay: Math.min(index, 6) * 0.07,
        // Troca de lugar: mola rápida, sem o atraso da entrada.
        layout: { type: "spring", stiffness: 420, damping: 36, delay: 0 },
      }}
      drag={!!drag}
      dragListener={!!drag?.canDrag}
      dragControls={controls}
      dragSnapToOrigin
      dragMomentum={false}
      dragElastic={0.14}
      whileDrag={{ scale: 1.03, zIndex: 40, boxShadow: "0 22px 44px -10px rgba(0,0,0,.75), 0 0 0 2px rgba(243,192,74,.55)" }}
      onDrag={(_: unknown, info: PanInfo) => {
        ptr.current = { x: info.point.x - window.scrollX, y: info.point.y - window.scrollY };
        drag?.onDragOver(id, info.point);
      }}
      onDragEnd={() => {
        dragState.endedAt = performance.now();
        drop();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={drop}
      onPointerCancel={drop}
      onClick={(e) => {
        if (justDragged()) return;
        if ((e.target as HTMLElement).closest("button,a,input,select,textarea,[role='button']")) return;
        setDetailOpen(true);
      }}
      onContextMenu={touchMode ? (e) => e.preventDefault() : undefined}
      className={`card p-2.5 sm:p-3 ${drag?.canDrag ? "cursor-grab active:cursor-grabbing" : touchMode ? "select-none [-webkit-touch-callout:none]" : ""} ${lifted ? "ring-2 ring-poke-gold/70" : ""}`}
    >
      <header className="flex items-center gap-2.5 sm:gap-3.5">
        {(cardStyle === "corrida" || cardStyle === "padrao") && (
        <motion.button
          type="button"
          disabled={!pk?.id}
          title={pk?.id ? `Ver ficha completa de ${pk.name}` : undefined}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!justDragged() && pk?.id) openSheet({ kind: "own", account: accountNumber(id), id: pk.id }, e.currentTarget);
          }}
          whileHover={{ rotate: -4, scale: 1.06 }}
          transition={{ type: "spring", stiffness: 320, damping: 16 }}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-edge disabled:cursor-default sm:size-14 sm:border-[3px]"
          style={{ background: "radial-gradient(circle at 50% 35%, #4a3519, #1a120a 75%)", boxShadow: "0 0 14px -2px rgba(200,146,58,.45)" }}
        >
          <span className="origin-center scale-[.72] sm:scale-100">
            <PokemonSprite looktype={pk?.looktype} species={pk?.speciesId} size={52} shiny={pk?.shiny} />
          </span>
        </motion.button>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            {/* Nome, mapa e hunt na mesma linha; se faltar largura (celular), o que não couber desce junto. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h3 className="max-w-full truncate text-base font-extrabold leading-tight tracking-tight sm:text-xl">
                {acc.nick}
                {acc.vip && (
                  <span className="ml-1.5 rounded bg-poke-gold px-1 py-0.5 align-middle text-[9px] font-black leading-none text-void sm:ml-2 sm:px-1.5 sm:text-[10px]">VIP</span>
                )}
              </h3>
              <LocationChip location={acc.location} map={acc.map} />
              <ProxyChip proxy={acc.proxy} />
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-mute sm:hidden">
                <Crosshair className="size-4 shrink-0 text-poke-gold" aria-hidden />
                <span className="sr-only">Local atual: </span>
                <b className="truncate font-semibold text-fg">
                  {acc.location && !acc.location.inHunt ? acc.location.label : (acc.huntName ?? prettySlug(acc.hunt?.slug))}
                </b>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title="Abrir painel detalhado da conta (abas: Visão Geral, Equipe, Automação, Inventário, Capturas)"
                aria-label={`Abrir detalhes de ${acc.nick}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!justDragged()) setDetailOpen(true);
                }}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-tile px-2 text-[11px] font-bold text-mute transition-colors hover:border-edge hover:text-poke-gold active:scale-95"
              >
                <Info className="size-3.5" aria-hidden />
                <span className="hidden md:inline">Detalhes</span>
              </button>
              <button
                type="button"
                title="Abrir visão Ao Vivo (Modo Live)"
                aria-label={`Abrir visão ao vivo de ${acc.nick}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!justDragged()) setLiveOpen(true);
                }}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-tile px-2 text-[11px] font-bold text-fg transition-colors hover:border-edge hover:text-poke-gold active:scale-95"
              >
                <Radio className={`size-3.5 ${acc.status === "online" ? "text-poke-red" : "text-mute"}`} aria-hidden />
                <span className="hidden sm:inline">Live</span>
              </button>
              <button
                type="button"
                disabled={pauseBusy}
                title={acc.paused ? "Retomar conta (reconectar e voltar para a hunt)" : "Pausar conta: vai ao Pokécentro e desconecta sem tentar reconectar"}
                aria-label={acc.paused ? `Retomar ${acc.nick}` : `Pausar ${acc.nick}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (justDragged() || pauseBusy) return;
                  setPauseBusy(true);
                  void (async () => {
                    if (acc.paused && acc.automation?.autoBestHunt) {
                      const prio = (acc.automation.autoBestHuntPriority || "xp") as HuntOrder;
                      const reg = acc.automation.autoBestHuntRegion || "all";
                      const sim = await computeBestHuntSlug(id, prio, reg).catch(() => null);
                      if (sim?.slug && sim.slug !== acc.automation.autoBestHuntSlug) {
                        await actions.setAutomation(id, { autoBestHuntSlug: sim.slug }).catch(() => {});
                      }
                    }
                    await actions.pause(id, !acc.paused);
                  })().finally(() => setPauseBusy(false));
                }}
                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] font-bold transition-colors active:scale-95 disabled:opacity-50 ${
                  acc.paused
                    ? "border-[#2f6b3a] bg-[#16301c] text-poke-green hover:bg-[#1e4226]"
                    : "border-line bg-tile text-mute hover:border-edge hover:text-poke-gold"
                }`}
              >
                {acc.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                <span className="hidden sm:inline">{acc.paused ? "Retomar" : "Pausar"}</span>
              </button>
              <StatusPill status={acc.status} />
            </div>
          </div>
          {/* Nos modelos com barras de XP os níveis já aparecem no bloco; no Padrão e na aba Sessão ficam aqui. */}
          <div className={`mt-0.5 items-center gap-x-2 text-xs text-mute sm:mt-1 sm:text-sm ${mode === "sessao" || cardStyle === "padrao" ? "flex" : "hidden"}`}>
            <span className="tnum shrink-0" title="Nível do treinador">
              <span className="sm:hidden">Trein. </span>
              <span className="hidden sm:inline">Treinador </span>
              Nv. {fmtShort(acc.level)}
            </span>
            <span className="flex min-w-0 items-center gap-1" title="Pokémon equipado">
              <span aria-hidden className="text-line">|</span>
              <span className="truncate">{pk?.name ?? "—"}</span>
              {pk?.level != null && <span className="tnum shrink-0">Nv. {fmtShort(pk.level)}</span>}
              {pk?.shiny && <ShinyMark />}
            </span>
          </div>
          {/* Barra de HP + valor numérico visível */}
          <div className="mt-1.5 flex items-center gap-2 sm:mt-2">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/50 sm:h-2"
              title={pk ? `${fmtShort(pk.hp)} / ${fmtShort(pk.maxHp)} HP` : undefined}
            >
              <motion.div
                className="h-full rounded-full"
                animate={{ width: `${hpPct}%`, backgroundColor: hpColor }}
                transition={{ duration: 0.6, ease: EASE }}
              />
            </div>
            {pk && pk.maxHp > 0 && (
              <span className="tnum inline-flex shrink-0 items-center gap-1 text-[11px] font-bold leading-none sm:text-xs" style={{ color: hpColor }}>
                <Heart className="size-3 fill-current" aria-hidden />
                {fmtShort(pk.hp)}/{fmtShort(pk.maxHp)}
                <span className="hidden opacity-80 sm:inline">({Math.round(hpPct)}%)</span>
              </span>
            )}
          </div>
        </div>
      </header>

      {acc.paused && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#7a5a1c] bg-[#33260e]/70 px-2.5 py-1.5 text-xs text-poke-gold">
          <span className="min-w-0 flex-1 truncate">
            {acc.farmPausePending
              ? "⏳ Aguardando fim do combate para ir ao Pokécentro e pausar (sem reconectar)…"
              : "🏥 Conta pausada no Pokécentro — desconectada (não tenta reconectar)."}
          </span>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {acc.farmPausePending && (acc.escapeRopes ?? 0) > 0 && (
              <button
                type="button"
                disabled={pauseBusy}
                title="Usa 1 Escape Rope para ir ao Centro Pokémon imediatamente sem perder XP e pausar"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pauseBusy) return;
                  setPauseBusy(true);
                  void actions.pause(id, true, "rope").finally(() => setPauseBusy(false));
                }}
                className="rounded border border-edge bg-tile px-2 py-0.5 text-[11px] font-bold text-fg hover:border-poke-gold hover:text-poke-gold disabled:opacity-50"
              >
                🪢 Rope (×{acc.escapeRopes})
              </button>
            )}
            {acc.farmPausePending && (
              <button
                type="button"
                disabled={pauseBusy}
                title="Desistir do combate (centro.desistir): vai ao Pokécentro imediatamente e pausa"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pauseBusy) return;
                  if (!window.confirm(`Desistir do combate em ${acc.nick}, ir ao Centro Pokémon e pausar?\n\nAviso do jogo: desistir em combate pode custar até 10% do XP do nível atual (0% no Boost dos Atrasados).`)) return;
                  setPauseBusy(true);
                  void actions.pause(id, true, "forfeit").finally(() => setPauseBusy(false));
                }}
                className="rounded border border-[#7a2f27] bg-[#32140f] px-2 py-0.5 text-[11px] font-bold text-poke-red hover:bg-[#461c15] disabled:opacity-50"
              >
                🏳️ Sair agora
              </button>
            )}
            <button
              type="button"
              disabled={pauseBusy}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (pauseBusy) return;
                setPauseBusy(true);
                void (async () => {
                  if (acc.automation?.autoBestHunt) {
                    const prio = (acc.automation.autoBestHuntPriority || "xp") as HuntOrder;
                    const reg = acc.automation.autoBestHuntRegion || "all";
                    const sim = await computeBestHuntSlug(id, prio, reg).catch(() => null);
                    if (sim?.slug && sim.slug !== acc.automation.autoBestHuntSlug) {
                      await actions.setAutomation(id, { autoBestHuntSlug: sim.slug }).catch(() => {});
                    }
                  }
                  await actions.pause(id, false);
                })().finally(() => setPauseBusy(false));
              }}
              className="shrink-0 rounded border border-[#2f6b3a] bg-[#16301c] px-2 py-0.5 text-[11px] font-bold text-poke-green hover:bg-[#1e4226] disabled:opacity-50"
            >
              {acc.farmPausePending ? "Cancelar" : "Retomar"}
            </button>
          </div>
        </div>
      )}

      {acc.huntPending && (
        <p className="mt-1.5 truncate text-xs text-poke-gold sm:hidden">→ {acc.huntPending.name} (na fila)</p>
      )}

      <div className="mt-2 sm:mt-2.5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            {mode === "resumo" ? <ResumoBody id={id} variant={cardStyle} /> : <SessaoBody id={id} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Boosts ativos na conta (XP, Loot, Captura, Shiny, VIP, Guild, Evento, Atrasados) */}
      <BoostsBar boosts={acc.boosts} />

      {/* Equipe completa (clicável para abrir Ficha Completa; botão ★ Ativar troca o Pokémon ativo da equipe) */}
      {acc.team && acc.team.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-mute">Equipe</span>
          {acc.team.map((m, idx) => {
            const mpct = m.maxHp > 0 ? Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100)) : 0;
            const mcol = mpct > 50 ? "#6fd47c" : mpct > 20 ? "#f3c04a" : "#ef6b5b";
            return (
              <div
                key={m.id ?? idx}
                className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-1.5 py-1 transition-colors ${
                  m.active ? "border-poke-gold/70 bg-[#2a1f0b]/80" : "border-line bg-void/60 hover:border-edge"
                }`}
              >
                <button
                  type="button"
                  disabled={!m.id}
                  title={`${m.name} Nv.${m.level} · HP ${fmtShort(m.hp)}/${fmtShort(m.maxHp)} (${Math.round(mpct)}%) — clique para abrir a ficha`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!justDragged() && m.id) openSheet({ kind: "own", account: accountNumber(id), id: m.id }, e.currentTarget);
                  }}
                  className="inline-flex items-center gap-1.5 text-left disabled:cursor-default"
                >
                  <PokemonSprite looktype={m.looktype} species={m.speciesId} size={24} shiny={m.shiny} />
                  <div className="min-w-0 leading-tight">
                    <div className="flex items-center gap-0.5 text-[11px] font-bold">
                      <span className="max-w-[78px] truncate">{m.name}</span>
                      {m.shiny && <ShinyMark className="text-[10px]" />}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      <div className="h-1 w-10 overflow-hidden rounded-full bg-black/60">
                        <div className="h-full rounded-full" style={{ width: `${mpct}%`, backgroundColor: mcol }} />
                      </div>
                      <span className="tnum text-[9px] text-mute">Nv.{fmtShort(m.level)}</span>
                    </div>
                  </div>
                </button>
                {!m.active && m.id && acc.status === "online" && (
                  <button
                    type="button"
                    disabled={autoBusy === `active:${m.id}`}
                    title={`Tornar ${m.name} o Pokémon ativo da equipe`}
                    aria-label={`Ativar ${m.name}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (justDragged() || autoBusy) return;
                      setAutoBusy(`active:${m.id}`);
                      void actions.setActivePokemon(id, m.id!).finally(() => setAutoBusy(null));
                    }}
                    className="ml-0.5 rounded border border-line bg-tile px-1 py-0.5 text-[9px] font-extrabold uppercase text-mute transition-colors hover:border-poke-gold hover:text-poke-gold disabled:opacity-50"
                  >
                    Ativar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Automação em tempo real (separada em Auto-Usar vs Auto-Comprar para leitura imediata) */}
      {acc.automation && (
        <div className="mt-2 space-y-1.5">
          {/* Linha 1: Auto-Usar / Ações em jogo */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-mute">Auto-Usar</span>
            {(
              [
                [
                  "gameAutoPotion",
                  acc.automation.hpLimiarPct != null ? `Poção ≤${acc.automation.hpLimiarPct}%` : "Poção",
                  acc.automation.gameAutoPotion,
                  { gameAutoPotion: !acc.automation.gameAutoPotion },
                  `Usar poção equipada automaticamente quando HP ≤ ${acc.automation.hpLimiarPct ?? 40}% (configuração nativa do jogo).`,
                ],
                [
                  "gameAutoRevive",
                  "Revive",
                  Boolean(acc.automation.gameAutoRevive),
                  { gameAutoRevive: !acc.automation.gameAutoRevive },
                  "Usar Revive automaticamente ao desmaiar (configuração nativa do jogo).",
                ],
                ["autoCatch", "Capturar", acc.automation.autoCatch, { autoCatch: !acc.automation.autoCatch }, "Lançar Pokébola automaticamente em selvagens."],
                ["autoPotionFallback", "Fallback Poção", acc.automation.autoPotionFallback, { autoPotionFallback: !acc.automation.autoPotionFallback }, "Trocar para próxima poção disponível na mochila se a atual zerar."],
                ["autoCenter", `Centro ≤${acc.automation.autoCenterHpPct}%`, acc.automation.autoCenter, { autoCenter: !acc.automation.autoCenter }, "Ir ao Centro Pokémon automaticamente em emergência sem poções."],
                [
                  "autoBestHunt",
                  acc.automation.autoBestHunt
                    ? `Hunt (${({ xp: "XP", xpTreinador: "XP Tr.", ouro: "Ouro", shiny: "Shiny", fragmento: "Frag." } as Record<string, string>)[acc.automation.autoBestHuntPriority || "xp"] ?? "XP"}${acc.automation.autoBestHuntRegion && acc.automation.autoBestHuntRegion !== "all" ? ` · ${acc.automation.autoBestHuntRegion}` : ""})`
                    : "Melhor Hunt",
                  Boolean(acc.automation.autoBestHunt),
                  { autoBestHunt: !acc.automation.autoBestHunt },
                  `Trocar automaticamente para a melhor hunt liberada (prioridade: ${acc.automation.autoBestHuntPriority || "xp"}, região: ${acc.automation.autoBestHuntRegion || "all"}).`,
                ],
                ["autoPassClaim", "Passe", Boolean(acc.automation.autoPassClaim), { autoPassClaim: !acc.automation.autoPassClaim }, "Resgatar automaticamente o Passe de Batalha quando disponível."],
              ] as [string, string, boolean, AutomationPatch, string][]
            ).map(([key, label, on, patch, tip]) => (
              <button
                key={key}
                type="button"
                disabled={autoBusy === key || ((key === "gameAutoPotion" || key === "gameAutoRevive") && acc.status !== "online")}
                title={`${tip} — clique para ${on ? "desativar" : "ativar"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (justDragged() || autoBusy) return;
                  setAutoBusy(key);
                  void actions.setAutomation(id, patch).finally(() => setAutoBusy(null));
                }}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors active:scale-95 disabled:opacity-50 ${
                  on
                    ? "border-[#2f6b3a] bg-[#16301c]/80 text-poke-green hover:bg-[#1e4226]"
                    : "border-line bg-void/60 text-mute/75 hover:border-edge hover:text-fg"
                }`}
              >
                <span className={`size-1.5 rounded-full ${on ? "bg-poke-green" : "bg-mute/60"}`} />
                {label}
              </button>
            ))}
          </div>

          {/* Linha 2: Auto-Comprar / Reposição na loja */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-mute">Auto-Comprar</span>
            {(
              [
                [
                  "autoPotion",
                  acc.automation.autoPotion
                    ? `🛒 Poção (<${acc.automation.potionThreshold}→+${acc.automation.potionQty})`
                    : "🛒 Poção",
                  acc.automation.autoPotion,
                  { autoPotion: !acc.automation.autoPotion },
                  `Autocompra de poções na loja: compra ${acc.automation.potionQty} un. quando estoque ficar abaixo de ${acc.automation.potionThreshold}${acc.automation.goldReserve > 0 ? ` (piso ${fmtShort(acc.automation.goldReserve)}g)` : ""}.`,
                ],
                [
                  "autoBallRestock",
                  acc.automation.autoBallRestock
                    ? `🛒 Bola (<${acc.automation.ballThreshold}→+${acc.automation.ballQty})`
                    : "🛒 Bola",
                  acc.automation.autoBallRestock,
                  { autoBallRestock: !acc.automation.autoBallRestock },
                  `Autocompra de Pokébolas na loja: compra ${acc.automation.ballQty} un. quando estoque ficar abaixo de ${acc.automation.ballThreshold}${acc.automation.goldReserve > 0 ? ` (piso ${fmtShort(acc.automation.goldReserve)}g)` : ""}.`,
                ],
                [
                  "autoReviveRestock",
                  acc.automation.autoReviveRestock
                    ? `🛒 ${acc.automation.reviveId === 206 ? "Max Revive" : "Revive"} (<${acc.automation.reviveThreshold ?? 5}→+${acc.automation.reviveQty ?? 20})`
                    : `🛒 ${acc.automation.reviveId === 206 ? "Max Revive" : "Revive"}`,
                  Boolean(acc.automation.autoReviveRestock),
                  { autoReviveRestock: !acc.automation.autoReviveRestock },
                  `Autocompra de ${acc.automation.reviveId === 206 ? "Max Revive" : "Revive"} na loja: compra ${acc.automation.reviveQty ?? 20} un. quando estoque ficar abaixo de ${acc.automation.reviveThreshold ?? 5}.`,
                ],
              ] as [string, string, boolean, AutomationPatch, string][]
            ).map(([key, label, on, patch, tip]) => (
              <button
                key={key}
                type="button"
                disabled={autoBusy === key}
                title={`${tip} — clique para ${on ? "desativar" : "ativar"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (justDragged() || autoBusy) return;
                  setAutoBusy(key);
                  void actions.setAutomation(id, patch).finally(() => setAutoBusy(null));
                }}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors active:scale-95 disabled:opacity-50 ${
                  on
                    ? "border-[#7a5a1c] bg-[#33260e]/85 text-poke-gold hover:bg-[#463413]"
                    : "border-line bg-void/60 text-mute/75 hover:border-edge hover:text-fg"
                }`}
              >
                <span className={`size-1.5 rounded-full ${on ? "bg-poke-gold" : "bg-mute/60"}`} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="mt-2.5 hidden flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line pt-2 text-sm text-mute sm:flex">
        <span className="truncate">
          {acc.location && !acc.location.inHunt ? (
            <>
              Local: <b className={`font-semibold ${acc.location.inCenter ? "text-poke-green" : "text-fg"}`}>{acc.location.label}</b>
              {acc.location.detail && <> · {acc.location.detail}</>}
            </>
          ) : (
            <>
              Hunt: <b className="font-semibold text-fg">{acc.huntName ?? prettySlug(acc.hunt?.slug)}</b>
              {acc.hunt && <> · {fmtDuration(acc.hunt.minutes)}</>}
              {acc.hunt && acc.hunt.kills > 0 && <> · <span className="tnum">{fmtShort(acc.hunt.kills)} abates</span></>}
            </>
          )}
          {acc.huntPending && <span className="ml-1.5 text-poke-gold"> → {acc.huntPending.name} (na fila)</span>}
        </span>
        {acc.captured && (
          <span className="tnum">
            {fmtShort(acc.captured.total)} Pokémons
            {acc.captured.shiny ? ` · ${acc.captured.shiny} shiny` : ""}
          </span>
        )}
      </footer>
      <LiveModal accId={id} open={liveOpen} onClose={closeLive} />
      <AccountDetailModal accId={id} open={detailOpen} onClose={closeDetail} onOpenLive={openLiveFromDetail} />
    </motion.article>
  );
}

// Cada card assina só a própria conta; memo evita re-render do pai.
export const AccountCard = memo(AccountCardImpl);
