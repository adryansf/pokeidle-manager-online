"""Compras na loja (shop.buy), baseado exclusivamente em spec do protocolo.

Regras da spec aplicadas:
    - `shop.buy` não confirma sucesso por si só; a confirmação autoritativa
      é `batalha.ev[].k == "compra"`.
    - Não calcular gasto pela diferença de `estado.gold` (a conta pode
      receber gold simultaneamente por kills/drops/venda automática);
      usar `compra.gasto`.
    - A automação deve aguardar `k:"compra"` antes de considerar a compra
      anterior concluída (aqui, antes de disparar a próxima).

IDs de Potion confirmados/mapeados pela doc (nível de confiança como na
spec: 200 é ✅ confirmado por frame; os demais são 🟡 mapeamento por ordem
da loja, ainda sem captura individual de compra):
    200 Small Potion    (✅)      201 Great Potion   (🟡)
    202 Ultra Potion    (🟡)      203 Hyper Potion   (🟡)
    204 Ultimate Potion (🟡)      70070 Golden Potion (🟡)

"Poção equipada" NÃO é um conceito definido em spec do protocolo ou spec do protocolo — foi
confirmado pelo usuário por observação direta (conta com Golden Potion
equipada em jogo tinha `heldItemId == 70070`), não por captura do
protocolo. Por isso o comportamento padrão é usar `heldItemId` do
Pokémon ativo (campo documentado em spec do protocolo) para
decidir qual Potion repor — assim o bot acompanha automaticamente se a
Potion equipada for trocada no jogo. `ACCn_POTION_ID` no `.env` existe
para fixar manualmente uma Potion específica quando preferir não depender
de `heldItemId` (ex.: conta sem Potion equipada ainda).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import config

log = logging.getLogger("shop")

# spec do protocolo §15.7 — nível de confirmação indicado nos comentários acima.
KNOWN_POTION_IDS = {200, 201, 202, 203, 204, 70070}
# Ordem de fallback (da mais forte para a mais simples) quando a poção equipada zera.
POTION_FALLBACK_ORDER = (70070, 204, 203, 202, 201, 200)
# spec do protocolo §15.4: a Beast Ball (5) não é vendida na loja NPC.
BUYABLE_BALL_IDS = {1, 2, 3, 4}
BUY_CONFIRM_TIMEOUT_S = 20  # sem k:"compra" depois disso, libera a próxima tentativa
SELL_CONFIRM_TIMEOUT_S = 20  # sem k:"venda" depois disso, desiste de esperar
BUY_ERROR_ALERT_COOLDOWN_S = 300  # no máximo 1 alerta de erro por item a cada 5 min
RESERVE_ALERT_COOLDOWN_S = 600    # no máximo 1 alerta de piso de ouro a cada 10 min


class ShopManager:
    def __init__(self, account_name: str, estado: dict):
        self.account_name = account_name
        self.estado = estado
        self._ws = None
        self._awaiting: tuple[str, int, int] | None = None  # (kind, id, qty) aguardando k="compra"
        self._awaiting_since = 0.0
        self._pending_sell: asyncio.Future | None = None  # shop.sellAllPokemons aguardando k="venda"
        self._last_error_alert: dict[tuple[str, int], float] = {}
        self.on_buy_error = None  # callback(kind: str, item_id: int, qty: int, reason: str)

    def bind(self, ws) -> None:
        self._ws = ws
        self._awaiting = None
        if self._pending_sell is not None and not self._pending_sell.done():
            self._pending_sell.set_exception(RuntimeError("conexão reiniciada antes da confirmação"))
        self._pending_sell = None

    def _emit_buy_error(self, kind: str, item_id: int, qty: int, reason: str) -> None:
        if not self.on_buy_error:
            return
        now = time.monotonic()
        key = (kind, item_id)
        if now - self._last_error_alert.get(key, -1e9) < BUY_ERROR_ALERT_COOLDOWN_S:
            return
        self._last_error_alert[key] = now
        try:
            self.on_buy_error(kind, item_id, qty, reason)
        except Exception:  # noqa: BLE001
            log.debug("[%s] falha no callback on_buy_error", self.account_name)

    # ------------------------------------------------------------ frames
    def handle_frame(self, msg: dict) -> None:
        t = msg.get("t")
        if t == "erro" and self._awaiting is not None:
            kind, item_id, qty = self._awaiting
            self._awaiting = None
            reason = str(msg.get("mensagem") or msg.get("msg") or msg.get("chave") or "Compra recusada pelo servidor")
            log.warning("[%s] erro ao comprar %s id=%s x%s: %s",
                        self.account_name, kind, item_id, qty, reason)
            self._emit_buy_error(kind, item_id, qty, reason)
            return
        if t != "batalha":
            return
        for ev in msg.get("ev", []):
            if ev.get("k") == "compra":
                log.info("[%s] compra confirmada: %s x%s (gasto=%s gold)",
                         self.account_name, ev.get("nome"), ev.get("qtd"), ev.get("gasto"))
                if self._awaiting is not None:
                    self._last_error_alert.pop((self._awaiting[0], self._awaiting[1]), None)
                self._awaiting = None
            elif ev.get("k") == "venda":
                log.info("[%s] venda confirmada: %s (qtd=%s ganho=%s gold)",
                         self.account_name, ev.get("nome"), ev.get("qtd"), ev.get("ganho"))
                if self._pending_sell is not None and not self._pending_sell.done():
                    self._pending_sell.set_result({
                        "label": ev.get("nome"), "qty": ev.get("qtd"), "gained": ev.get("ganho"),
                    })

    # ----------------------------------------------------------- comando
    async def sell_all_pokemons(self) -> dict:
        """Cliente → Servidor: shop.sellAllPokemons (spec do protocolo §17). Vende
        todo o Depot (Pokémon não trancados/protegidos ficam preservados).

        AÇÃO IRREVERSÍVEL no jogo — a confirmação com o usuário é responsabilidade
        de quem chama (o dashboard mostra o aviso antes de enviar a requisição).
        Confirmação autoritativa: batalha.ev[].k == "venda"."""
        if self._ws is None:
            raise RuntimeError("conta offline")
        if self._pending_sell is not None and not self._pending_sell.done():
            raise RuntimeError("já há uma venda em andamento para esta conta")
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending_sell = fut
        await self._ws.send(json.dumps({"t": "shop.sellAllPokemons"}))
        log.info("[%s] shop.sellAllPokemons enviado", self.account_name)
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=SELL_CONFIRM_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise RuntimeError("sem confirmação do servidor (timeout)") from None
        finally:
            if self._pending_sell is fut:
                self._pending_sell = None

    async def buy(self, kind: str, item_id: int, qty: int) -> bool:
        """Cliente → Servidor: shop.buy. Não dispara se já há uma compra em
        voo aguardando k:"compra" (spec: aguardar confirmação antes de
        considerar concluído)."""
        if self._ws is None:
            raise RuntimeError("ShopManager.bind(ws) não foi chamado")
        if self.awaiting_confirmation:
            return False
        self._awaiting = (kind, item_id, qty)
        self._awaiting_since = time.monotonic()
        try:
            await self._ws.send(json.dumps({"t": "shop.buy", "kind": kind, "id": item_id, "qty": qty}))
        except Exception as e:  # noqa: BLE001
            self._awaiting = None
            self._emit_buy_error(kind, item_id, qty, f"Falha ao enviar pedido de compra ({type(e).__name__})")
            raise
        log.info("[%s] shop.buy kind=%s id=%s qty=%s enviado",
                 self.account_name, kind, item_id, qty)
        return True

    @property
    def awaiting_confirmation(self) -> bool:
        if self._awaiting is not None and time.monotonic() - self._awaiting_since > BUY_CONFIRM_TIMEOUT_S:
            kind, item_id, qty = self._awaiting
            log.warning("[%s] sem confirmação de compra de %s em %ss; liberando",
                        self.account_name, self._awaiting, BUY_CONFIRM_TIMEOUT_S)
            self._awaiting = None
            self._emit_buy_error(
                kind, item_id, qty,
                f"Sem confirmação do servidor após {BUY_CONFIRM_TIMEOUT_S}s (verifique se há Gold suficiente)",
            )
        return self._awaiting is not None


class AutoRestock:
    """Repõe automaticamente um item (Potion ou Ball) quando o estoque cai
    ABAIXO de `threshold`, comprando sempre `qty` unidades.

    Quais IDs repor ("equipados"), em ordem de prioridade:
      Potion: 1) `ACCn_POTION_ID` (escolha salva); 2) 1ª poção de `estado.automation.potionIds`;
              3) `heldItemId` do Pokémon ativo (se for uma Potion conhecida).
      Ball:   1) `ACCn_BALL_ID` (escolha salva, se comprável); 2) 1ª bola de
              `estado.automation.ballIds` (se comprável); 3) 1ª comprável da
              prioridade de captura configurada.
    """

    RETRY_S = 30  # não repete a compra do mesmo ID antes disso (ex.: gold insuficiente)

    def __init__(self, account_name: str, estado: dict, shop: ShopManager, *, kind: str,
                 get_ids, threshold: int, qty: int, gold_reserve=0):
        self.account_name = account_name
        self.estado = estado
        self.shop = shop
        self.kind = kind            # "item" (Potion) | "ball"
        self._get_ids = get_ids     # callable -> list[int]
        self.threshold = threshold
        self.qty = qty
        self._gold_reserve = gold_reserve
        self._last_try: dict[int, float] = {}
        self._last_reserve_alert: dict[int, float] = {}

    def _stock(self, item_id: int) -> int:
        bucket = "balls" if self.kind == "ball" else "items"
        return int((self.estado.get(bucket) or {}).get(str(item_id), 0) or 0)

    def _below_gold_reserve(self) -> bool:
        reserve = max(0, int(_live(self._gold_reserve) or 0))
        if reserve <= 0:
            return False
        gold = int(self.estado.get("gold") or 0)
        return gold <= reserve

    async def check_and_restock(self) -> None:
        if self.shop.awaiting_confirmation:
            return
        now = time.monotonic()
        below_reserve = self._below_gold_reserve()
        for item_id in self._get_ids():
            stock = self._stock(item_id)
            if stock >= self.threshold or now - self._last_try.get(item_id, -1e9) < self.RETRY_S:
                continue
            if below_reserve:
                if now - self._last_reserve_alert.get(item_id, -1e9) >= RESERVE_ALERT_COOLDOWN_S:
                    self._last_reserve_alert[item_id] = now
                    reserve = max(0, int(_live(self._gold_reserve) or 0))
                    self.shop._emit_buy_error(
                        self.kind, item_id, self.qty,
                        f"Compra bloqueada pelo piso de segurança ({reserve:,} Gold)",
                    )
                return
            self._last_try[item_id] = now
            if await self.shop.buy(self.kind, item_id, self.qty):
                log.info("[%s] estoque de %s id=%s baixo (%s < %s); comprando %s",
                         self.account_name, self.kind, item_id, stock, self.threshold, self.qty)
            return  # uma compra por vez (aguarda k:"compra")


def _live(value):
    """Aceita um valor fixo ou uma função que o devolve na hora (para trocar a escolha sem reconectar)."""
    return value() if callable(value) else value


def potion_ids_resolver(estado: dict, get_active_pokemon, potion_id):
    def resolve() -> list[int]:
        pid = _live(potion_id)
        if pid is not None:
            return [pid]
        auto_ids = [i for i in (estado.get("automation") or {}).get("potionIds", []) if i in KNOWN_POTION_IDS]
        if auto_ids:
            # Só a 1ª poção (a realmente equipada/exibida no card): o jogo manda a fila inteira [200,201,202,203,204].
            return auto_ids[:1]
        pk = get_active_pokemon()
        held = pk.get("heldItemId") if pk else None
        if held in KNOWN_POTION_IDS:
            return [held]
        return []
    return resolve


def ball_ids_resolver(estado: dict, ball_priority, ball_id):
    def resolve() -> list[int]:
        bid = _live(ball_id)
        if bid is not None:
            return [bid] if bid in BUYABLE_BALL_IDS else []
        raw_ids = [i for i in (estado.get("automation") or {}).get("ballIds", []) if isinstance(i, int)]
        if raw_ids:
            # Só a 1ª bola equipada na fila da automação (se for comprável na loja NPC).
            return [raw_ids[0]] if raw_ids[0] in BUYABLE_BALL_IDS else []
        return [i for i in ball_priority if i in BUYABLE_BALL_IDS][:1]
    return resolve
