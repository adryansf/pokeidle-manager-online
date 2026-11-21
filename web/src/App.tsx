import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "framer-motion";
import { Bell, BookmarkCheck, Globe, Layers, LayoutDashboard, Map as MapIcon, MessagesSquare, Package, RotateCcw, Settings, Store, Swords, Target, Ticket } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountCard, type CardDrag, type CardMode } from "@/components/AccountCard";
import { BulkActionsModal } from "@/components/BulkActionsModal";
import { CapturesView } from "@/components/CapturesView";
import { CollectionView } from "@/components/CollectionView";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { AccountSelect, InventoryView } from "@/components/InventoryView";
import { MapaView } from "@/components/MapaView";
import { MarketView } from "@/components/market/MarketView";
import { PassView } from "@/components/PassView";
import { ProxyCenterModal } from "@/components/ProxyCenter";
import { PvpView } from "@/components/PvpView";
import { NotificationsModal, SettingsView } from "@/components/SettingsView";
import { SummaryBar } from "@/components/SummaryBar";
import { UpdateBanner } from "@/components/UpdateCard";
import { ChatDock, ChatPopoutHost, ChatView, useDockMode } from "@/components/Sidebars";
import { ConfirmDialog, Frame } from "@/components/ui";
import { actions } from "@/lib/actions";
import { admin } from "@/lib/admin";
import { startChat, totalUnread, useChat } from "@/lib/chat";
import { computeBestHuntSlug, type HuntOrder } from "@/lib/huntAdvisor";
import { useAccountIds, useAccountsMap } from "@/lib/telemetry";
import { useCardOrder } from "@/lib/useCardOrder";

type Tab = "dashboard" | "inventario" | "colecao" | "capturas" | "mapa" | "mercado" | "passe" | "pvp" | "config" | "chat";
const TABS: { id: Tab; label: string; Icon: typeof Package }[] = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "inventario", label: "Inventários", Icon: Package },
  { id: "colecao", label: "Coleção", Icon: BookmarkCheck },
  { id: "capturas", label: "Capturas", Icon: Target },
  { id: "mapa", label: "Mapa", Icon: MapIcon },
  { id: "mercado", label: "Mercado", Icon: Store },
  { id: "passe", label: "Passe", Icon: Ticket },
  { id: "pvp", label: "PVP", Icon: Swords },
  { id: "config", label: "Configurações", Icon: Settings },
];
/** Barra de baixo do celular, em duas fileiras. */
const MOBILE_TABS: { id: Tab; label: string; Icon: typeof Package }[] = [
  ...(["mapa", "colecao", "mercado"] as Tab[]).map((id) => TABS.find((t) => t.id === id)!),
  { id: "chat", label: "Chat", Icon: MessagesSquare },
  ...(["dashboard", "inventario", "pvp", "config"] as Tab[]).map((id) => TABS.find((t) => t.id === id)!),
];
const MODES: { id: CardMode; label: string }[] = [
  { id: "resumo", label: "Resumo" },
  { id: "sessao", label: "Sessão" },
];

const EASE = [0.22, 1, 0.36, 1] as const;
const readTab = (): Tab =>
  location.hash === "#inventario" ? "inventario" : location.hash === "#colecao" ? "colecao" : location.hash === "#capturas" ? "capturas" : location.hash === "#mapa" ? "mapa" : location.hash === "#mercado" ? "mercado" : location.hash === "#passe" ? "passe" : location.hash === "#pvp" ? "pvp" : location.hash === "#config" ? "config" : location.hash === "#chat" ? "chat" : "dashboard";
const TITLES: Record<Tab, string> = { dashboard: "Painel de Contas", inventario: "Inventários", colecao: "Coleção", capturas: "Histórico de Capturas", mapa: "Mapa", mercado: "Mercado", passe: "Passe de Batalha", pvp: "PVP", config: "Configurações", chat: "Chat" };

function UnreadBadge() {
  const u = totalUnread(useChat());
  if (u.n === 0) return null;
  return (
    <span className={`tnum absolute -right-2.5 -top-1.5 min-w-4 rounded-full px-1 text-center text-[10px] font-extrabold leading-4 text-void ${u.mention ? "bg-poke-red" : "bg-poke-gold"}`}>
      {u.n > 99 ? "99+" : u.n}
    </span>
  );
}

/** Aba "Chat" do menu do celular, com o contador de não lidas. Mora à parte para o App não re-renderizar a cada mensagem. */
function MobileTabButton({ id, label, Icon, active, onGo, span }: { id: Tab; label: string; Icon: typeof Package; active: boolean; onGo: (t: Tab) => void; span: string }) {
  return (
    <button
      onClick={() => onGo(id)}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-w-0 flex-col items-center gap-0.5 py-1.5 text-xs font-bold transition-colors ${span} ${active ? "bg-[#2a1e0e] text-poke-gold" : "text-mute"}`}
    >
      <span className="relative">
        <Icon className="size-5" aria-hidden />
        {id === "chat" && !active && <UnreadBadge />}
      </span>
      <span className="max-w-full truncate px-0.5 text-[11px] min-[380px]:text-xs">{label}</span>
    </button>
  );
}

/** Seletor segmentado com "pílula" que desliza entre as opções. */
function Segmented<T extends string>({
  id,
  className = "",
  options,
  value,
  onChange,
}: {
  id: string;
  className?: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className={`relative flex gap-0.5 rounded-xl border border-line bg-tile p-0.5 sm:gap-1 sm:p-1 ${className}`} role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`relative min-w-0 flex-1 rounded-lg px-2.5 py-1 text-xs font-semibold sm:flex-none sm:px-3.5 sm:py-1.5 sm:text-sm transition-colors duration-200 ${
            value === o.id ? "text-void" : "text-mute hover:text-fg"
          }`}
        >
          {value === o.id && (
            <motion.span
              layoutId={`${id}-pill`}
              className="absolute inset-0 rounded-lg bg-poke-gold"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Com mouse o card arrasta direto; no celular (sem mouse) só depois de segurar, para o dedo continuar rolando a página. */
const useFinePointer = () => {
  const [fine, setFine] = useState(() => matchMedia("(pointer: fine)").matches);
  useEffect(() => {
    const m = matchMedia("(pointer: fine)");
    const on = () => setFine(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return fine;
};

function Dashboard({ mode }: { mode: CardMode }) {
  const ids = useAccountIds();
  const { order, swap } = useCardOrder(ids);
  const canDrag = useFinePointer();
  const last = useRef({ target: "", at: 0 });

  // Ao passar o card arrastado por cima de outro, os dois trocam de lugar (o outro anima para a vaga).
  const onDragOver = useCallback(
    (id: string, p: { x: number; y: number }) => {
      const hit = document
        .elementsFromPoint(p.x - window.scrollX, p.y - window.scrollY)
        .map((e) => e.closest<HTMLElement>("[data-card-id]"))
        .find((e) => e && e.dataset.cardId !== id);
      const target = hit?.dataset.cardId;
      if (!target) {
        last.current.target = ""; // saiu de cima de qualquer card: pode voltar a trocar com o mesmo
        return;
      }
      const now = performance.now();
      if (target === last.current.target || now - last.current.at < 320) return;
      last.current = { target, at: now };
      swap(id, target);
    },
    [swap],
  );
  const drag: CardDrag = { canDrag, onDragOver };

  return (
    <div className="space-y-2.5 sm:space-y-3">
      <SummaryBar />
      {ids.length === 0 ? (
        <p className="card p-10 text-center text-mute">Aguardando dados da VPS…</p>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:gap-3 lg:grid-cols-2">
          {order.map((id, i) => (
            <AccountCard key={id} id={id} mode={mode} index={i} drag={drag} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [mode, setMode] = useState<CardMode>("resumo");
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [proxyCenterOpen, setProxyCenterOpen] = useState(false);

  const refreshAlerts = useCallback(() => {
    admin
      .notifications(1)
      .then((r) => setUnreadAlerts(r.unreadCount))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshAlerts();
    const t = window.setInterval(refreshAlerts, 6000);
    return () => window.clearInterval(t);
  }, [refreshAlerts]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState("");
  const doReset = async () => {
    setResetBusy(true);
    setResetErr("");
    try {
      await actions.resetSession();
      setResetOpen(false);
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : "Não foi possível zerar a sessão.");
    } finally {
      setResetBusy(false);
    }
  };
  const [account, setAccount] = useState("all");
  const ids = useAccountIds();
  const accounts = useAccountsMap();
  const online = ids.filter((i) => accounts[i]?.status === "online").length;

  // Sincroniza o Auto-Hunt das contas online com o simulador real do Mapa (hunt-worker.js),
  // garantindo que "Retomar farm" e trocas automáticas levem exatamente para a #1 do Mapa.
  const syncedSigRef = useRef<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const id of ids) {
      const a = accounts[id];
      if (!a || a.status !== "online" || !a.automation?.autoBestHunt) continue;
      const prio = (a.automation.autoBestHuntPriority || "xp") as HuntOrder;
      const reg = a.automation.autoBestHuntRegion || "all";
      const sig = `${a.pokemon?.id ?? ""}|${a.pokemon?.level ?? ""}|${a.level}|${prio}|${reg}`;
      if (syncedSigRef.current[id] === sig && a.automation.autoBestHuntSlug) continue;
      syncedSigRef.current[id] = sig;
      void computeBestHuntSlug(id, prio, reg)
        .then((res) => {
          if (!alive || !res?.slug) return;
          if (res.slug !== a.automation?.autoBestHuntSlug) {
            void actions.setAutomation(id, { autoBestHuntSlug: res.slug });
          }
        })
        .catch(() => {
          delete syncedSigRef.current[id];
        });
    }
    return () => {
      alive = false;
    };
  }, [ids, accounts]);

  useEffect(() => {
    const on = () => setTab(readTab());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // O chat começa a ouvir assim que o painel abre (para contar não lidas) e, fora do celular, vive na bandeja, não numa aba.
  const dock = useDockMode();
  useEffect(() => startChat(), []);
  useEffect(() => {
    if (tab === "chat" && dock !== "mobile") {
      location.hash = "";
      setTab("dashboard");
    }
  }, [tab, dock]);

  // Toda troca de aba começa no topo (inclusive voltar/avançar do navegador).
  const toTop = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  };
  useEffect(() => {
    toTop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const go = (t: Tab) => {
    location.hash = t === "dashboard" ? "" : t;
    setTab(t);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen px-1.5 py-2 pb-32 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6 sm:py-4 sm:pb-4">
        {/* Barra de abas: fica sempre no mesmo lugar, acima da janela principal (só no computador). */}
        <div className="frame-w sticky top-2 z-30 mx-auto mb-3 hidden w-full items-center justify-between gap-3 sm:flex">
          <LayoutGroup id="nav">
            <Segmented id="tab" options={TABS} value={tab} onChange={go} />
          </LayoutGroup>
          <ConnectionIndicator />
        </div>
        {/* A trilha dá a largura ao painel e é a âncora da coluna lateral do Chat. */}
        <div className="frame-w relative mx-auto w-full">
        {dock === "wide" && <ChatDock mode="wide" />}
        <Frame>
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 sm:gap-y-4">
            <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
            <div className="flex items-center gap-2 sm:gap-3.5">
              <img
                src="/icon-192.png"
                alt=""
                aria-hidden
                className="size-8 shrink-0 rounded-lg sm:size-12 sm:rounded-xl"
                style={{ filter: "drop-shadow(0 0 10px rgba(200,146,58,.45))" }}
              />
              <div>
                <h1 className="text-base font-extrabold uppercase leading-none tracking-wide sm:text-3xl">
                  {TITLES[tab]}
                </h1>
                <p className="mt-1 text-xs text-mute sm:mt-1.5 sm:text-sm">
                  <span className="tnum">
                    {online}/{ids.length}
                  </span>{" "}
                  Contas Conectadas
                </p>
              </div>
            </div>
            <div className="sm:hidden">
              <ConnectionIndicator />
            </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
              <LayoutGroup id="sub">
                {/* Sem animação de saída: o elemento que sai (popLayout) ficava preso por cima das abas. */}
                {tab === "dashboard" ? (
                  <motion.div key="mode" className="w-full sm:w-auto" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: EASE }}>
                    {/* Resumo/Sessão, botão de Notificações (Discord/Telegram) e botão de zerar na mesma linha. */}
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
                      <Segmented id="mode" options={MODES} value={mode} onChange={setMode} />
                      <button
                        type="button"
                        aria-label="Ações em Massa (Modo Eco)"
                        className="btn ml-auto sm:ml-0"
                        onClick={() => setBulkOpen(true)}
                        title="Pausar/retomar todas, enviar ao Centro, equipar poção/bola ou trocar hunt em massa"
                      >
                        <Layers className="size-4 text-poke-gold" aria-hidden />
                        <span className="hidden sm:inline">Em massa</span>
                      </button>
                      <button
                        type="button"
                        aria-label="Central de Proxies"
                        className="btn"
                        onClick={() => setProxyCenterOpen(true)}
                        title="Gerenciar, testar e aplicar proxies nas contas"
                      >
                        <Globe className="size-4 text-poke-gold" aria-hidden />
                        <span className="hidden sm:inline">Proxies</span>
                      </button>
                      <button
                        type="button"
                        aria-label="Central de Notificações (Alertas, Discord e Telegram)"
                        className="btn relative"
                        onClick={() => setNotifyOpen(true)}
                        title="Abrir Central de Notificações e configurar Discord / Telegram"
                      >
                        <Bell className="size-4 text-poke-gold" aria-hidden />
                        <span className="hidden sm:inline">Notificações</span>
                        {unreadAlerts > 0 && (
                          <span className="tnum -mr-0.5 rounded-full bg-poke-red px-1.5 py-0.5 text-[10px] font-black leading-none text-void">
                            {unreadAlerts > 99 ? "99+" : unreadAlerts}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="Zerar sessão"
                        className="btn"
                        onClick={() => setResetOpen(true)}
                        title="Zerar o tempo, os itens e os shinies da sessão de todas as contas"
                      >
                        <RotateCcw className="size-4" aria-hidden />
                        <span className="hidden sm:inline">Zerar sessão</span>
                      </button>
                    </div>
                  </motion.div>
                ) : tab === "inventario" || tab === "colecao" ? (
                  <motion.div key="acc" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: EASE }}>
                    <AccountSelect value={account} onChange={setAccount} />
                  </motion.div>
                ) : null}
              </LayoutGroup>
            </div>
          </header>

          <AnimatePresence>
            {notifyOpen && (
              <NotificationsModal
                onClose={() => {
                  setNotifyOpen(false);
                  refreshAlerts();
                }}
                onChanged={refreshAlerts}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>{proxyCenterOpen && <ProxyCenterModal onClose={() => setProxyCenterOpen(false)} />}</AnimatePresence>
          <AnimatePresence>{bulkOpen && <BulkActionsModal onClose={() => setBulkOpen(false)} />}</AnimatePresence>

          <ConfirmDialog
            open={resetOpen}
            title="Zerar a sessão das contas?"
            busy={resetBusy}
            busyLabel="Zerando…"
            danger={false}
            confirmLabel="Zerar sessão"
            onCancel={() => !resetBusy && setResetOpen(false)}
            onConfirm={() => void doReset()}
            message={
              <>
                O <b className="text-fg">tempo da sessão</b> e os <b className="text-fg">itens coletados e os shinies</b> de todas as contas voltam a zero. Nada muda nas contas nem no jogo.
                {resetErr && <div className="mt-2 text-poke-red">{resetErr}</div>}
              </>
            }
          />

          <main className="mt-3 sm:mt-4">
            <UpdateBanner />
            <AnimatePresence mode="wait" initial={false} onExitComplete={toTop}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                {tab === "dashboard" ? <Dashboard mode={mode} /> : tab === "inventario" ? <InventoryView account={account} /> : tab === "colecao" ? <CollectionView account={account} /> : tab === "capturas" ? <CapturesView /> : tab === "mapa" ? <MapaView /> : tab === "mercado" ? <MarketView /> : tab === "passe" ? <PassView /> : tab === "pvp" ? <PvpView /> : tab === "chat" ? <ChatView /> : <SettingsView />}
              </motion.div>
            </AnimatePresence>
          </main>
        </Frame>
        </div>
        {dock === "drawer" && <ChatDock mode="drawer" />}
        <ChatPopoutHost />
      </div>

      <nav
        aria-label="Navegação"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-12 border-t border-line bg-void/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        {/* Duas fileiras de 4 botões (3 colunas de 12 cada). */}
        {MOBILE_TABS.map((t) => (
          <MobileTabButton key={t.id} {...t} active={tab === t.id} onGo={go} span="col-span-3" />
        ))}
      </nav>
    </MotionConfig>
  );
}
