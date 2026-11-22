"""Recursos extras por conta: Auto-venda do Depot, avisos de eventos, Banco (envio de coins), anúncios no
Mercado, Prey diário, repetição do Boss, Oferenda e Sacrifício.

Os frames abaixo foram conferidos no cliente oficial do jogo (app.js e os módulos shared/*.mjs: prey.mjs,
oferenda.mjs, sacrificio.mjs, taxa-mercado.mjs, dia-sazonal.mjs). Todos os eventos de resposta chegam dentro de
`{"t": "batalha", "ev": [{"k": ...}]}` (o cliente trata todos em `aoEvento`):

    shop.autoVendaDepot {ativo}                      -> ev autoVendaDepot {ativo}; estado.automation.autoVendaDepot
    banco.consultar {nick}                           -> ev bancoDestino {pedido, nick, erro?, level, looktype}
    banco.coins {nick, valor}                        -> ev amigoCoinsEnviou {nick, valor, liquido} (taxa 15% queimada,
                                                        mínimo 1.000, nível 10 nos dois lados, 5 s entre envios)
    market.criar {tipo, itemId, pokemonId, casaId, bicicletaId, qtd, preco, moeda, dias}
                                                     -> ev marketCriado {descricao}; item: dias=null; pokémon: dias
                                                        entre mercado.diasMin..diasMax, paga taxaDiaria×dias em coins
    market.cancelar {id}                             -> ev marketCancelado
    market.editar {id, preco, moeda}                 -> (sem evento próprio no cliente)
    market.estender {id, dias}                       -> ev marketEstendido {id, descricao, expiraEm} (só pokémon)
    prey.roletar {cartela, categoria, dia, n}        -> ev preyRoletou {cartela, categoria, c}
    prey.escolher {cartela, dia, pk}                 -> ev preyEscolheu {cartela, c}
    boss.entrar {key} / boss.auto {ativo, key} / boss.sair
                                                     -> ev bossEntrou / bossAuto {ativo} / bossMorto / bossPerdeu
    oferenda.protegidos                              -> {"t": "oferenda", "protegidos": [ids]}
    oferenda.girar {pokemonIds (até 5)}              -> ev oferenda
    sacrificio.sacrificar {pokemonIds (até 50)}      -> ev sacrificio
    sacrificio.resgatar                              -> ev sacrificioResgate

Avisos (Discord/Telegram): marketVendido, marketExpirou, ovoChocou e bossMorto.

Tudo que mexe em dinheiro ou destrói pokémon só sai por pedido do usuário no painel (nunca automático). O que roda
sozinho é só a Auto-venda (no próprio jogo, ligada pelo usuário) e o Prey diário (opt-in), que usa apenas a
roletada GRÁTIS do dia — nunca as pagas.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from notify import BLUE, GOLD, GREEN, RED

if TYPE_CHECKING:
    from connection import AccountConnection

log = logging.getLogger("features")

FEED_MAX = 60
REPLY_TIMEOUT_S = 8.0

# ---------------------------------------------------------------- Banco (app.js: TAXA_COINS_AMIGO, MIN_COINS_AMIGO...)
BANK_FEE = 0.15              # taxa queimada em cada envio
BANK_MIN = 1000              # mínimo de coins por envio
BANK_LEVEL_MIN = 10          # CHAT_NIVEL_MIN: os dois lados precisam de nível 10
BANK_COOLDOWN_S = 5.0        # ESPERA_AMIGO_MS: espera entre dois envios da mesma conta
NICK_OK = re.compile(r"^[a-zA-Z0-9_]{3,16}$")


def bank_fee(valor: int) -> int:
    """Math.ceil(valor * 0.15), como o cliente mostra."""
    return -(-int(valor) * 15 // 100)


# ---------------------------------------------------------------- Mercado (shared/taxa-mercado.mjs)
MARKET_FEE_GOLD = 0.15
PRICE_MIN_DEFAULT = 2        # PRECO_MIN_GOLD = PRECO_MIN_ORB = ceil(1 / (1 - 0.15))
MARKET_DAILY_FEE_DEFAULT = 100_000
MARKET_DAYS_MIN_DEFAULT, MARKET_DAYS_MAX_DEFAULT = 1, 30
VALID_MOEDAS = ("gold", "orb")

# ---------------------------------------------------------------- Prey (shared/prey.mjs)
PREY_CARTELAS = 2
PREY_BONUS = ("dano", "defesa", "captura", "spawn")
PREY_VALOR = {"dano": (10, 20, 30, 40, 50), "defesa": (10, 20, 30, 40, 50),
              "captura": (2, 4, 6, 8, 10), "spawn": (1, 2, 3, 4, 5)}
PREY_BONUS_LABEL = {"dano": "Dano", "defesa": "Defensivo", "captura": "Capture Boost", "spawn": "Spawn"}
PREY_RETRY_S = 120.0
PREY_TICK_S = 30.0
PREY_MAX_TRIES = 3
_DIA_SHIFT_MS = 3 * 3_600_000   # FUSO_BRASILIA_MS - ANTECIPACAO_SAZONAL_MS = 3h - 6h = -3h -> soma 3h

# ---------------------------------------------------------------- Oferenda / Sacrifício
OFERENDA_CASAS = 5
SACRIFICIO_LOTE_MAX = 50
XP_SHARE_HELD_ID = 70050
POTENCIA_MAX = 5
# Dex nacional dos lendários, míticos e ultra-criaturas (superconjunto do que o jogo trata como especial).
LEGENDARY_DEX = frozenset({
    144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, *range(377, 387), *range(480, 495),
    *range(638, 650), *range(716, 722), 772, 773, *range(785, 810), *range(888, 899), 905,
    1001, 1002, 1003, 1004, 1007, 1008, 1014, 1015, 1016, 1017, 1024, 1025,
})


def dia_do_prey(server_ms: int) -> str:
    """chaveDoDiaSazonal (dia-sazonal.mjs): o dia do jogo vira às 18:00 de Brasília."""
    return datetime.fromtimestamp((int(server_ms) + _DIA_SHIFT_MS) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def cartela_valida(c) -> dict | None:
    """Versão enxuta de cartelaValida (prey.mjs)."""
    if not isinstance(c, dict):
        return None
    lista = None
    if isinstance(c.get("lista"), list):
        ids = [_int(x) for x in c["lista"]]
        if ids and all(i > 0 for i in ids):
            lista = list(dict.fromkeys(ids))
    pk = _int(c.get("pk")) if lista and c.get("pk") is not None else None
    if pk is not None and pk not in lista:
        pk = None
    est = _int(c.get("est"))
    tem = bool(lista) and c.get("bonus") in PREY_BONUS and 1 <= est <= 5
    n = c.get("n") if isinstance(c.get("n"), list) else []
    n = [max(0, _int(n[i])) if i < len(n) else 0 for i in range(3)]
    if not lista and pk is None and not tem and not any(n):
        return None
    return {"lista": lista, "pk": pk, "bonus": c["bonus"] if tem else None, "est": est if tem else None, "n": n}


def prey_do_momento(automation: dict | None, dia: str) -> dict:
    """preyDoMomento: as cartelas de hoje (as de outro dia contam como vazias)."""
    bruto = (automation or {}).get("prey")
    vazio = {"dia": dia, "cartelas": [None] * PREY_CARTELAS}
    if not isinstance(bruto, dict) or bruto.get("dia") != dia:
        return vazio
    cs = bruto.get("cartelas") if isinstance(bruto.get("cartelas"), list) else []
    return {"dia": dia, "cartelas": [cartela_valida(cs[i]) if i < len(cs) else None for i in range(PREY_CARTELAS)]}


def cartelas_liberadas(automation: dict | None) -> int:
    return PREY_CARTELAS if _int((automation or {}).get("preyCartela2")) > 0 else 1


def destroy_block_reason(pk: dict, est: dict, protegidos: set[int]) -> str | None:
    """Por que este pokémon NUNCA pode ir para a Oferenda/Sacrifício (None = liberado).

    Regras do cliente (oferenda.mjs motivoForaDoAuto, sacrificio.mjs motivoForaDoSacrificio) somadas às do painel:
    nada de shiny, coleção/travado, vitrine, equipe, ativo, inicial, item segurado, refino, TM, P5, lendário, formas
    especiais (só espécies 1..1025 entram) e os protegidos que o jogo devolve em `oferenda.protegidos`."""
    pid = _int(pk.get("id"))
    auto = est.get("automation") if isinstance(est.get("automation"), dict) else {}
    travados = {_int(x) for x in auto.get("pokemonTravado") or []}
    vitrine = {_int(x) for x in est.get("vitrine") or []} if isinstance(est.get("vitrine"), list) else set()
    species = _int(pk.get("speciesId"))
    if pk.get("shiny"):
        return "shiny"
    if pid in travados:
        return "coleção/travado"
    if pid in vitrine:
        return "vitrine"
    if pid in protegidos:
        return "protegido pelo jogo"
    if pid == _int(est.get("activeId"), -1):
        return "ativo"
    if pk.get("slot") is not None:
        return "na equipe"
    if pk.get("starter"):
        return "inicial"
    if pk.get("heldItemId") is not None:
        return "segura item"
    if _int(pk.get("refinoTotal")) > 0 or any(_int(v) > 0 for v in (pk.get("refino") or {}).values()):
        return "refinado"
    if pk.get("tmElemental") or pk.get("tmAoe"):
        return "tem TM"
    if _int(pk.get("potencia")) >= POTENCIA_MAX:
        return "P5"
    if pk.get("skin") or pk.get("skinId"):
        return "veste skin"
    if not 1 <= species <= 1025:
        return "forma especial"
    if species in LEGENDARY_DEX:
        return "lendário/mítico"
    return None


class FeatureError(Exception):
    """Pedido recusado antes de ir ao jogo (mensagem para o painel)."""


class _Waiter:
    __slots__ = ("pred", "fut")

    def __init__(self, pred: Callable[[str, dict], dict | None]):
        self.pred = pred
        self.fut = asyncio.get_running_loop().create_future()


class FeaturesManager:
    """Um por conta. Recebe todos os frames (handle_frame) e expõe os comandos do painel."""

    def __init__(self, conn: "AccountConnection") -> None:
        self.conn = conn
        self.feed: deque[dict] = deque(maxlen=FEED_MAX)
        self._seq = 0
        self._waiters: list[_Waiter] = []
        self._last_bank_at = 0.0
        self._bank_lock = asyncio.Lock()
        self._prey_tries: dict[tuple, tuple[int, float]] = {}   # (dia, cartela, ação) -> (tentativas, último envio)
        self._prey_warned: set[tuple] = set()
        self._last_prey_tick = 0.0
        self.protegidos: list[int] | None = None

    # ------------------------------------------------------------------ util
    @property
    def nick(self) -> str:
        return self.conn.acc.nick

    def _push(self, kind: str, text: str, **data) -> None:
        self._seq += 1
        self.feed.appendleft({"id": self._seq, "ts": int(time.time() * 1000), "kind": kind, "text": text, **data})

    def _notify(self, text: str, color: int, fields: list | None = None) -> None:
        try:
            self.conn.notifier.send(self.nick, text, color, fields or [])
        except Exception:  # noqa: BLE001 - aviso é acessório
            log.debug("[%s] falha ao enfileirar aviso", self.conn.acc.name)

    def _automation(self) -> dict:
        auto = self.conn.estado.get("automation")
        if not isinstance(auto, dict):
            auto = {}
            self.conn.estado["automation"] = auto
        return auto

    def _server_now(self) -> int:
        try:
            now = int(self.conn.server_now_ms())
        except Exception:  # noqa: BLE001
            now = 0
        return now or int(self.conn.estado.get("servidorAgora") or 0) or int(time.time() * 1000)

    async def _send_and_wait(self, frame: dict, pred: Callable[[str, dict], dict | None],
                             timeout: float = REPLY_TIMEOUT_S) -> dict | None:
        """Envia `frame` e devolve o que `pred` montar com a primeira resposta que reconhecer (None = sem resposta)."""
        w = _Waiter(pred)
        self._waiters.append(w)
        try:
            await self.conn.send_frame(frame)
            return await asyncio.wait_for(asyncio.shield(w.fut), timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            if w in self._waiters:
                self._waiters.remove(w)

    def _offer(self, kind: str, obj: dict) -> None:
        for w in list(self._waiters):
            if w.fut.done():
                continue
            try:
                res = w.pred(kind, obj)
            except Exception:  # noqa: BLE001
                res = None
            if res is not None:
                w.fut.set_result(res)

    @staticmethod
    def _refusal(prefixes: tuple[str, ...]):
        """Recusas do jogo: `{"t":"erro","chave"}` ou um evento `aviso` com chave de um dos prefixos."""
        def check(kind: str, o: dict) -> dict | None:
            if kind == "frame" and o.get("t") == "erro":
                chave = str(o.get("chave") or o.get("msg") or "")
                # Só recusas do assunto: um erro de chat/outra tela no meio não vira "recusado" à toa.
                return {"ok": False, "error": chave} if chave.startswith(prefixes) else None
            if kind == "ev" and o.get("k") == "aviso":
                msg = str(o.get("msg") or "")
                if msg.startswith(prefixes):
                    return {"ok": False, "error": msg}
            return None
        return check

    # ------------------------------------------------------------------ frames
    def handle_frame(self, msg: dict) -> None:
        try:
            self._handle_frame(msg)
        except Exception:  # noqa: BLE001 - recurso acessório nunca derruba a conexão
            log.exception("[%s] erro ao tratar frame em features", self.conn.acc.name)

    def _handle_frame(self, msg: dict) -> None:
        t = msg.get("t")
        if t == "estado":
            return
        if t == "batalha":
            for ev in msg.get("ev") or []:
                if isinstance(ev, dict):
                    self._on_event(ev)
                    self._offer("ev", ev)
            return
        if t == "oferenda" and "protegidos" in msg:
            prot = msg.get("protegidos")
            self.protegidos = [_int(x) for x in prot] if isinstance(prot, list) else None
        self._offer("frame", msg)

    def _on_event(self, e: dict) -> None:
        k = e.get("k")
        if k == "autoVendaDepot":
            self._automation()["autoVendaDepot"] = e.get("ativo") is True
            self._push("autoVenda", "Auto-venda do Depot " + ("ligada" if e.get("ativo") is True else "desligada"))
        elif k == "marketVendido":
            moeda = "Gemas" if e.get("moeda") == "orb" else "coins"
            valor = _int(e.get("valor"))
            desc = str(e.get("descricao") or "anúncio")
            self._push("marketVendido", f"Vendeu {desc} — recebeu {valor:,} {moeda}", valor=valor, moeda=e.get("moeda"))
            self._notify(f"💰 Vendeu **{desc}** no mercado — recebeu **{valor:,} {moeda}**.", GREEN)
        elif k == "marketExpirou":
            desc = str(e.get("descricao") or "anúncio")
            self._push("marketExpirou", f"Anúncio vencido: {desc} voltou para você")
            self._notify(f"⌛ Anúncio vencido: **{desc}** voltou para você.", GOLD)
        elif isinstance(k, str) and k.startswith("marketDevolvido"):
            self._push("marketDevolvido", f"Anúncio devolvido: {e.get('descricao') or '—'}")
        elif k == "marketCriado":
            self._push("marketCriado", f"Anúncio criado: {e.get('descricao') or '—'}")
        elif k == "marketCancelado":
            self._push("marketCancelado", "Anúncio removido do mercado")
        elif k == "marketEstendido":
            self._push("marketEstendido", f"Anúncio estendido: {e.get('descricao') or '—'}")
        elif k == "ovoChocou":
            pk = e.get("pokemon") if isinstance(e.get("pokemon"), dict) else {}
            nome = str(pk.get("nome") or "pokémon")
            shiny = " ✨ shiny" if pk.get("shiny") else ""
            self._push("ovoChocou", f"O ovo chocou: {nome}{shiny}!", shiny=bool(pk.get("shiny")))
            self._notify(f"🥚 O ovo chocou: **{nome}**{shiny}!", GOLD if pk.get("shiny") else GREEN)
        elif k == "bossEntrou":
            self._push("bossEntrou", f"Entrou na arena de {e.get('nome') or 'boss'}")
        elif k == "bossMorto":
            nome = str(e.get("nome") or "Boss")
            drops = [d for d in e.get("drops") or [] if isinstance(d, dict)]
            txt = ", ".join(f"{d.get('nome') or ('#' + str(d.get('itemId')))}×{_int(d.get('qtd'), 1)}" for d in drops) or "nada"
            boss = self.conn.estado.get("boss")
            if e.get("key") and isinstance(boss, dict):
                v = boss.setdefault("vitorias", {})
                if isinstance(v, dict):
                    v[e["key"]] = _int(v.get(e["key"])) + 1
            self._push("bossMorto", f"{nome} derrotado! Drops: {txt}", drops=drops)
            self._notify(f"🏆 **{nome}** derrotado!", GOLD, [("Drops", txt, False)])
        elif k == "bossPerdeu":
            self._push("bossPerdeu", f"{e.get('nome') or 'O boss'} venceu — a equipe caiu na arena")
        elif k == "bossAuto":
            boss = self.conn.estado.setdefault("boss", {})
            if isinstance(boss, dict):
                boss["auto"] = e.get("ativo") is True
                if e.get("key"):
                    boss["autoKey"] = e.get("key")
            self._push("bossAuto", "Repetição do boss " + ("ligada" if e.get("ativo") else "desligada"))
        elif k in ("preyRoletou", "preyEscolheu"):
            self._apply_prey(e)
        elif k == "amigoCoinsEnviou":
            self._push("coins", f"Enviou {_int(e.get('valor')):,} coins a {e.get('nick')} "
                                f"({_int(e.get('liquido')):,} após a taxa)")
        elif k == "amigoCoinsRecebeu":
            self._push("coins", f"Recebeu {_int(e.get('valor')):,} coins de {e.get('nick')}")
        elif k in ("oferenda", "oferendaLote"):
            self._push("oferenda", "Oferenda girada")
        elif k == "sacrificio":
            self._push("sacrificio", "Sacrifício feito")
        elif k == "sacrificioResgate":
            self._push("sacrificio", "Boost do Sacrifício resgatado")

    def _apply_prey(self, e: dict) -> None:
        """Espelha a cartela devolvida pelo jogo no estado local (o patch de `estado` também chega depois)."""
        c = cartela_valida(e.get("c"))
        i = _int(e.get("cartela"), -1)
        if c is None or not 0 <= i < PREY_CARTELAS:
            return
        auto = self._automation()
        dia = dia_do_prey(self._server_now())
        prey = auto.get("prey") if isinstance(auto.get("prey"), dict) and auto["prey"].get("dia") == dia else None
        if prey is None:
            prey = {"dia": dia, "cartelas": [None] * PREY_CARTELAS}
        cs = list(prey.get("cartelas") or [])
        cs += [None] * (PREY_CARTELAS - len(cs))
        cs[i] = c
        auto["prey"] = {**prey, "dia": dia, "cartelas": cs}
        if e.get("k") == "preyEscolheu" and c.get("pk") is not None:
            nome = self._species_name(c["pk"])
            self._push("prey", f"Prey cartela {i + 1}: {nome} — {PREY_BONUS_LABEL.get(c.get('bonus'), '?')} {c.get('est')}★")
        elif e.get("k") == "preyRoletou":
            self._push("prey", f"Prey cartela {i + 1} roletada: {PREY_BONUS_LABEL.get(c.get('bonus'), '?')} {c.get('est')}★")

    def _species_name(self, pid: int) -> str:
        for h in self.conn.hunts:
            if isinstance(h, dict):
                for e in h.get("especies") or []:
                    if isinstance(e, dict) and _int(e.get("pokeId")) == pid and e.get("nome"):
                        return str(e["nome"])
        try:
            from game_data import POKEMON_NAMES
            return str(POKEMON_NAMES.get(pid) or f"#{pid}")
        except Exception:  # noqa: BLE001
            return f"#{pid}"

    # ------------------------------------------------------------------ 1) Auto-venda do Depot
    async def set_auto_venda_depot(self, ativo: bool) -> bool:
        await self.conn.send_frame({"t": "shop.autoVendaDepot", "ativo": bool(ativo)})
        self._automation()["autoVendaDepot"] = bool(ativo)   # o cliente oficial também marca na hora
        log.info("[%s] shop.autoVendaDepot ativo=%s", self.conn.acc.name, bool(ativo))
        return bool(ativo)

    # ------------------------------------------------------------------ 3) Banco
    def bank_plan(self, target: str, reserve: int) -> dict:
        """Quanto esta conta enviaria (sem enviar nada)."""
        gold = _int(self.conn.estado.get("gold"))
        level = _int(self.conn.estado.get("level"))
        amount = max(0, gold - max(0, int(reserve)))
        out = {"account": f"acc{self.conn.acc.index}", "id": self.conn.acc.index, "nick": self.nick,
               "gold": gold, "level": level, "amount": 0, "fee": 0, "net": 0, "status": "ok", "detail": ""}
        if self.nick.lower() == target.lower():
            return {**out, "status": "skip", "detail": "é a conta de destino"}
        if not self.conn.can_send:
            return {**out, "status": "skip", "detail": "offline"}
        if level < BANK_LEVEL_MIN:
            return {**out, "status": "skip", "detail": f"precisa de nível {BANK_LEVEL_MIN}"}
        if amount < BANK_MIN:
            return {**out, "status": "skip", "detail": f"abaixo do mínimo de {BANK_MIN:,} coins acima da reserva"}
        fee = bank_fee(amount)
        return {**out, "amount": amount, "fee": fee, "net": amount - fee}

    async def bank_send(self, target: str, valor: int) -> dict:
        """banco.consultar -> confere o destino -> banco.coins. Irreversível: só por pedido do usuário."""
        target = target.strip()
        valor = int(valor)
        if not NICK_OK.match(target):
            raise FeatureError("Nick de destino inválido.")
        if target.lower() == self.nick.lower():
            raise FeatureError("O destino é a própria conta.")
        if valor < BANK_MIN:
            raise FeatureError(f"Mínimo de {BANK_MIN:,} coins por envio.")
        if _int(self.conn.estado.get("level")) < BANK_LEVEL_MIN:
            raise FeatureError(f"A conta precisa de nível {BANK_LEVEL_MIN}.")
        gold = _int(self.conn.estado.get("gold"))
        if valor > gold:
            raise FeatureError("Saldo insuficiente.")
        async with self._bank_lock:
            wait = BANK_COOLDOWN_S - (time.monotonic() - self._last_bank_at)
            if wait > 0:
                await asyncio.sleep(wait)
            refusal = self._refusal(("amigos.", "banco.", "chat."))

            def destino(kind: str, o: dict) -> dict | None:
                if kind == "ev" and o.get("k") == "bancoDestino" and str(o.get("pedido") or "").lower() == target.lower():
                    return {"ok": not o.get("erro"), "error": o.get("erro"), "nick": o.get("nick"), "level": o.get("level")}
                return refusal(kind, o)

            d = await self._send_and_wait({"t": "banco.consultar", "nick": target}, destino)
            if d is None:
                return {"ok": False, "status": "timeout", "detail": "o jogo não respondeu à consulta do destino"}
            if not d["ok"]:
                return {"ok": False, "status": "recusado", "detail": str(d.get("error") or "destino recusado")}
            real = str(d.get("nick") or target)
            if real.lower() != target.lower():
                return {"ok": False, "status": "recusado", "detail": f"o jogo devolveu outro nick ({real})"}
            if d.get("level") is not None and _int(d.get("level")) < BANK_LEVEL_MIN:
                return {"ok": False, "status": "recusado", "detail": f"{real} ainda não tem nível {BANK_LEVEL_MIN}"}

            def enviado(kind: str, o: dict) -> dict | None:
                if kind == "ev" and o.get("k") == "amigoCoinsEnviou" and str(o.get("nick") or "").lower() == real.lower():
                    return {"ok": True, "liquido": o.get("liquido")}
                return refusal(kind, o)

            self._last_bank_at = time.monotonic()
            r = await self._send_and_wait({"t": "banco.coins", "nick": real, "valor": valor}, enviado)
            log.info("[%s] banco.coins %s -> %s (%s)", self.conn.acc.name, valor, real, r)
            fee = bank_fee(valor)
            if r is None:
                # Sem o evento: confere pelo saldo (o patch de estado chega com o gold novo).
                if _int(self.conn.estado.get("gold")) <= gold - valor:
                    r = {"ok": True}
                else:
                    return {"ok": False, "status": "incerto", "amount": valor,
                            "detail": "enviado, mas o jogo não confirmou — confira o saldo antes de tentar de novo"}
            if not r.get("ok"):
                return {"ok": False, "status": "recusado", "detail": str(r.get("error") or "recusado")}
            self._push("coins", f"Enviou {valor:,} coins para {real}")
            return {"ok": True, "status": "enviado", "amount": valor, "fee": fee,
                    "net": _int(r.get("liquido"), valor - fee) or valor - fee, "to": real}

    # ------------------------------------------------------------------ 4) Mercado
    def market_cfg(self) -> dict:
        m = self.conn.mercado_cfg or {}
        return {
            "precoMinGold": _int(m.get("precoMinGold"), PRICE_MIN_DEFAULT) or PRICE_MIN_DEFAULT,
            "precoMinOrb": _int(m.get("precoMinOrb"), PRICE_MIN_DEFAULT) or PRICE_MIN_DEFAULT,
            "taxaDiaria": _int(m.get("taxaDiaria"), MARKET_DAILY_FEE_DEFAULT),
            "diasMin": _int(m.get("diasMin"), MARKET_DAYS_MIN_DEFAULT) or MARKET_DAYS_MIN_DEFAULT,
            "diasMax": _int(m.get("diasMax"), MARKET_DAYS_MAX_DEFAULT) or MARKET_DAYS_MAX_DEFAULT,
            "taxaGoldPct": round(float(m.get("taxaGoldPct") or MARKET_FEE_GOLD * 100), 2),
        }

    def _check_price(self, preco: int, moeda: str) -> None:
        if moeda not in VALID_MOEDAS:
            raise FeatureError("Moeda inválida (use gold ou orb).")
        cfg = self.market_cfg()
        minimo = cfg["precoMinOrb"] if moeda == "orb" else cfg["precoMinGold"]
        if preco < minimo:
            raise FeatureError(f"Preço mínimo: {minimo}.")

    async def market_create(self, *, tipo: str, item_id: int | None, pokemon_id: int | None, qtd: int,
                            preco: int, moeda: str, dias: int | None) -> dict:
        self._check_price(preco, moeda)
        est = self.conn.estado
        frame = {"t": "market.criar", "tipo": tipo, "itemId": None, "pokemonId": None, "casaId": None,
                 "bicicletaId": None, "qtd": int(qtd), "preco": int(preco), "moeda": moeda, "dias": None}
        if tipo == "item":
            if not item_id:
                raise FeatureError("Escolha o item.")
            tem = _int((est.get("items") or {}).get(str(item_id)))
            presos = _int(((est.get("automation") or {}).get("itensPresos") or {}).get(str(item_id)))
            livres = max(0, tem - min(tem, presos))
            if qtd < 1 or qtd > livres:
                raise FeatureError(f"Quantidade inválida: a conta tem {livres} livre(s) desse item.")
            frame["itemId"] = int(item_id)
        elif tipo == "pokemon":
            pk = next((p for p in est.get("pokemons") or [] if isinstance(p, dict) and _int(p.get("id")) == pokemon_id), None)
            if pk is None:
                raise FeatureError("Pokémon não encontrado nesta conta.")
            if pokemon_id == _int(est.get("activeId"), -1) or pk.get("slot") is not None:
                raise FeatureError("Tire o pokémon da equipe antes de anunciar.")
            if pk.get("starter"):
                raise FeatureError("O inicial não pode ser anunciado.")
            if pokemon_id in {_int(x) for x in (est.get("automation") or {}).get("pokemonTravado") or []}:
                raise FeatureError("Pokémon da Coleção: mova para o Depot antes de anunciar.")
            if pk.get("heldItemId") == XP_SHARE_HELD_ID:
                raise FeatureError("Tire o Exp. Share antes de anunciar.")
            cfg = self.market_cfg()
            if dias is None or not cfg["diasMin"] <= int(dias) <= cfg["diasMax"]:
                raise FeatureError(f"Dias: entre {cfg['diasMin']} e {cfg['diasMax']}.")
            custo = cfg["taxaDiaria"] * int(dias)
            if custo > _int(est.get("gold")):
                raise FeatureError(f"A estadia custa {custo:,} coins e a conta não tem saldo.")
            frame.update(pokemonId=int(pokemon_id), qtd=1, dias=int(dias))
        else:
            raise FeatureError("Tipo inválido.")
        refusal = self._refusal(("market.", "cm."))

        def criado(kind: str, o: dict) -> dict | None:
            if kind == "ev" and o.get("k") == "marketCriado":
                return {"ok": True, "descricao": o.get("descricao")}
            if kind == "ev" and o.get("k") == "marketLimitePokemon":
                return {"ok": False, "error": "limite de anúncios de pokémon"}
            return refusal(kind, o)

        r = await self._send_and_wait(frame, criado)
        log.info("[%s] market.criar %s -> %s", self.conn.acc.name, {k: frame[k] for k in ("tipo", "itemId", "pokemonId", "qtd", "preco", "moeda", "dias")}, r)
        if r is None:
            return {"ok": True, "confirmed": False}
        return {**r, "confirmed": bool(r.get("ok"))}

    async def market_cancel(self, listing_id: int) -> dict:
        refusal = self._refusal(("market.", "cm."))
        r = await self._send_and_wait({"t": "market.cancelar", "id": int(listing_id)},
                                      lambda k, o: {"ok": True} if k == "ev" and o.get("k") == "marketCancelado" else refusal(k, o))
        return {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": bool(r.get("ok"))}

    async def market_edit(self, listing_id: int, *, preco: int | None, moeda: str | None, dias: int | None) -> dict:
        out: dict = {"ok": True}
        refusal = self._refusal(("market.", "cm."))
        if dias:
            cfg = self.market_cfg()
            if not 1 <= int(dias) <= cfg["diasMax"]:
                raise FeatureError(f"Dias: entre 1 e {cfg['diasMax']}.")
            r = await self._send_and_wait(
                {"t": "market.estender", "id": int(listing_id), "dias": int(dias)},
                lambda k, o: ({"ok": True, "expiraEm": o.get("expiraEm")}
                              if k == "ev" and o.get("k") == "marketEstendido" else refusal(k, o)))
            out["extended"] = {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": bool(r.get("ok"))}
            if r is not None and not r.get("ok"):
                return {**out, "ok": False, "error": r.get("error")}
        if preco is not None:
            moeda = moeda or "gold"
            self._check_price(int(preco), moeda)
            # O jogo não manda evento próprio para a edição: só a recusa (aviso/erro) volta.
            r = await self._send_and_wait({"t": "market.editar", "id": int(listing_id), "preco": int(preco), "moeda": moeda},
                                          refusal, timeout=2.0)
            out["edited"] = {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": False}
            if r is not None and not r.get("ok"):
                return {**out, "ok": False, "error": r.get("error")}
        return out

    # ------------------------------------------------------------------ 5) Prey
    def prey_view(self) -> dict:
        auto = self.conn.estado.get("automation") or {}
        dia = dia_do_prey(self._server_now())
        prey = prey_do_momento(auto, dia)
        cartelas = []
        for c in prey["cartelas"]:
            if c is None:
                cartelas.append(None)
                continue
            cartelas.append({**c, "pkNome": self._species_name(c["pk"]) if c.get("pk") else None,
                             "valor": PREY_VALOR.get(c.get("bonus") or "", (0,) * 5)[(c.get("est") or 1) - 1] if c.get("bonus") else None,
                             "opcoes": [{"pokeId": i, "nome": self._species_name(i)} for i in c.get("lista") or []]})
        return {"dia": dia, "liberadas": cartelas_liberadas(auto), "cartelas": cartelas, "auto": bool(self.conn.acc.auto_prey)}

    async def prey_roll_free(self, cartela: int) -> dict:
        """Só a roletada GRÁTIS do dia (categoria 'tudo', n=0). As pagas não são expostas."""
        auto = self.conn.estado.get("automation") or {}
        dia = dia_do_prey(self._server_now())
        if not 0 <= cartela < cartelas_liberadas(auto):
            raise FeatureError("Cartela bloqueada.")
        c = prey_do_momento(auto, dia)["cartelas"][cartela]
        if c and (c.get("bonus") or c.get("lista")):
            raise FeatureError("A roletada grátis de hoje já foi usada nesta cartela.")
        refusal = self._refusal(("prey.",))
        r = await self._send_and_wait(
            {"t": "prey.roletar", "cartela": cartela, "categoria": "tudo", "dia": dia, "n": 0},
            lambda k, o: ({"ok": True, "c": cartela_valida(o.get("c"))}
                          if k == "ev" and o.get("k") == "preyRoletou" and _int(o.get("cartela"), -1) == cartela
                          else refusal(k, o)), timeout=12.0)
        return {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": bool(r.get("ok"))}

    async def prey_choose(self, cartela: int, pk: int) -> dict:
        auto = self.conn.estado.get("automation") or {}
        dia = dia_do_prey(self._server_now())
        if not 0 <= cartela < cartelas_liberadas(auto):
            raise FeatureError("Cartela bloqueada.")
        c = prey_do_momento(auto, dia)["cartelas"][cartela]
        if not c or not c.get("lista"):
            raise FeatureError("Faça a roletada grátis antes de escolher.")
        if c.get("pk") is not None:
            raise FeatureError("Esta cartela já tem um pokémon escolhido hoje.")
        if pk not in c["lista"]:
            raise FeatureError("Esse pokémon não está na lista da cartela.")
        refusal = self._refusal(("prey.",))
        r = await self._send_and_wait(
            {"t": "prey.escolher", "cartela": cartela, "dia": dia, "pk": int(pk)},
            lambda k, o: ({"ok": True, "c": cartela_valida(o.get("c"))}
                          if k == "ev" and o.get("k") == "preyEscolheu" and _int(o.get("cartela"), -1) == cartela
                          else refusal(k, o)), timeout=12.0)
        return {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": bool(r.get("ok"))}

    def pick_prey_species(self, lista: list[int]) -> int | None:
        """Espécie para a cartela: primeiro a da hunt atual; depois a da hunt mais alta liberada pelo nível."""
        if not lista:
            return None
        hunts = [h for h in self.conn.hunts if isinstance(h, dict)]
        sess = self.conn.hunt.session
        slug = (sess.slug if sess else None) or self.conn.estado.get("huntSlug")
        cur = next((h for h in hunts if h.get("slug") == slug), None)
        if cur:
            for e in cur.get("especies") or []:
                if isinstance(e, dict) and _int(e.get("pokeId")) in lista:
                    return _int(e.get("pokeId"))
        level = _int(self.conn.estado.get("level"))
        best: tuple[int, int] | None = None
        for h in hunts:
            nivel = _int(h.get("nivel"))
            if nivel > level or h.get("area") == "outland":
                continue
            for e in h.get("especies") or []:
                pid = _int(e.get("pokeId")) if isinstance(e, dict) else 0
                if pid in lista and (best is None or nivel > best[0]):
                    best = (nivel, pid)
        return best[1] if best else None

    def _prey_may_try(self, key: tuple) -> bool:
        n, last = self._prey_tries.get(key, (0, 0.0))
        if n >= PREY_MAX_TRIES or time.monotonic() - last < PREY_RETRY_S:
            return False
        self._prey_tries[key] = (n + 1, time.monotonic())
        return True

    async def check_auto_prey(self) -> None:
        """Prey diário (opt-in): faz a roletada grátis de cada cartela liberada e escolhe a espécie da hunt.
        Nunca usa roletada paga. Uma ação por chamada."""
        if not self.conn.acc.auto_prey or not self.conn.can_send:
            return
        now = time.monotonic()
        if now - self._last_prey_tick < PREY_TICK_S:
            return
        self._last_prey_tick = now
        auto = self.conn.estado.get("automation")
        if not isinstance(auto, dict):
            return
        dia = dia_do_prey(self._server_now())
        prey = prey_do_momento(auto, dia)
        for i in range(cartelas_liberadas(auto)):
            c = prey["cartelas"][i]
            if c is None or (not c.get("lista") and not c.get("bonus")):
                if self._prey_may_try((dia, i, "roletar")):
                    await self.conn.send_frame({"t": "prey.roletar", "cartela": i, "categoria": "tudo", "dia": dia, "n": 0})
                    log.info("[%s] Auto-Prey: roletada grátis da cartela %d (%s)", self.conn.acc.name, i + 1, dia)
                return
            if c.get("lista") and c.get("pk") is None:
                pk = self.pick_prey_species(c["lista"])
                if pk is None:
                    if (dia, i) not in self._prey_warned:
                        self._prey_warned.add((dia, i))
                        self._push("prey", f"Prey cartela {i + 1}: nenhuma espécie da lista é de uma hunt sua — escolha manual")
                    continue
                if self._prey_may_try((dia, i, "escolher", pk)):
                    await self.conn.send_frame({"t": "prey.escolher", "cartela": i, "dia": dia, "pk": pk})
                    log.info("[%s] Auto-Prey: cartela %d -> espécie %s", self.conn.acc.name, i + 1, pk)
                    self._notify(f"🎯 **Prey:** cartela {i + 1} com **{self._species_name(pk)}** "
                                 f"({PREY_BONUS_LABEL.get(c.get('bonus'), '?')} {c.get('est')}★).", BLUE)
                return

    # ------------------------------------------------------------------ 6) Boss
    def bosses(self) -> list[dict]:
        items = self.conn.estado.get("items") or {}
        level = _int(self.conn.estado.get("level"))
        out = []
        for b in getattr(self.conn, "bosses_jogaveis", None) or []:
            if not isinstance(b, dict) or not b.get("key"):
                continue
            ent = b.get("entrada") if isinstance(b.get("entrada"), dict) else {}
            nv_min = _int(b.get("minNivelTreinador") or b.get("level"))
            tem = _int(items.get(str(ent.get("itemId"))))
            out.append({"key": b["key"], "name": b.get("name") or b["key"], "level": _int(b.get("level")),
                        "minLevel": nv_min, "levelOk": level >= nv_min,
                        "entry": {"itemId": ent.get("itemId"), "qty": _int(ent.get("qtd"), 1), "name": ent.get("nome")},
                        "have": tem, "entries": tem // max(1, _int(ent.get("qtd"), 1))})
        return out

    def _boss_key_ok(self, key: str) -> bool:
        keys = {b["key"] for b in self.bosses()}
        return not keys or key in keys

    async def boss_auto(self, ativo: bool, key: str) -> dict:
        if ativo and not self._boss_key_ok(key):
            raise FeatureError("Boss desconhecido.")
        await self.conn.send_frame({"t": "boss.auto", "ativo": bool(ativo), "key": key})
        boss = self.conn.estado.setdefault("boss", {})
        if isinstance(boss, dict):
            boss["auto"] = bool(ativo)
            if ativo:
                boss["autoKey"] = key
        return {"ok": True, "auto": bool(ativo), "key": key}

    async def boss_enter(self, key: str) -> dict:
        b = next((x for x in self.bosses() if x["key"] == key), None)
        if b is None:
            raise FeatureError("Boss desconhecido.")
        if not b["levelOk"]:
            raise FeatureError(f"Precisa de nível {b['minLevel']} de treinador.")
        if b["have"] < b["entry"]["qty"]:
            raise FeatureError("Faltam itens de entrada.")
        await self.conn.send_frame({"t": "boss.entrar", "key": key})
        return {"ok": True}

    async def boss_leave(self) -> dict:
        await self.conn.send_frame({"t": "boss.sair"})
        return {"ok": True}

    # ------------------------------------------------------------------ 7) Oferenda / Sacrifício
    async def fetch_protegidos(self) -> list[int] | None:
        r = await self._send_and_wait({"t": "oferenda.protegidos"},
                                      lambda k, o: {"ids": o.get("protegidos")} if k == "frame" and o.get("t") == "oferenda" and "protegidos" in o else None)
        if r is None or not isinstance(r.get("ids"), list):
            return None
        self.protegidos = [_int(x) for x in r["ids"]]
        return self.protegidos

    def screen_destroy(self, ids: list[int], protegidos: set[int]) -> tuple[list[int], list[dict]]:
        """Separa os ids pedidos em liberados e bloqueados (com o motivo)."""
        est = self.conn.estado
        by_id = {_int(p.get("id")): p for p in est.get("pokemons") or [] if isinstance(p, dict)}
        ok, blocked = [], []
        for pid in dict.fromkeys(int(x) for x in ids):
            pk = by_id.get(pid)
            why = "não encontrado" if pk is None else destroy_block_reason(pk, est, protegidos)
            if why:
                blocked.append({"id": pid, "nome": (pk or {}).get("nome"), "reason": why})
            else:
                ok.append(pid)
        if len(ok) >= len(by_id):
            # Nunca deixa a conta sem nenhum pokémon.
            blocked.append({"id": ok[-1], "nome": by_id[ok[-1]].get("nome"), "reason": "a conta ficaria sem pokémon"})
            ok = ok[:-1]
        return ok, blocked

    async def destroy(self, kind: str, ids: list[int]) -> dict:
        limit = OFERENDA_CASAS if kind == "oferenda" else SACRIFICIO_LOTE_MAX
        if not ids:
            raise FeatureError("Escolha ao menos um pokémon.")
        if len(ids) > limit:
            raise FeatureError(f"No máximo {limit} pokémon por vez.")
        prot = await self.fetch_protegidos()
        if prot is None:
            raise FeatureError("O jogo não devolveu a lista de protegidos; nada foi enviado.")
        ok, blocked = self.screen_destroy(ids, set(prot))
        if blocked:
            return {"ok": False, "sent": [], "blocked": blocked,
                    "error": "Há pokémon que não podem ser destruídos; nada foi enviado."}
        frame = ({"t": "oferenda.girar", "pokemonIds": ok} if kind == "oferenda"
                 else {"t": "sacrificio.sacrificar", "pokemonIds": ok})
        k_ok = "oferenda" if kind == "oferenda" else "sacrificio"
        refusal = self._refusal(("oferenda.", "sacrificio."))
        r = await self._send_and_wait(frame, lambda k, o: {"ok": True, "ev": {kk: v for kk, v in o.items() if kk != "k"}}
                                      if k == "ev" and o.get("k") == k_ok else refusal(k, o), timeout=12.0)
        log.warning("[%s] %s enviado: %s -> %s", self.conn.acc.name, frame["t"], ok, r)
        if r is None:
            return {"ok": True, "confirmed": False, "sent": ok, "blocked": []}
        return {**r, "confirmed": bool(r.get("ok")), "sent": ok if r.get("ok") else [], "blocked": []}

    async def sacrificio_resgatar(self) -> dict:
        refusal = self._refusal(("sacrificio.",))
        r = await self._send_and_wait({"t": "sacrificio.resgatar"},
                                      lambda k, o: {"ok": True} if k == "ev" and o.get("k") == "sacrificioResgate" else refusal(k, o))
        return {"ok": True, "confirmed": False} if r is None else {**r, "confirmed": bool(r.get("ok"))}

    # ------------------------------------------------------------------ painel
    def view(self) -> dict:
        est = self.conn.estado
        auto = est.get("automation") or {}
        boss = est.get("boss") if isinstance(est.get("boss"), dict) else {}
        return {
            "account": f"acc{self.conn.acc.index}",
            "online": bool(self.conn.can_send),
            "gold": _int(est.get("gold")),
            "level": _int(est.get("level")),
            "autoVendaDepot": auto.get("autoVendaDepot") is True,
            "autoPrey": bool(self.conn.acc.auto_prey),
            "prey": self.prey_view(),
            "boss": {"auto": bool(boss.get("auto")), "autoKey": boss.get("autoKey"), "bosses": self.bosses()},
            "bank": {"min": BANK_MIN, "feePct": int(BANK_FEE * 100), "levelMin": BANK_LEVEL_MIN,
                     "cooldownS": BANK_COOLDOWN_S},
            "market": self.market_cfg(),
            "events": list(self.feed),
        }
