"""Gerenciador de conexão WebSocket por conta, sempre via proxy ISP dedicado.

Estratégia de proxy: `python-socks` (dependência do aiohttp-socks) abre um túnel
TCP (HTTP CONNECT ou SOCKS5, com autenticação) até o host do jogo; o socket já
tunelado é entregue ao `websockets` via `sock=`. Nada sai pelo IP da VPS: se o
túnel falhar, a conta NÃO conecta (sem fallback direto).

Protocolo (spec do protocolo): hello -> welcome (-> amigos, ignorado aqui).
"""
from __future__ import annotations

import asyncio
import enum
import json
import logging
import ssl
import time
from dataclasses import replace
from urllib.parse import urlparse

import aiohttp
from aiohttp_socks import ProxyConnector
from python_socks import ProxyError
from python_socks.async_.asyncio import Proxy  # v1: connect() devolve um socket.socket
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

import config
from balls import BallManager
from config import AccountConfig, Settings
from hunt import HuntManager
from inventory import InventoryView
from battle_pass import PASSE_NIVEL_MIN, pode_resgatar
from maps import effective_tier, normalize_tiers
from market import MarketClient
from pvp import PvpManager
from notify import GOLD, GREEN, RED, DailyStats, Notifier, fmt_duration, rare_icon_url
from item_labels import item_name
from session_stats import ITEM_LABELS, TRACKED, SessionItems, SessionStore, ShinyTracker
from shop import AutoRestock, KNOWN_POTION_IDS, POTION_FALLBACK_ORDER, ShopManager, ball_ids_resolver, potion_ids_resolver

log = logging.getLogger("conn")


class State(enum.Enum):
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"
    AUTHENTICATING = "AUTHENTICATING"
    ONLINE = "ONLINE"
    PAUSED_COOLDOWN = "PAUSED_COOLDOWN"
    PAUSED_MANUAL = "PAUSED_MANUAL"  # pausada manualmente pelo usuário no painel
    BLOCKED = "BLOCKED"   # precisa de ação do usuário (token inválido, ban...): não reconecta sozinho


class AuthRejected(Exception):
    """Servidor rejeitou credenciais (401/403) ou sessão tomada por login externo."""


class AccountBlocked(Exception):
    """O jogo recusou a conta por um motivo que não some sozinho (token inválido, ban...)."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


class NetworkFull(Exception):
    """Rede/IP no limite de contas online: tentar de novo em instantes."""


# Frames {t:'erro', chave:...} do jogo que significam "esta conta/rede não entra".
# Chaves observadas no cliente web (ALERTAS_DO_SOCKET).
BLOCKING_KEYS: dict[str, tuple[str, str]] = {
    "auth.sessaoInvalida": ("invalid", "Sessão inválida ou expirada: reimporte a conta"),
    "auth.precisaLogin": ("invalid", "Sessão inválida ou expirada: reimporte a conta"),
    "auth.contaBanida": ("banned", "Conta banida pelo jogo"),
    "auth.ipBanido": ("net_banned", "Rede (IP) banida pelo jogo"),
    "auth.provedorBanido": ("net_banned", "Provedor de rede banido pelo jogo"),
    "auth.contaExcluida": ("deleted", "Conta excluída"),
    "login.precisaNick": ("needs_nick", "A conta precisa escolher um nick dentro do jogo"),
}
NETWORK_FULL_KEYS = {"login.limiteOnlineIp", "login.limiteOnlineIpLista"}
NETWORK_FULL_RETRY_S = 30


def friendly_reason(e: BaseException) -> str:
    """Motivo da queda em linguagem simples (vai para o Discord e o painel; o detalhe técnico fica só no log)."""
    if isinstance(e, ConnectionClosed):
        code = e.rcvd.code if e.rcvd else None
        if code == 1012:
            return "O jogo reiniciou o servidor."
        return "A conexão com o jogo foi interrompida."
    if isinstance(e, ProxyError):
        return "O proxy da conta não respondeu."
    if isinstance(e, (asyncio.TimeoutError, TimeoutError, ConnectionError)):
        return "O jogo demorou demais para responder."
    if isinstance(e, (OSError, aiohttp.ClientError)):
        return "Sem conexão com o jogo (rede instável ou servidor fora do ar)."
    return "Erro inesperado na conexão; reconectando."


def build_hello(acc: AccountConfig) -> str:
    return json.dumps({
        "t": "hello",
        "nick": acc.nick,
        "token": acc.token,
        "delta": 1,                    # função desconhecida; valor observado
        "dispositivo": acc.device_id,
    })


async def open_tunnel(acc: AccountConfig, ws_url: str):
    """Abre socket TCP até o servidor do jogo via proxy da conta (só quando há proxy)."""
    u = urlparse(ws_url)
    port = u.port or (443 if u.scheme == "wss" else 80)
    proxy = Proxy.from_url(acc.proxy.url)
    return await proxy.connect(dest_host=u.hostname, dest_port=port, timeout=20)


async def probe_exit_ip(acc_proxy) -> str:
    """IP de saída real (via proxy, ou direto se proxy=None)."""
    connector = ProxyConnector.from_url(acc_proxy.url) if acc_proxy is not None else None
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as s:
        async with s.get("https://api.ipify.org") as r:
            return (await r.text()).strip()


async def probe_account(acc: AccountConfig, ws_url: str, timeout: float = 25.0) -> dict:
    """Testa uma conta: hello -> welcome. Devolve {ok, kind, detail, nick?, level?, hunts?}.

    ATENÇÃO: conecta de verdade com o token. Se o mesmo token estiver aberto em outro
    lugar (navegador, outro bot), o jogo derruba o outro (close 4001)."""
    u = urlparse(ws_url)
    ssl_ctx = ssl.create_default_context() if u.scheme == "wss" else None
    kwargs: dict = {}
    try:
        if acc.proxy is not None:
            sock = await open_tunnel(acc, ws_url)
            kwargs = {"sock": sock, "server_hostname": u.hostname if ssl_ctx else None}
        async with connect(ws_url, ssl=ssl_ctx, max_size=None, open_timeout=20, **kwargs) as ws:
            await ws.send(build_hello(acc))

            async def _wait() -> dict:
                async for raw in ws:
                    msg = _parse(raw)
                    if msg.get("t") == "welcome":
                        est = msg.get("estado") or {}
                        return {"ok": True, "kind": "ok", "detail": "", "nick": est.get("nick"),
                                "level": est.get("level"),
                                "hunts": [h.get("slug") for h in msg.get("hunts", []) if isinstance(h, dict)]}
                    if msg.get("t") == "erro":
                        chave = msg.get("chave") or ""
                        if chave in BLOCKING_KEYS:
                            kind, detail = BLOCKING_KEYS[chave]
                            return {"ok": False, "kind": kind, "detail": detail}
                        if chave in NETWORK_FULL_KEYS:
                            return {"ok": False, "kind": "net_full",
                                    "detail": "Rede no limite de contas online: tente de novo em instantes"}
                return {"ok": False, "kind": "closed", "detail": "O servidor fechou a conexão sem welcome"}

            try:
                return await asyncio.wait_for(_wait(), timeout)
            except asyncio.TimeoutError:
                return {"ok": False, "kind": "timeout", "detail": f"welcome não recebido em {timeout:.0f}s"}
    except ConnectionClosed as e:
        code = e.rcvd.code if e.rcvd else None
        return {"ok": False, "kind": "closed", "detail": f"Conexão fechada (code {code})"}
    except InvalidStatus as e:
        return {"ok": False, "kind": "http", "detail": f"HTTP {e.response.status_code} no upgrade"}
    except (ProxyError, OSError, aiohttp.ClientError) as e:
        return {"ok": False, "kind": "network", "detail": f"Falha de proxy/rede: {type(e).__name__}"}


class AccountConnection:
    def __init__(self, account: AccountConfig, settings: Settings,
                 notifier: Notifier | None = None, daily: DailyStats | None = None):
        self.acc = account
        self.settings = settings
        self.notifier = notifier or Notifier("")
        self.daily = daily
        self._was_online = False          # já esteve ONLINE (evita alertar falha de 1ª conexão)
        self._down_since: float | None = None
        self._down_alerted = False
        self._silent_close = False                # o vigia de frames fechou a sessão (motivo próprio no aviso)
        self._online_since: float | None = None   # quando a sessão atual ficou ONLINE (None = não chegou)
        self._down_timer = None            # alerta de queda agendado (cancelado se a conta voltar logo)
        self._down_reason = ""
        self.state = State.DISCONNECTED
        self.manual_paused = False        # pausa manual acionada pelo usuário no painel
        self._active_ws = None            # socket ativo para fechar imediatamente ao pausar
        self._wake_event: asyncio.Event | None = None
        self.block: dict | None = None    # {kind, detail} quando BLOCKED
        self.last_reason = ""             # último motivo de queda/pausa, para o painel
        self.on_auth_status = None        # callback(acc_id, status, detail): painel/banco
        self.on_token_renewed = None      # callback(acc_id, novo_token)
        self.on_chat = None               # callback(conn, frame): frames de chat (ChatHub)
        self.on_ficha = None              # callback(conn, frame): ficha pública de um Pokémon (chat.verPokemon)
        self.on_pvp_month = None          # callback(conn, frame): Top PVP mensal (pvpMensal)
        self.on_pvp_table = None          # callback(conn, frame): página da tabela do PVP (Top 1.000)
        self.on_online = None             # async callback(conn): a conta acabou de ficar online
        self.on_capture = None            # callback(dict): grava tentativa de captura (k == "bola")
        self.chat_mute_until = 0.0        # ms epoch: mute de chat aplicado pelo jogo
        self.exit_ip = "?"
        self._last_frame = time.monotonic()
        self._no_proxy = account.proxy is None
        self.estado: dict = {}   # snapshot do welcome, mutado pelo HuntManager
        self.hunts: list = []
        self.mercado_cfg: dict = {}               # welcome.mercado (catálogo, preços mínimos...)
        self._rare_last: dict[int, int] | None = None   # baseline dos itens raros do servidor (ids >= 70000)
        self.pass_claim: dict | None = None        # último resgate do passe (resposta do jogo)
        self.pass_claim_seq = 0
        self.outland_tiers: list[dict] = normalize_tiers(None)   # welcome.outlandTiers (nível de cada tier de Outland)
        self.itens_nossos: dict[int, dict] = {}   # welcome.itensNossos: itens só do servidor (nome/ícone)
        self.session_started: float | None = None  # epoch do 1º ONLINE deste processo
        self.session_items = SessionItems()
        self.shinies = ShinyTracker()
        # sessão persistida: sobrevive a reinícios do bot (início + itens coletados)
        self._session_key = f"acc{account.index}"
        self.session_store = SessionStore.shared()
        saved = self.session_store.get(self._session_key)
        if saved:
            if isinstance(saved.get("started_at"), (int, float)):
                self.session_started = float(saved["started_at"])
            for k, v in (saved.get("gained") or {}).items():
                if k in self.session_items.gained and isinstance(v, int):
                    self.session_items.gained[k] = v
        if saved:
            shiny_saved = saved.get("shinies") or {}
            for key in ("seen", "captured"):
                value = shiny_saved.get(key)
                if type(value) is int and value >= 0:
                    setattr(self.shinies, key, value)
        self.hunt = HuntManager(account.name, self.estado, self.hunts)
        if self.daily:
            self.hunt.on_kill = lambda xp, gold: self.daily.add_kill(self.acc.nick, xp, gold)
        self.balls = BallManager(account.name, self.estado, account.ball_priority, enabled=account.auto_catch)
        self.shop = ShopManager(account.name, self.estado)
        self.shop.on_buy_error = self._on_buy_error
        self.market = MarketClient(account.name, self.estado)
        self.pending_hunt: str | None = None      # hunt pedida no painel, aguardando a trava de combate acabar
        self.farm_paused: bool = False            # conta online, mas parada no Centro Pokémon sem farmar
        self._farm_pause_pending_center: bool = False
        self._farm_resume_slug: str | None = None
        self._saved_auto_voltar_hunt: bool | None = None
        self._last_center_try_at: float = 0.0
        self._last_potion_fallback_at: float = 0.0
        self._last_auto_center_at: float = 0.0
        self._last_auto_hunt_at: float = 0.0
        self._center_return_slug: str | None = None
        self.restockers: list[AutoRestock] = []
        self.rebuild_restockers()
        self.inventory = InventoryView(self.estado)
        self.pvp = PvpManager(account.name, self.estado, auto=account.pvp_auto)
        self._log = logging.LoggerAdapter(log, {})

    def rebuild_restockers(self) -> None:
        """Reconstrói os restockers em tempo real quando o usuário liga/desliga no card."""
        self.restockers = []
        if self.acc.auto_potion:
            self.restockers.append(AutoRestock(
                self.acc.name, self.estado, self.shop, kind="item",
                get_ids=potion_ids_resolver(self.estado, self.hunt.active_pokemon, lambda: self.acc.potion_id),
                threshold=self.acc.potion_restock_threshold, qty=self.acc.potion_restock_qty,
                gold_reserve=lambda: self.acc.gold_reserve))
        if self.acc.auto_ball_restock:
            self.restockers.append(AutoRestock(
                self.acc.name, self.estado, self.shop, kind="ball",
                get_ids=ball_ids_resolver(self.estado, self.acc.ball_priority, lambda: self.acc.ball_id),
                threshold=self.acc.ball_restock_threshold, qty=self.acc.ball_restock_qty,
                gold_reserve=lambda: self.acc.gold_reserve))

    # ------------------------------------------------------------------ logs
    def _set(self, state: State, msg: str = "", reason: str = "") -> None:
        self.state = state
        # Nunca logar token/credenciais de proxy.
        proxy_label = "DIRETO (sem proxy)" if self._no_proxy else self.acc.proxy.label
        log.info("[%s] %-15s ip=%s proxy=%s %s", self.acc.name, state.value,
                 self.exit_ip, proxy_label, msg)
        self._alert_state(state, reason)

    def _alert_state(self, state: State, reason: str) -> None:
        """Avisa no Discord a queda (1x por queda) e a volta, com o tempo fora.
        Título = nick da conta (sem o prefixo ACCn: usado só nos logs)."""
        if state == State.PAUSED_MANUAL:
            self._cancel_down_timer()
            return
        if state == State.ONLINE:
            self._cancel_down_timer()
            if self._down_alerted and self._down_since is not None:
                self.notifier.send(
                    self.acc.nick, "🟢 Voltou ao ar.", GREEN,
                    [("Tempo fora", fmt_duration(time.time() - self._down_since), True)])
            self._was_online, self._down_since, self._down_alerted = True, None, False
        elif state in (State.DISCONNECTED, State.PAUSED_COOLDOWN, State.BLOCKED) and self._was_online:
            if self._down_since is None:
                self._down_since = time.time()
            if self._down_alerted:
                return
            # Queda comum (o jogo reinicia o servidor e a conta volta em ~10s): só avisa se continuar fora depois de
            # DOWN_ALERT_DELAY_S. Pausa e bloqueio precisam do usuário: avisam na hora.
            if state == State.DISCONNECTED and config.down_alert_delay() > 0:
                self._down_reason = reason
                if self._down_timer is None:
                    try:
                        loop = asyncio.get_running_loop()
                    except RuntimeError:
                        loop = None
                    if loop is not None:
                        self._down_timer = loop.call_later(config.down_alert_delay(), self._send_down_alert)
                        return
            self._send_down_alert(reason)

    def _send_down_alert(self, reason: str | None = None) -> None:
        self._cancel_down_timer()
        if self._down_alerted:
            return
        self._down_alerted = True
        motivo = reason or self._down_reason or "queda de conexão"
        self.notifier.send(self.acc.nick, "🔴 Caiu.", RED, [("Motivo", motivo, False)])

    def _cancel_down_timer(self) -> None:
        if self._down_timer is not None:
            self._down_timer.cancel()
            self._down_timer = None

    # ----------------------------------------------------------- proxy utils
    async def _probe_exit_ip(self) -> str:
        """Descobre o IP de saída real (via proxy, ou direto se não configurado)."""
        return await probe_exit_ip(None if self._no_proxy else self.acc.proxy)

    async def _open_tunnel(self):
        """Abre socket TCP até o servidor do jogo via proxy. Só chamada quando há proxy."""
        return await open_tunnel(self.acc, self.settings.ws_url)

    # ----------------------------------------------------------- handshake
    def _hello(self) -> str:
        return build_hello(self.acc)

    def _check_erro(self, msg: dict) -> None:
        """Transforma frames de recusa do jogo em exceções: o bot para (ou espera) em vez de
        ficar reconectando sem adiantar. Não loga o token."""
        if msg.get("t") != "erro":
            return
        chave = msg.get("chave") or ""
        if chave in BLOCKING_KEYS:
            kind, detail = BLOCKING_KEYS[chave]
            if kind == "banned" and msg.get("motivoBan"):
                detail = f"{detail}: {msg['motivoBan']}"
            raise AccountBlocked(kind, detail)
        if chave in NETWORK_FULL_KEYS:
            raise NetworkFull(chave)

    async def _wait_welcome(self, ws) -> dict:
        """Aguarda 'welcome' por até 15s; ignora frames de outro tipo antes dele."""
        async def _loop():
            async for raw in ws:
                msg = _parse(raw)
                self._check_erro(msg)
                if msg.get("t") == "welcome":
                    return msg
        try:
            return await asyncio.wait_for(_loop(), config.WELCOME_TIMEOUT)
        except asyncio.TimeoutError:
            raise ConnectionError(f"welcome não recebido em {config.WELCOME_TIMEOUT}s")

    # ----------------------------------------------------------- sessão
    async def _session(self) -> None:
        self._set(State.CONNECTING, "abrindo túnel" if not self._no_proxy else "conectando direto")
        self.exit_ip = await self._probe_exit_ip()

        u = urlparse(self.settings.ws_url)
        ssl_ctx = ssl.create_default_context() if u.scheme == "wss" else None
        # Sem proxy: deixa o websockets abrir a conexão TCP/TLS ele mesmo.
        # Com proxy: o túnel já chega conectado via Proxy.connect(), então
        # passamos o socket pronto com sock= e pulamos a resolução de host.
        sock = None if self._no_proxy else await self._open_tunnel()
        connect_kwargs = {}
        if sock is not None:
            connect_kwargs["sock"] = sock
            connect_kwargs["server_hostname"] = u.hostname if ssl_ctx else None
        try:
            async with connect(
                self.settings.ws_url,
                ssl=ssl_ctx,
                **connect_kwargs,
                # Heartbeat: ping a cada 30s; sem pong em 90s => ConnectionClosed.
                ping_interval=config.PING_INTERVAL,
                ping_timeout=config.PING_TIMEOUT,
                max_size=None,             # 'welcome' é um snapshot grande
                open_timeout=20,
            ) as ws:
                self._active_ws = ws
                self._set(State.AUTHENTICATING, "hello enviado")
                await ws.send(self._hello())
                welcome = await self._wait_welcome(ws)
                # in-place: self.estado/self.hunts são os mesmos objetos que o
                # HuntManager já referencia (passados por self.hunt no __init__).
                self.estado.clear()
                self.estado.update(welcome.get("estado", {}))
                self.hunts.clear()
                self.hunts.extend(welcome.get("hunts", []))
                self.itens_nossos = {int(i["id"]): i for i in welcome.get("itensNossos", [])
                                     if isinstance(i, dict) and "id" in i}
                self.outland_tiers = normalize_tiers(welcome.get("outlandTiers"))
                m = welcome.get("mercado")  # catálogo da vitrine + limites (preço mínimo, espera de compra)
                self.mercado_cfg = m if isinstance(m, dict) else {}
                if self.session_started is None:
                    self.session_started = time.time()
                    self._save_session()
                if isinstance(self.estado.get("servidorAgora"), (int, float)):
                    self.market.note_server_time(self.estado["servidorAgora"])
                self.session_items.reset(self.estado)
                self._rare_last = self._rare_counts()
                self.block = None
                self.last_reason = ""
                self._online_since = time.monotonic()
                self._set(State.ONLINE, f"welcome ok level={self.estado.get('level')}")
                if self.on_auth_status:
                    self.on_auth_status(self.acc.index, "ok", "")

                self.hunt.on_welcome()
                self.hunt.bind(ws)
                self.balls.bind(ws)
                self.shop.bind(ws)
                self.market.bind(ws)
                self.pvp.bind(ws)
                if self.farm_paused:
                    self._farm_pause_pending_center = True
                elif self.acc.hunt_slug and self.acc.hunt_slug != self.estado.get("huntSlug"):
                    await self.hunt.select_hunt(self.acc.hunt_slug)
                if self.on_online:
                    try:
                        await self.on_online(self)
                    except Exception:           # o chat é acessório: nunca derruba a conta
                        log.exception("[%s] falha ao preparar o chat", self.acc.name)

                # Tarefas de background rodam em paralelo só enquanto a conexão
                # viver; quando a sessão acaba (com ou sem erro), são canceladas.
                background = [
                    asyncio.create_task(self._status_logger()),
                    asyncio.create_task(self._frame_watchdog(ws)),
                    asyncio.create_task(self._inventory_logger()),
                    asyncio.create_task(self._hunt_queue_loop()),
                    asyncio.create_task(self._safety_loop()),
                    asyncio.create_task(self.balls.run_forever()),
                    asyncio.create_task(self._auto_restock_loop()),
                    asyncio.create_task(self.pvp.run_forever(lambda: int(self.estado.get("level") or 0))),
                ]

                recv_task = asyncio.create_task(self._recv_loop(ws))
                try:
                    await recv_task
                finally:
                    self._active_ws = None
                    self.market.unbind()
                    self.pvp.unbind()
                    for t in background:
                        t.cancel()
                    await asyncio.gather(*background, return_exceptions=True)
        except InvalidStatus as e:  # rejeição HTTP no upgrade
            code = e.response.status_code
            if code in (401, 403):
                raise AuthRejected(f"HTTP {code}") from e
            raise

    async def _recv_loop(self, ws) -> None:
        """Loop de leitura. Frames de hunt/combate/estado vão para o HuntManager;
        futuros handlers (inventário, balls, etc.) plugam aqui do mesmo jeito."""
        self._last_frame = time.monotonic()
        try:
            async for raw in ws:
                self._last_frame = time.monotonic()
                msg = _parse(raw)
                self._check_erro(msg)
                if msg.get("t") == "sessao.renovada" and msg.get("token"):
                    # O jogo renova o token da sessão; sem guardar o novo, o antigo vence.
                    self.acc = replace(self.acc, token=str(msg["token"]))
                    if self.on_token_renewed:
                        self.on_token_renewed(self.acc.index, self.acc.token)
                    continue
                if msg.get("t") == "passe":
                    self._on_pass(msg)
                if self.on_chat and str(msg.get("t", "")).startswith("chat"):
                    self.on_chat(self, msg)
                self._track_shinies(msg)
                self.hunt.handle_frame(msg)
                self.balls.handle_frame(msg)
                self._record_captures(msg)
                self.shop.handle_frame(msg)
                self.market.handle_frame(msg)
                self.pvp.handle_frame(msg)
                if msg.get("t") == "ranking.ficha" and self.on_ficha:
                    self.on_ficha(self, msg)
                if msg.get("t") == "pvpMensal" and self.on_pvp_month:
                    self.on_pvp_month(self, msg)
                if msg.get("t") == "pvpTabela" and self.on_pvp_table:
                    self.on_pvp_table(self, msg)
                self._check_server_rares()
                before = dict(self.session_items.gained)
                self.session_items.update(self.estado)
                if self.session_items.gained != before:
                    self._on_rare_items(before)
                    self._save_session()
        except ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd else None
            if code in self.settings.external_login_codes:
                # 4001 confirmado por teste real = login externo; os demais códigos
                # desse conjunto (ex. 4003 "provedor-banido") têm outra causa, não
                # documentada como "login externo" — não generalizar o motivo.
                sufixo = " (login externo)" if code == 4001 else ""
                raise AuthRejected(f"close code {code}{sufixo}") from e
            raise

    async def _frame_watchdog(self, ws) -> None:
        """Reconecta uma sessão "zumbi": o servidor do jogo continua respondendo ao ping, mas para de mandar
        frames (a conta fica ONLINE e sem farmar, sem nenhum erro). Com hunt ativa o jogo manda frames o tempo
        todo; passando FRAME_SILENCE_S sem nenhum, fecha o socket e o supervisor reconecta (novo welcome)."""
        while True:
            await asyncio.sleep(config.FRAME_CHECK_S)
            if self.is_in_center() or not self.estado.get("huntSlug"):
                self._last_frame = time.monotonic()      # no Centro ou sem hunt não há frames contínuos de combate
                continue
            quiet = time.monotonic() - self._last_frame
            if quiet >= config.FRAME_SILENCE_S:
                log.warning("[%s] sem frames do jogo há %.0fs (sessão travada); reconectando", self.acc.name, quiet)
                self.last_reason = "O jogo parou de responder; reconectando."
                self._silent_close = True
                await ws.close(code=4000, reason="sem frames")
                return

    def _on_buy_error(self, kind: str, item_id: int, qty: int, reason: str) -> None:
        from game_data import BALL_NAMES

        if kind == "ball":
            label = BALL_NAMES.get(item_id) or f"Bola #{item_id}"
        else:
            nos = self.itens_nossos.get(item_id) or {}
            label = nos.get("name") or item_name(item_id) or f"Item #{item_id}"
        gold = int(self.estado.get("gold") or 0)
        self.hunt._push_live_event("buy_error", name=label, qty=qty, reason=reason)
        if self.notifier:
            self.notifier.send(
                f"{self.acc.nick} — Erro na compra automática",
                f"❌ Não foi possível comprar **{qty}× {label}**.",
                RED,
                [("Motivo", reason, False), ("Gold atual", f"{gold:,}", True)],
            )

    def _on_pass(self, msg: dict) -> None:
        r = msg.get("resgate")
        if isinstance(r, dict):
            self.pass_claim = {"degrau": r.get("degrau"), "premios": r.get("premios") or []}
            self.pass_claim_seq += 1
            log.info("[%s] passe resgatado: dia %s", self.acc.name, r.get("degrau"))

    def server_now_ms(self) -> int:
        return self.market.server_now_ms()

    def pass_status(self) -> str:
        """'ok' se dá para resgatar agora; senão o motivo ('nivel', 'ja_resgatado')."""
        if (self.estado.get("level") or 0) < PASSE_NIVEL_MIN:
            return "nivel"
        return "ok" if pode_resgatar(self.estado.get("passe"), self.server_now_ms()) else "ja_resgatado"

    async def claim_pass(self) -> None:
        if not self.can_send:
            raise RuntimeError("conta offline")
        await self.hunt._ws.send(json.dumps({"t": "passe.resgatar"}))
        log.info("[%s] passe.resgatar enviado", self.acc.name)

    def outland_tier(self) -> dict:
        """O tier de Outland em vigor nesta conta (o escolhido, limitado pelo nível do treinador)."""
        return effective_tier(self.outland_tiers, self.estado.get("outlandTier"), self.estado.get("level"))

    def _save_session(self) -> None:
        self.session_store.save(self._session_key, self.session_started, self.session_items.gained,
                                {"seen": self.shinies.seen, "captured": self.shinies.captured})

    def _track_shinies(self, msg: dict) -> None:
        if msg.get("t") != "batalha":
            return
        for event in msg.get("ev", []):
            seen, captured = self.shinies.handle(event)
            if seen or captured:
                self._save_session()
                name = event.get("nome")
                if not name and event.get("slot") in self.shinies.encounters:
                    name = self.shinies.encounters[event["slot"]].get("name")
                label = f" **{name}**" if name else ""
                outcome = "capturou" if captured else "encontrou"
                self.notifier.send(self.acc.nick, f"✨ {outcome} um shiny{label}!", GOLD)

    def _record_captures(self, msg: dict) -> None:
        if not self.on_capture or msg.get("t") != "batalha":
            return
        slug = (self.hunt.session.slug if self.hunt.session else None) or self.estado.get("huntSlug") or ""
        for ev in msg.get("ev", []):
            if ev.get("k") != "bola":
                continue
            slot = ev.get("slot")
            ls = self.hunt.live_slots.get(slot) if slot is not None else None
            enc = self.shinies.encounters.get(slot) if slot is not None else None
            name = (ev.get("nome") or (ls or {}).get("name") or (enc or {}).get("name") or "").strip()
            pid = (ls or {}).get("pokeId")
            look = (ls or {}).get("looktype")
            level = ev.get("level") if ev.get("level") is not None else (ls or {}).get("level")
            if not name and slug:
                h = next((x for x in self.hunts if isinstance(x, dict) and x.get("slug") == slug), None)
                if h and (h.get("especies") or []):
                    sp = h["especies"][0]
                    name = sp.get("nome") or h.get("nome") or slug
                    pid = pid or sp.get("pokeId")
            try:
                self.on_capture({
                    "ts": int(time.time() * 1000),
                    "account_id": self.acc.index,
                    "account_nick": self.acc.nick,
                    "pokemon_name": name or (f"Selvagem #{slot}" if slot is not None else "Pokémon"),
                    "poke_id": pid,
                    "looktype": look or (60000 + int(pid) if pid and 1 <= int(pid) <= 1025 else None),
                    "level": level,
                    "shiny": bool(ev.get("shiny") or (ls or {}).get("shiny")),
                    "ball_id": ev.get("ballId"),
                    "success": bool(ev.get("sucesso")),
                    "chance": round((ev.get("chance") or 0) * 100, 1) if ev.get("chance") is not None else None,
                    "hunt_slug": slug,
                })
            except Exception:  # noqa: BLE001
                log.debug("[%s] erro ao gravar histórico de captura", self.acc.name)

    # Itens raros do próprio servidor (Mystery Egg, fichas novas...): ids >= 70000 marcados como raros no
    # `welcome.itensNossos`. Os 4 acompanhados em session_stats têm tratamento próprio; o Boss Token não avisa.
    _NOT_RARE_CATEGORIES = frozenset({"stone", "heal", "revive"})

    def _rare_counts(self) -> dict[int, int]:
        skip = {i for ids in TRACKED.values() for i in ids}
        out: dict[int, int] = {}
        for raw_id, qty in (self.estado.get("items") or {}).items():
            try:
                iid, qty = int(raw_id), int(qty)
            except (TypeError, ValueError):
                continue
            if iid < 70000 or iid in skip:
                continue
            nos = self.itens_nossos.get(iid) or {}
            if nos.get("rare") is False or nos.get("category") in self._NOT_RARE_CATEGORIES:
                continue
            out[iid] = qty
        return out

    def _check_server_rares(self) -> None:
        if self._rare_last is None:
            return
        now = self._rare_counts()
        for iid, qty in now.items():
            n = qty - self._rare_last.get(iid, 0)
            if n <= 0:
                continue
            nos = self.itens_nossos.get(iid) or {}
            label = nos.get("name") or item_name(iid)
            key = f"i{iid}"
            ITEM_LABELS[key] = label
            total = self.daily.add_item(self.acc.nick, key, n) if self.daily else n
            icon = nos.get("icon")
            thumb = None
            if icon:
                thumb = "https://pokeidle.io" + (icon if str(icon).startswith("/") else f"/assets/{icon}")
            self.notifier.send(self.acc.nick, f"💎 pegou **{n}× {label}**", GOLD,
                               [("Total no dia", str(total), True)], thumbnail=thumb)
        self._rare_last = now

    def _on_rare_items(self, before: dict[str, int]) -> None:
        """Avisa no Discord cada item raro novo da sessão, exceto o Boss Token
        (o usuário pediu para não ser notificado desse, mas ele continua
        contado no relatório diário normalmente)."""
        for key, now in self.session_items.gained.items():
            n = now - before.get(key, 0)
            if n <= 0:
                continue
            total = self.daily.add_item(self.acc.nick, key, n) if self.daily else n
            if key == "boss":
                continue
            label = ITEM_LABELS.get(key, key)
            self.notifier.send(self.acc.nick, f"💎 pegou **{n}× {label}**", GOLD,
                               [("Total no dia", str(total), True)], thumbnail=rare_icon_url(key))

    async def _status_logger(self) -> None:
        """Loga periodicamente Pokémon ativo, HP, XP/h, Gold/h, progresso da
        hunt e um resumo compacto do inventário (balls/potions/pokémons)."""
        while True:
            await asyncio.sleep(config.STATUS_LOG_INTERVAL)
            log.info("[%s] %s | capturas=%s falhas=%s | %s", self.acc.name,
                     self.hunt.status_line(), self.balls.caught, self.balls.failed,
                     self.inventory.summary_line())

    async def _inventory_logger(self) -> None:
        """Relatório detalhado de inventário (todos os items, pokémons,
        pokédex), num intervalo mais espaçado que o status compacto."""
        while True:
            await asyncio.sleep(config.INVENTORY_LOG_INTERVAL)
            for line in self.inventory.full_report().splitlines():
                log.info("[%s] %s", self.acc.name, line)

    async def _auto_restock_loop(self) -> None:
        """Verifica periodicamente o estoque da Potion e da Ball equipadas e
        repõe via shop.buy (uma compra por vez, aguardando k:"compra")."""
        while True:
            await asyncio.sleep(config.POTION_CHECK_INTERVAL_S)
            for r in self.restockers:
                await r.check_and_restock()

    async def _safety_loop(self) -> None:
        """Proteções automáticas:
        1) Fallback de poção: se a poção equipada zerar e não houver recompra ativa (ou gold abaixo da reserva),
           equipa automaticamente a próxima poção disponível na mochila.
        2) Auto-Centro Pokémon: se o HP cair abaixo do limiar configurado sem poções disponíveis,
           manda o personagem ao Centro Pokémon e retorna à hunt quando curar.
        """
        while True:
            await asyncio.sleep(3.0)
            if not self.can_send:
                continue
            try:
                await self._check_farm_pause()
                await self._check_potion_fallback()
                await self._check_auto_center()
                await self._check_auto_hunt()
            except Exception as e:  # noqa: BLE001
                log.debug("[%s] safety_loop erro ignorado: %r", self.acc.name, e)

    def is_in_center(self) -> bool:
        """True quando o servidor confirma que a conta está no Centro Pokémon (`estado.noCentro` ou `campo.init`)."""
        return bool(self.estado.get("noCentro")) or self.hunt.campo_map == "centro"

    def current_location(self) -> dict:
        """Local atual exato da conta (mesma lógica do cliente oficial `app.js`)."""
        est = self.estado
        if est.get("noCentro") or self.hunt.campo_map == "centro":
            return {"kind": "center", "label": "Centro Pokémon", "detail": None, "inCenter": True, "inHunt": False}
        if isinstance(est.get("casa"), dict) and est["casa"].get("dentro"):
            return {"kind": "house", "label": "Casa", "detail": None, "inCenter": False, "inHunt": False}
        boss = est.get("boss") if isinstance(est.get("boss"), dict) else None
        arena = boss.get("arena") if isinstance(boss, dict) else None
        if isinstance(arena, dict) and arena:
            detail = arena.get("nome") or arena.get("key")
            return {"kind": "boss", "label": "Arena de Boss", "detail": detail, "inCenter": False, "inHunt": False}
        if est.get("mistico"):
            return {"kind": "mythic", "label": "Encontro Místico", "detail": None, "inCenter": False, "inHunt": False}
        if isinstance(est.get("safari"), dict) and est["safari"].get("dentro"):
            return {"kind": "safari", "label": "Zona Safari", "detail": None, "inCenter": False, "inHunt": True}
        slug = est.get("huntSlug") or (self.hunt.session.slug if self.hunt.session else None)
        if slug:
            h = next((x for x in self.hunts if isinstance(x, dict) and x.get("slug") == slug), None)
            hname = (h.get("nome") if h else None) or (self.hunt.session.nome if self.hunt.session else None) or slug
            return {"kind": "hunt", "label": f"Hunt: {hname}", "detail": hname, "slug": slug, "inCenter": False, "inHunt": True}
        return {"kind": "idle", "label": "Fora de hunt", "detail": None, "inCenter": False, "inHunt": False}

    async def _disable_server_auto_return_hunt(self) -> None:
        """Desliga `autoVoltarHunt` no servidor enquanto o farm estiver pausado — evita o jogo devolver
        a conta para a hunt sozinho após morrer ou curar no Centro Pokémon."""
        auto = self.estado.get("automation")
        if not isinstance(auto, dict):
            return
        if auto.get("autoVoltarHunt"):
            if self._saved_auto_voltar_hunt is None:
                self._saved_auto_voltar_hunt = True
            if self.can_send:
                await self.set_automation({"autoVoltarHunt": False})
                auto["autoVoltarHunt"] = False
                log.info("[%s] autoVoltarHunt desativado no servidor durante pausa do farm", self.acc.name)

    async def set_farm_pause(self, paused: bool, *, force: str | None = None) -> dict:
        """Pausa o farm mantendo a conta ONLINE: desliga `autoVoltarHunt`, envia ao Centro Pokémon e
        mantém a conta lá até retomar. `force='rope'` usa Escape Rope; `force='forfeit'` usa `centro.desistir`."""
        self.farm_paused = bool(paused)
        if self.farm_paused:
            cur_slug = self.estado.get("huntSlug") or (self.hunt.session.slug if self.hunt.session else None)
            if cur_slug:
                self._farm_resume_slug = cur_slug
            self.pending_hunt = None
            self._center_return_slug = None
            await self._disable_server_auto_return_hunt()

            if self.is_in_center():
                self._farm_pause_pending_center = False
                log.info("[%s] farm pausado: conta já está no Centro Pokémon", self.acc.name)
                return {"ok": True, "farmPaused": True, "sentCenter": True, "queued": False, "inCenter": True}

            if self.can_send and force == "rope":
                ropes = int((self.estado.get("items") or {}).get("70010", 0) or 0)
                if ropes <= 0:
                    raise RuntimeError("A conta não tem Escape Rope na mochila.")
                await self.hunt.use_escape_rope()
                self._last_center_try_at = time.monotonic()
                self._farm_pause_pending_center = True
                self.hunt._push_live_event("center", name=self.acc.nick, manual=True, method="rope")
                return {"ok": True, "farmPaused": True, "sentCenter": True, "queued": False, "method": "rope"}

            if self.can_send and force == "forfeit":
                await self.hunt.forfeit_combat()
                self._last_center_try_at = time.monotonic()
                self._farm_pause_pending_center = True
                self.hunt._push_live_event("center", name=self.acc.nick, manual=True, method="forfeit")
                return {"ok": True, "farmPaused": True, "sentCenter": True, "queued": False, "method": "forfeit"}

            # Sempre mantém pendente até o servidor confirmar `noCentro == True` (evita perder se um hit chegar na hora).
            self._farm_pause_pending_center = True
            if self.can_send and self.combat_lock_ms() == 0:
                await self.hunt.go_to_center()
                self._last_center_try_at = time.monotonic()
                self.hunt._push_live_event("center", name=self.acc.nick, manual=True)
                log.info("[%s] farm pausado: centro.ir enviado (aguardando confirmação noCentro)", self.acc.name)
                return {"ok": True, "farmPaused": True, "sentCenter": True, "queued": False}
            log.info("[%s] farm pausado: aguardando fim do combate para ir ao Centro Pokémon", self.acc.name)
            return {"ok": True, "farmPaused": True, "sentCenter": False, "queued": True}
        else:
            self._farm_pause_pending_center = False
            if self._saved_auto_voltar_hunt and self.can_send:
                try:
                    await self.set_automation({"autoVoltarHunt": True})
                    self.estado.setdefault("automation", {})["autoVoltarHunt"] = True
                except Exception:  # noqa: BLE001
                    pass
            self._saved_auto_voltar_hunt = None
            target = self._farm_resume_slug or self.acc.hunt_slug
            if target and self.can_send:
                if self.combat_lock_ms() > 0:
                    self.queue_hunt(target)
                else:
                    await self.hunt.select_hunt(target)
            log.info("[%s] farm retomado (alvo=%s)", self.acc.name, target)
            return {"ok": True, "farmPaused": False, "resumeSlug": target}

    async def _check_farm_pause(self) -> None:
        if not self.farm_paused or not self.can_send:
            return
        if self.is_in_center():
            if self._farm_pause_pending_center:
                self._farm_pause_pending_center = False
                log.info("[%s] conta confirmada no Centro Pokémon (farm pausado)", self.acc.name)
            return
        # Conta não está no centro enquanto farm está pausado: garante autoVoltarHunt desligado e envia centro.ir.
        self._farm_pause_pending_center = True
        await self._disable_server_auto_return_hunt()
        if self.combat_lock_ms() > 0:
            return
        now = time.monotonic()
        if now - self._last_center_try_at < 1.5:
            return
        self._last_center_try_at = now
        await self.hunt.go_to_center()
        log.info("[%s] combate livre: enviando centro.ir (farm pausado)", self.acc.name)

    def _pick_best_hunt_for_level(self) -> dict | None:
        """Escolhe a melhor hunt liberada pelo nível do treinador (respeitando filtro de região)."""
        level = int(self.estado.get("level") or 0)
        region_filter = (self.acc.auto_best_hunt_region or "all").strip().lower()
        candidates: list[dict] = []
        for h in self.hunts:
            if not isinstance(h, dict) or not h.get("slug"):
                continue
            req_lvl = int(h.get("nivel") or 0)
            if req_lvl > level:
                continue
            if region_filter != "all":
                h_reg = str(h.get("regiao") or h.get("area") or "").strip().lower()
                if h_reg != region_filter:
                    continue
            candidates.append(h)
        if not candidates:
            return None
        candidates.sort(key=lambda h: (int(h.get("nivel") or 0), int(h.get("totalSpawns") or 0)), reverse=True)
        return candidates[0]

    async def _check_auto_hunt(self) -> None:
        if self.farm_paused or self._center_return_slug:
            return
        now = time.monotonic()
        if now - self._last_auto_hunt_at < 20.0:
            return
        cur_slug = (self.hunt.session.slug if self.hunt.session else None) or self.estado.get("huntSlug")
        if self.acc.auto_best_hunt:
            best = self._pick_best_hunt_for_level()
            if best and best["slug"] != cur_slug and self.pending_hunt != best["slug"]:
                self._last_auto_hunt_at = now
                self.queue_hunt(best["slug"])
                bname = best.get("nome") or best["slug"]
                log.info("[%s] Auto-Hunt: trocando para %s (Nv.%s)", self.acc.name, bname, best.get("nivel"))
                if self.notifier:
                    self.notifier.send(
                        self.acc.nick,
                        f"🗺️ **Auto-Hunt:** trocando automaticamente para **{bname}** (Nv. {best.get('nivel', 0)}).",
                        GREEN,
                    )
        elif self.acc.hunt_slug:
            target = self.acc.hunt_slug
            if target != cur_slug and self.pending_hunt != target:
                if any(isinstance(h, dict) and h.get("slug") == target for h in self.hunts):
                    self._last_auto_hunt_at = now
                    self.queue_hunt(target)

    def _potion_stock(self, pid: int) -> int:
        return int((self.estado.get("items") or {}).get(str(pid), 0) or 0)

    async def _check_potion_fallback(self) -> None:
        if not self.acc.auto_potion_fallback:
            return
        # Se a autocompra de poções está ligada E o gold permite comprar, deixa o AutoRestock repor primeiro.
        if self.acc.auto_potion:
            reserve = max(0, int(self.acc.gold_reserve or 0))
            if reserve == 0 or int(self.estado.get("gold") or 0) > reserve:
                return
        now = time.monotonic()
        if now - self._last_potion_fallback_at < 15.0:
            return
        auto = self.estado.get("automation") or {}
        cur_ids = [int(x) for x in (auto.get("potionIds") or []) if int(x) in KNOWN_POTION_IDS]
        cur_id = cur_ids[0] if cur_ids else self.acc.potion_id
        if cur_id is not None and self._potion_stock(cur_id) > 0:
            return
        next_id = next((pid for pid in POTION_FALLBACK_ORDER if pid != cur_id and self._potion_stock(pid) > 0), None)
        if next_id is None:
            return
        self._last_potion_fallback_at = now
        await self.set_automation({"potionIds": [next_id]})
        self.acc = replace(self.acc, potion_id=next_id)
        pname = item_name(next_id) or f"Poção #{next_id}"
        self.hunt._push_live_event("potion", name=pname, qty=self._potion_stock(next_id))
        log.info("[%s] fallback de poção: trocado para %s (estoque=%d)",
                 self.acc.name, pname, self._potion_stock(next_id))

    async def _check_auto_center(self) -> None:
        if not self.acc.auto_center or self.farm_paused:
            return
        pk = self.hunt.active_pokemon()
        if not pk:
            return
        hp = int(pk.get("hp") or 0)
        max_hp = int(pk.get("maxHp") or 0)
        if max_hp <= 0:
            return
        hp_pct = (hp / max_hp) * 100.0
        # Se já voltou ao normal depois de ir ao centro, retoma a hunt anterior se necessário.
        if self._center_return_slug and hp_pct >= 95.0:
            ret_slug = self._center_return_slug
            self._center_return_slug = None
            cur_slug = self.hunt.session.slug if self.hunt.session else self.estado.get("huntSlug")
            if cur_slug != ret_slug and self.combat_lock_ms() == 0:
                await self.hunt.select_hunt(ret_slug)
            return
        if hp <= 0 or hp_pct > self.acc.auto_center_hp_pct:
            return
        # Só aciona se realmente não houver poções para curar (ou autoPotion desligado).
        has_any_potion = any(self._potion_stock(pid) > 0 for pid in KNOWN_POTION_IDS)
        auto_on = bool((self.estado.get("automation") or {}).get("autoPotion", True))
        if has_any_potion and auto_on:
            return
        now = time.monotonic()
        if now - self._last_auto_center_at < 45.0:
            return
        if self.combat_lock_ms() > 0:
            return
        self._last_auto_center_at = now
        cur_slug = self.hunt.session.slug if self.hunt.session else self.estado.get("huntSlug")
        if cur_slug:
            self._center_return_slug = cur_slug
        await self.hunt.go_to_center()
        self.hunt._push_live_event("center", name=pk.get("nome"), hpPct=round(hp_pct, 1))
        log.warning("[%s] Auto-Centro acionado: %s com %.0f%% HP sem poções",
                    self.acc.name, pk.get("nome", "?"), hp_pct)
        if self.notifier:
            self.notifier.send(
                self.acc.nick,
                f"🏥 **Auto-Centro de emergência:** {pk.get('nome', 'Pokémon')} atingiu **{hp_pct:.0f}% HP** sem poções.",
                GOLD,
            )

    # ----------------------------------------------------------- comandos do painel
    @property
    def can_send(self) -> bool:
        return self.state == State.ONLINE and self.hunt._ws is not None

    async def send_frame(self, frame: dict) -> None:
        """Manda um frame qualquer ao jogo por esta conta (só online)."""
        if not self.can_send:
            raise RuntimeError("conta offline")
        await self.hunt._ws.send(json.dumps(frame, ensure_ascii=False))

    async def set_automation(self, patch: dict) -> None:
        """auto.set (confirmado em conta real): clona a automação atual inteira, troca só `patch` e envia.
        Nunca monta o frame do zero: campos que o painel não edita seguem como o jogo os mandou."""
        if not self.can_send:
            raise RuntimeError("conta offline")
        current = dict(self.estado.get("automation") or {})
        await self.hunt._ws.send(json.dumps({"t": "auto.set", **current, **patch}))
        log.info("[%s] auto.set %s enviado", self.acc.name, sorted(patch))

    def combat_lock_ms(self) -> int:
        """Quanto falta (ms) para a conta poder trocar de hunt/ir ao Center. `estado.centroLivreEm` é a hora do
        servidor em que a trava de combate acaba (docs/02); cada hit recebido a reinicia."""
        free_at = self.estado.get("centroLivreEm")
        if not isinstance(free_at, (int, float)):
            return 0
        return max(0, int(free_at) - self.market.server_now_ms())

    def reset_session(self) -> None:
        """Zera a sessão (tempo e itens coletados do card). Não mexe na conta, só nas estatísticas do painel."""
        self.session_started = time.time()
        for k in self.session_items.gained:
            self.session_items.gained[k] = 0
        self.session_items.reset(self.estado)   # novo ponto de partida para contar aumentos
        self.shinies.seen = 0
        self.shinies.captured = 0
        self.balls.caught = 0
        self.balls.failed = 0
        self._save_session()
        log.info("[%s] sessão zerada pelo painel", self.acc.name)

    def queue_hunt(self, slug: str | None) -> None:
        """Guarda a hunt desejada: troca sozinha assim que a trava de combate acabar (None cancela)."""
        self.pending_hunt = slug
        log.info("[%s] hunt na fila: %s", self.acc.name, slug)

    async def _hunt_queue_loop(self) -> None:
        """Envia `hunt.select` da hunt na fila quando a trava de combate acaba e só dá a fila por cumprida
        quando o jogo confirma (evento `hunt`). Se o jogo ignorar (ex.: um hit chegou na hora), tenta de novo."""
        attempts = 0
        while True:
            await asyncio.sleep(0.25)
            if self.farm_paused:
                try:
                    await self._check_farm_pause()
                except Exception as e:  # noqa: BLE001
                    log.debug("[%s] check_farm_pause erro: %r", self.acc.name, e)
                attempts = 0
                continue
            slug = self.pending_hunt
            if not slug:
                attempts = 0
                continue
            s = self.hunt.session
            if s is not None and s.slug == slug:
                self.pending_hunt = None
                continue
            if self.combat_lock_ms() > 0 or not self.can_send:
                continue
            try:
                await self.hunt.select_hunt(slug)
            except Exception as e:  # conexão caiu no envio: a fila continua e tenta de novo quando voltar
                log.warning("[%s] não consegui enviar a hunt da fila (%s)", self.acc.name, type(e).__name__)
                await asyncio.sleep(1)
                continue
            attempts += 1
            for _ in range(24):  # até 6s pela confirmação
                await asyncio.sleep(0.25)
                s = self.hunt.session
                if (s is not None and s.slug == slug) or self.pending_hunt != slug:
                    break
            else:
                if attempts >= 4:
                    log.warning("[%s] o jogo não aceitou a hunt %s após %d tentativas; fila cancelada",
                                self.acc.name, slug, attempts)
                    self.pending_hunt = None
                    attempts = 0
                continue
            if self.pending_hunt == slug:
                self.pending_hunt = None
            attempts = 0

    async def restock_now(self, kind: str) -> None:
        """Roda já a reposição de `kind` ("item" = poção, "ball"), sem esperar o próximo ciclo
        (usado logo após trocar poção/bola no painel). Só mexe no tipo pedido."""
        for r in self.restockers:
            if r.kind == kind:
                r._last_try.clear()
                await r.check_and_restock()

    async def set_manual_pause(self, paused: bool) -> None:
        """Pausa ou retoma manualmente a conta mantendo o card visível no Dashboard."""
        self.manual_paused = bool(paused)
        if self.manual_paused:
            self._cancel_down_timer()
            self.last_reason = "Pausada manualmente pelo painel."
            ws = self._active_ws
            if ws is not None:
                try:
                    await ws.close(code=1000, reason="pausa manual")
                except Exception:  # noqa: BLE001
                    pass
            self._set(State.PAUSED_MANUAL, "pausa manual pelo painel", "")
            if self._wake_event is not None:
                self._wake_event.set()
        else:
            self.last_reason = ""
            if self.state == State.PAUSED_MANUAL:
                self.state = State.DISCONNECTED
            if self._wake_event is not None:
                self._wake_event.set()

    async def _wait_wake(self, timeout: float | None = None) -> None:
        if self._wake_event is None:
            self._wake_event = asyncio.Event()
        self._wake_event.clear()
        try:
            if timeout is None:
                await self._wake_event.wait()
            else:
                await asyncio.wait_for(self._wake_event.wait(), timeout)
        except asyncio.TimeoutError:
            pass

    # ----------------------------------------------------------- supervisor
    async def run_forever(self) -> None:
        """Mantém a conta conectada; aplica cooldown de 5 min em rejeição e respeita pausa manual."""
        while True:
            if self.manual_paused:
                self.last_reason = "Pausada manualmente pelo painel."
                if self.state != State.PAUSED_MANUAL:
                    self._set(State.PAUSED_MANUAL, "aguardando retomada manual", "")
                while self.manual_paused:
                    await self._wait_wake()
                continue
            self._online_since = None
            try:
                await self._session()
                if self.manual_paused:
                    continue
                motivo = "O jogo parou de responder; reconectando." if self._silent_close else "O jogo encerrou a conexão."
                self._silent_close = False
                self._set(State.DISCONNECTED, "sessão encerrada", motivo)
            except AccountBlocked as e:
                self.block = {"kind": e.kind, "detail": e.detail}
                self.last_reason = e.detail
                self._set(State.BLOCKED, e.detail, e.detail)
                if self.on_auth_status:
                    self.on_auth_status(self.acc.index, e.kind, e.detail)
                while True:  # só o painel (editar/reiniciar a conta) tira daqui, cancelando a task
                    await asyncio.sleep(3600)
            except NetworkFull:
                if self.manual_paused:
                    continue
                self.last_reason = "A rede atingiu o limite de contas online."
                self._set(State.DISCONNECTED, f"rede cheia; nova tentativa em {NETWORK_FULL_RETRY_S}s",
                          "A rede atingiu o limite de contas online; nova tentativa em instantes.")
                await self._wait_wake(NETWORK_FULL_RETRY_S)
                continue
            except AuthRejected as e:
                if self.manual_paused:
                    continue
                externo = "login externo" in str(e)
                motivo = ("A conta foi aberta em outro lugar (login externo)." if externo
                          else "O jogo recusou o login da conta.")
                # Login externo: o tempo de espera é uma configuração do painel (padrão 5 min).
                wait = config.external_login_wait_s() if externo else config.COOLDOWN_SECONDS
                self.last_reason = motivo
                self._set(State.PAUSED_COOLDOWN, f"{e}; aguardando {wait}s",
                          f"{motivo} Nova tentativa em {wait / 60:g} min.")
                await self._wait_wake(wait)
                continue
            except asyncio.CancelledError:
                raise
            except (ProxyError, OSError, aiohttp.ClientError) as e:
                if self.manual_paused:
                    continue
                self._set(State.DISCONNECTED, f"falha de proxy/rede: {e!r}", friendly_reason(e))
            except Exception as e:  # noqa: BLE001 - supervisor não pode morrer
                if self.manual_paused:
                    continue
                self._set(State.DISCONNECTED, f"erro: {e!r}", friendly_reason(e))
            if not self.manual_paused:
                await self._wait_wake(self._reconnect_delay())

    def _reconnect_delay(self) -> float:
        """Caiu uma sessão que estava funcionando (ex.: o jogo reiniciou o servidor): tenta voltar na hora, uma vez.
        Se essa tentativa falhar (manutenção, servidor fora), nunca chegou a ficar ONLINE: espera RECONNECT_DELAY
        entre as tentativas seguintes."""
        up = self._online_since
        if up is not None and time.monotonic() - up >= config.MIN_UPTIME_FOR_FAST_RETRY_S:
            return 0.0
        return config.RECONNECT_DELAY


def _parse(raw) -> dict:
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}
