import { MessagesSquare, PictureInPicture2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChatPanel } from "@/components/ChatPanel";
import { totalUnread, useChat } from "@/lib/chat";
import { closeChatWindow, openChatWindow, popoutKind, useChatWindow } from "@/lib/popout";

const HANDLE_W = 44;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Largura da bandeja no desktop largo: usa o espaço que sobra ao lado do painel (de 260px até 360px). */
const WIDE_PANEL_W = `clamp(260px, calc((100vw - min(1280px, 100vw - 760px)) / 2 - 90px), 360px)`;

/** wide: colunas ao lado do painel (≥1800px) · drawer: gaveta pela borda (tablet e telas médias) · mobile: aba cheia. */
export type DockMode = "wide" | "drawer" | "mobile";
const QUERIES = { wide: "(min-width: 1800px)", drawer: "(min-width: 640px)" } as const;
const modeNow = (): DockMode => (matchMedia(QUERIES.wide).matches ? "wide" : matchMedia(QUERIES.drawer).matches ? "drawer" : "mobile");

export function useDockMode(): DockMode {
  const [mode, setMode] = useState<DockMode>(modeNow);
  useEffect(() => {
    const list = [matchMedia(QUERIES.wide), matchMedia(QUERIES.drawer)];
    const on = () => setMode(modeNow());
    list.forEach((m) => m.addEventListener("change", on));
    return () => list.forEach((m) => m.removeEventListener("change", on));
  }, []);
  return mode;
}

function Handle({ open, onClick, side }: { open: boolean; onClick: () => void; side: "right" | "left" }) {
  const unread = totalUnread(useChat());
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="chat-dock-panel"
      aria-label={open ? "Fechar o chat" : unread.n ? `Abrir o chat (${unread.n} mensagens novas)` : "Abrir o chat"}
      className={`relative flex flex-col items-center justify-center gap-2 border-2 border-edge text-poke-gold transition-colors hover:text-fg ${
        side === "right" ? "rounded-r-xl border-l-0" : "rounded-l-xl border-r-0"
      }`}
      style={{ width: HANDLE_W, height: 132, background: "linear-gradient(160deg, #3a2a12 0%, #1d140b 100%)", boxShadow: "0 10px 28px -8px rgba(0,0,0,.6), 0 0 22px -6px rgba(200,146,58,.3)" }}
    >
      <MessagesSquare className="size-5" aria-hidden />
      <span className="text-xs font-extrabold uppercase tracking-wider [writing-mode:vertical-rl]">Chat</span>
      {unread.n > 0 && (
        <span
          className={`tnum absolute -top-2 left-1/2 min-w-5 -translate-x-1/2 rounded-full px-1.5 text-center text-[11px] font-extrabold leading-5 text-void ${unread.mention ? "bg-poke-red" : "bg-poke-gold"}`}
          aria-hidden
        >
          {unread.n > 99 ? "99+" : unread.n}
        </span>
      )}
    </button>
  );
}

const KEY_OPEN = "chat.open";
const readOpen = () => {
  try {
    return localStorage.getItem(KEY_OPEN) === "1";
  } catch {
    return false;
  }
};

const popLabel = () => (popoutKind() === "floating" ? "Destacar o chat (janela flutuante, fica por cima de outros programas)" : "Destacar o chat numa janela");

/** No lugar do chat enquanto ele está numa janela própria. */
function PoppedNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
      <PictureInPicture2 className="size-8 text-poke-gold" aria-hidden />
      <p className="text-sm text-mute">O chat está numa janela à parte.</p>
      <button type="button" className="btn" onClick={closeChatWindow}>
        Trazer de volta
      </button>
    </div>
  );
}

/**
 * Chat em bandeja. Largo: sai de trás do painel, no lado direito. Médio: gaveta pela borda da tela.
 * Só `transform` anima (e `visibility` some depois, para o teclado não entrar no chat fechado).
 */
export function ChatDock({ mode }: { mode: Exclude<DockMode, "mobile"> }) {
  const [open, setOpen] = useState(readOpen);
  const popped = useChatWindow() !== null;
  const toggle = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY_OPEN, v ? "1" : "0");
    } catch {
      /* sem armazenamento */
    }
  };
  const wide = mode === "wide";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && toggle(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Na gaveta, tocar fora fecha (na bandeja larga o painel continua em uso ao lado).
  useEffect(() => {
    if (!open || wide) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-chat-dock]")) toggle(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, wide]);

  const panelW = wide ? WIDE_PANEL_W : "min(380px, calc(100vw - 56px))";
  const h = wide ? "min(calc(100dvh - 7rem), 760px)" : "calc(100dvh - 2rem)";
  const slide = {
    transform: open ? "translateX(0)" : `translateX(${wide ? "calc(-1 * " : "calc("}${panelW}))`,
    transition: `transform 420ms ${EASE}`,
  };

  const panel = (
    <div
      id="chat-dock-panel"
      role="dialog"
      aria-label="Chat do jogo"
      aria-hidden={!open}
      className="card overflow-hidden"
      style={{
        width: panelW,
        height: h,
        borderRadius: wide ? "0 16px 16px 0" : "16px 0 0 16px",
        visibility: open ? "visible" : "hidden",
        // some só depois de terminar de deslizar
        transition: open ? "visibility 0s" : "visibility 0s 420ms",
      }}
    >
      {popped ? <PoppedNotice /> : <ChatPanel active={open} onClose={() => toggle(false)} onPopout={() => void openChatWindow()} popoutLabel={popLabel()} />}
    </div>
  );

  if (wide) {
    // A trilha fica colada na direita do painel e recorta o que passa da borda dele: a bandeja nasce "de trás" do painel
    // sem aparecer por baixo do vidro. `overflow-x: clip` (e não hidden) preserva o sticky.
    return (
      <div className="pointer-events-none absolute left-full top-0 h-full [overflow-x:clip]" style={{ width: `calc(${WIDE_PANEL_W} + ${HANDLE_W}px + 28px)` }}>
        <div className="sticky top-20 pt-2">
          <div data-chat-dock className="pointer-events-auto flex items-start" style={slide}>
            {panel}
            <div className="pt-6">
              <Handle open={open} onClick={() => toggle(!open)} side="right" />
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div data-chat-dock className="fixed hidden items-start sm:flex" style={{ right: 0, top: "1rem", zIndex: 45, ...slide }}>
      <div className="pt-[28vh]">
        <Handle open={open} onClick={() => toggle(!open)} side="left" />
      </div>
      {panel}
    </div>
  );
}

/** Desenha o chat dentro da janela destacada (mesma página, mesmo estado: só muda onde aparece). */
export function ChatPopoutHost() {
  const win = useChatWindow();
  if (!win) return null;
  return createPortal(
    <div className="flex h-screen flex-col" style={{ background: "linear-gradient(160deg, #2c1f12 0%, #1d140b 100%)" }}>
      <ChatPanel active onClose={closeChatWindow} />
    </div>,
    win.document.body,
  );
}

/** Celular: o chat ocupa a aba inteira, com o campo de mensagem preso embaixo. */
export function ChatView() {
  return (
    <div className="card overflow-hidden" style={{ height: "calc(100dvh - 12.5rem - env(safe-area-inset-bottom))", minHeight: 320 }}>
      <ChatPanel active />
    </div>
  );
}
