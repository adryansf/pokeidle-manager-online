"""Rotas do painel para os recursos de features.py (auto-venda, prey, boss, banco, anúncios, oferenda/sacrifício).

Ações irreversíveis (enviar coins, anunciar/cancelar no mercado, oferenda, sacrifício) exigem `confirm: true` no
corpo e só acontecem por pedido explícito do usuário — nada aqui roda sozinho.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import TYPE_CHECKING, Literal

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from auth import Auth
from features import BANK_MIN, NICK_OK, FeatureError, destroy_block_reason
from store import Store

if TYPE_CHECKING:
    from connection import AccountConnection
    from manager import AccountManager


class ToggleIn(BaseModel):
    ativo: bool


class PreyRollIn(BaseModel):
    cartela: int = Field(ge=0, le=1)


class PreyChooseIn(BaseModel):
    cartela: int = Field(ge=0, le=1)
    pk: int = Field(ge=1)


class BossAutoIn(BaseModel):
    ativo: bool
    key: str = Field(min_length=1, max_length=64)


class BossEnterIn(BaseModel):
    key: str = Field(min_length=1, max_length=64)


class ConsolidateIn(BaseModel):
    target: str = Field(min_length=3, max_length=16)
    accounts: list[int] = Field(min_length=1, max_length=200)
    reserve: int = Field(default=0, ge=0)
    confirm: bool = False


class ListingIn(BaseModel):
    tipo: Literal["item", "pokemon"]
    itemId: int | None = Field(default=None, ge=1)
    pokemonId: int | None = Field(default=None, ge=1)
    qtd: int = Field(default=1, ge=1, le=1_000_000)
    preco: int = Field(ge=1)
    moeda: Literal["gold", "orb"] = "gold"
    dias: int | None = Field(default=None, ge=1, le=365)
    confirm: bool = False


class ListingEditIn(BaseModel):
    preco: int | None = Field(default=None, ge=1)
    moeda: Literal["gold", "orb"] | None = None
    dias: int | None = Field(default=None, ge=1, le=365)
    confirm: bool = False


class ConfirmIn(BaseModel):
    confirm: bool = False


class DestroyIn(BaseModel):
    pokemonIds: list[int] = Field(min_length=1, max_length=50)
    confirm: bool = False


def _err(msg: str, code: int = 400) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=code)


NEED_CONFIRM = "Ação irreversível: envie confirm=true para confirmar."


def register_feature_routes(app: FastAPI, manager: "AccountManager", store: Store, auth: Auth) -> None:
    consolidate_lock = asyncio.Lock()

    def online_conn(acc_id: int) -> "AccountConnection | JSONResponse":
        conn = manager.get(acc_id)
        if conn is None:
            return _err("conta não encontrada ou desligada", 404)
        if not conn.can_send:
            return _err("A conta está offline.", 409)
        return conn

    async def run(coro):
        try:
            return await coro
        except FeatureError as e:
            return _err(str(e))
        except RuntimeError as e:      # send_frame com a conta caindo no meio
            return _err(str(e) or "conta offline", 409)

    # ------------------------------------------------------------------ visão geral
    @app.get("/api/accounts/{acc_id}/features")
    async def features_view(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := auth.read_guard(request, tok)):
            return r
        conn = manager.get(acc_id)
        if conn is None:
            return _err("conta não encontrada ou desligada", 404)
        return conn.features.view()

    # ------------------------------------------------------------------ 1) Auto-venda do Depot
    @app.post("/api/accounts/{acc_id}/features/auto-venda")
    async def auto_venda(acc_id: int, body: ToggleIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Liga/desliga a Auto Venda do Depot do próprio jogo (o estado fica salvo no jogo)."""
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        res = await run(conn.features.set_auto_venda_depot(body.ativo))
        if isinstance(res, JSONResponse):
            return res
        return {"ok": True, "autoVendaDepot": res}

    # ------------------------------------------------------------------ 5) Prey
    @app.post("/api/accounts/{acc_id}/features/auto-prey")
    async def auto_prey(acc_id: int, body: ToggleIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Prey diário automático (opt-in, só a roletada grátis). Persiste nas opções da conta."""
        if (r := auth.guard(request, tok)):
            return r
        conn = manager.get(acc_id)
        if conn is None:
            return _err("conta não encontrada ou desligada", 404)
        conn.acc = replace(conn.acc, auto_prey=bool(body.ativo))
        store.update_account(acc_id, {"options": {"auto_prey": bool(body.ativo)}})
        if body.ativo:
            conn.features._last_prey_tick = 0.0
        return {"ok": True, "autoPrey": bool(body.ativo)}

    @app.post("/api/accounts/{acc_id}/prey/roll")
    async def prey_roll(acc_id: int, body: PreyRollIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Roletada GRÁTIS do dia numa cartela (não há roletada paga pelo painel)."""
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.prey_roll_free(body.cartela))

    @app.post("/api/accounts/{acc_id}/prey/choose")
    async def prey_choose(acc_id: int, body: PreyChooseIn, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.prey_choose(body.cartela, body.pk))

    # ------------------------------------------------------------------ 6) Boss
    @app.post("/api/accounts/{acc_id}/boss/auto")
    async def boss_auto(acc_id: int, body: BossAutoIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Repetição automática do boss do próprio jogo (`boss.auto`): ao fim da luta cura e volta."""
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.boss_auto(body.ativo, body.key))

    @app.post("/api/accounts/{acc_id}/boss/enter")
    async def boss_enter(acc_id: int, body: BossEnterIn, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.boss_enter(body.key))

    @app.post("/api/accounts/{acc_id}/boss/leave")
    async def boss_leave(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.boss_leave())

    # ------------------------------------------------------------------ 3) Juntar coins
    def consolidate_plan(body: ConsolidateIn) -> list[dict]:
        out = []
        for acc_id in dict.fromkeys(body.accounts):
            conn = manager.get(acc_id)
            if conn is None:
                out.append({"account": f"acc{acc_id}", "id": acc_id, "nick": None, "gold": 0, "level": 0, "amount": 0,
                            "fee": 0, "net": 0, "status": "skip", "detail": "conta não encontrada ou desligada"})
                continue
            out.append(conn.features.bank_plan(body.target.strip(), body.reserve))
        return out

    def plan_summary(plan: list[dict]) -> dict:
        ok = [p for p in plan if p["status"] == "ok"]
        return {"accounts": len(ok), "amount": sum(p["amount"] for p in ok), "fee": sum(p["fee"] for p in ok),
                "net": sum(p["net"] for p in ok)}

    @app.post("/api/coins/consolidate/preview")
    async def consolidate_preview(body: ConsolidateIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Simula o "Juntar coins": quanto cada conta enviaria ao destino (nada é enviado)."""
        if (r := auth.guard(request, tok)):
            return r
        if not NICK_OK.match(body.target.strip()):
            return _err("Nick de destino inválido.")
        plan = consolidate_plan(body)
        return {"ok": True, "target": body.target.strip(), "reserve": body.reserve, "min": BANK_MIN,
                "plan": plan, "total": plan_summary(plan)}

    @app.post("/api/coins/consolidate")
    async def consolidate(body: ConsolidateIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Envia (banco.coins) o ouro acima da reserva de cada conta escolhida para o nick de destino.
        IRREVERSÍVEL (taxa de 15% queimada): exige confirm=true; uma conta por vez; nunca automático."""
        if (r := auth.guard(request, tok)):
            return r
        if not body.confirm:
            return _err(NEED_CONFIRM)
        target = body.target.strip()
        if not NICK_OK.match(target):
            return _err("Nick de destino inválido.")
        if consolidate_lock.locked():
            return _err("Já há uma transferência em andamento.", 409)
        async with consolidate_lock:
            results = []
            for p in consolidate_plan(body):
                if p["status"] != "ok":
                    results.append(p)
                    continue
                conn = manager.get(p["id"])
                try:
                    res = await conn.features.bank_send(target, p["amount"])
                except FeatureError as e:
                    res = {"ok": False, "status": "recusado", "detail": str(e)}
                except RuntimeError as e:
                    res = {"ok": False, "status": "offline", "detail": str(e) or "conta offline"}
                results.append({**p, **{k: v for k, v in res.items() if k != "ok"}, "ok": bool(res.get("ok"))})
            sent = [x for x in results if x.get("status") == "enviado"]
            return {"ok": True, "target": target, "results": results,
                    "total": {"accounts": len(sent), "amount": sum(x["amount"] for x in sent),
                              "fee": sum(x.get("fee", 0) for x in sent), "net": sum(x.get("net", 0) for x in sent)}}

    # ------------------------------------------------------------------ 4) Vender no mercado
    @app.post("/api/accounts/{acc_id}/market/listings")
    async def create_listing(acc_id: int, body: ListingIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Cria um anúncio (`market.criar`). Item: dias=null. Pokémon (experimental): paga a estadia em coins."""
        if (r := auth.guard(request, tok)):
            return r
        if not body.confirm:
            return _err(NEED_CONFIRM)
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.market_create(
            tipo=body.tipo, item_id=body.itemId, pokemon_id=body.pokemonId, qtd=body.qtd,
            preco=body.preco, moeda=body.moeda, dias=body.dias))

    @app.post("/api/accounts/{acc_id}/market/listings/{listing_id}/cancel")
    async def cancel_listing(acc_id: int, listing_id: int, body: ConfirmIn, request: Request,
                             tok: str | None = Query(None, alias="token")):
        """Remove um anúncio próprio (`market.cancelar`); o item/pokémon volta para a conta."""
        if (r := auth.guard(request, tok)):
            return r
        if not body.confirm:
            return _err(NEED_CONFIRM)
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.market_cancel(listing_id))

    @app.patch("/api/accounts/{acc_id}/market/listings/{listing_id}")
    async def edit_listing(acc_id: int, listing_id: int, body: ListingEditIn, request: Request,
                           tok: str | None = Query(None, alias="token")):
        """Troca o preço/moeda (`market.editar`) e/ou estende a estadia de um pokémon (`market.estender`)."""
        if (r := auth.guard(request, tok)):
            return r
        if not body.confirm:
            return _err(NEED_CONFIRM)
        if body.preco is None and not body.dias:
            return _err("Nada para alterar.")
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.market_edit(listing_id, preco=body.preco, moeda=body.moeda, dias=body.dias))

    # ------------------------------------------------------------------ 7) Oferenda / Sacrifício
    @app.get("/api/accounts/{acc_id}/destroy/candidates")
    async def destroy_candidates(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Pokémon do Depot com o motivo de bloqueio (shiny, coleção, equipe, protegido...). Pede os protegidos ao jogo."""
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        try:
            prot = await conn.features.fetch_protegidos()
        except RuntimeError as e:
            return _err(str(e) or "conta offline", 409)
        if prot is None:
            return _err("O jogo não devolveu a lista de protegidos.", 502)
        est = conn.estado
        rows = []
        for pk in est.get("pokemons") or []:
            if not isinstance(pk, dict):
                continue
            why = destroy_block_reason(pk, est, set(prot))
            rows.append({"id": pk.get("id"), "nome": pk.get("nome"), "speciesId": pk.get("speciesId"),
                         "level": pk.get("level"), "nota": pk.get("nota"), "shiny": bool(pk.get("shiny")),
                         "looktype": pk.get("looktype"), "allowed": why is None, "reason": why})
        rows.sort(key=lambda x: (not x["allowed"], float(x.get("nota") or 0), int(x.get("level") or 0)))
        return {"ok": True, "protegidos": len(prot), "pokemons": rows}

    async def destroy(kind: str, acc_id: int, body: DestroyIn, request: Request, tok: str | None):
        if (r := auth.guard(request, tok)):
            return r
        if not body.confirm:
            return _err(NEED_CONFIRM)
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        res = await run(conn.features.destroy(kind, body.pokemonIds))
        if isinstance(res, dict) and res.get("blocked"):
            return JSONResponse(res, status_code=400)
        return res

    @app.post("/api/accounts/{acc_id}/oferenda")
    async def oferenda(acc_id: int, body: DestroyIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Gira a Oferenda com até 5 pokémon escolhidos (`oferenda.girar`). DESTRÓI os pokémon: confirm=true."""
        return await destroy("oferenda", acc_id, body, request, tok)

    @app.post("/api/accounts/{acc_id}/sacrificio")
    async def sacrificio(acc_id: int, body: DestroyIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Sacrifica até 50 pokémon escolhidos (`sacrificio.sacrificar`). DESTRÓI os pokémon: confirm=true."""
        return await destroy("sacrificio", acc_id, body, request, tok)

    @app.post("/api/accounts/{acc_id}/sacrificio/resgatar")
    async def sacrificio_resgatar(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Resgata o boost de XP do nível alcançado na barra do Sacrifício (`sacrificio.resgatar`)."""
        if (r := auth.guard(request, tok)):
            return r
        conn = online_conn(acc_id)
        if isinstance(conn, JSONResponse):
            return conn
        return await run(conn.features.sacrificio_resgatar())
