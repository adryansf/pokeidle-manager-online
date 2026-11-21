"""Ações do painel sobre as contas: trocar de hunt, trocar poção/bola e o catálogo do mapa.

Tudo exige login no painel (ou o TELEMETRY_TOKEN), como em admin_api.py. Os comandos usam só frames
já confirmados do protocolo: `hunt.select` (docs/02) e `auto.set` (docs/04).
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import replace
from typing import TYPE_CHECKING, Literal

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from auth import Auth
from connection import AccountConnection, State
from game_data import BALL_NAMES
from shop import BUYABLE_BALL_IDS, KNOWN_POTION_IDS
from store import Store

if TYPE_CHECKING:
    from manager import AccountManager

SITE = "https://pokeidle.io"
HUNT_CONFIRM_TIMEOUT_S = 6.0   # o jogo confirma a troca com batalha.ev[].k == "hunt"
PASS_CLAIM_TIMEOUT_S = 6.0      # o jogo confirma o resgate do passe com {"t": "passe", "resgate": ...}


class HuntIn(BaseModel):
    slug: str


class OutlandTierIn(BaseModel):
    tier: int


class EquipIn(BaseModel):
    kind: Literal["ball", "potion"]
    id: int


class PauseIn(BaseModel):
    paused: bool | None = None


class BulkPauseIn(BaseModel):
    paused: bool


class BulkEquipIn(BaseModel):
    kind: Literal["ball", "potion"]
    id: int


class BulkHuntIn(BaseModel):
    slug: str


class AutomationPatchIn(BaseModel):
    autoCatch: bool | None = None
    autoPotion: bool | None = None
    potionThreshold: int | None = None
    potionQty: int | None = None
    autoBallRestock: bool | None = None
    ballThreshold: int | None = None
    ballQty: int | None = None
    autoPotionFallback: bool | None = None
    autoCenter: bool | None = None
    autoCenterHpPct: int | None = None
    goldReserve: int | None = None
    huntSlug: str | None = None
    autoBestHunt: bool | None = None
    autoBestHuntRegion: str | None = None
    gameAutoPotion: bool | None = None
    hpLimiarPct: int | None = None
    pvpAuto: bool | None = None


def hunt_catalog(conn: AccountConnection) -> list[dict]:
    """`welcome.hunts` da conta, só com os campos que o mapa usa."""
    out = []
    for h in conn.hunts:
        if not isinstance(h, dict) or not h.get("slug"):
            continue
        out.append({
            "slug": h["slug"], "nome": h.get("nome") or h["slug"], "area": h.get("area") or "kanto",
            "nivel": h.get("nivel") or 0, "regiao": h.get("regiao"), "pixel": h.get("pixel"),
            "looktype": h.get("looktype"), "totalSpawns": h.get("totalSpawns") or 0,
            "especies": [{"pokeId": e.get("pokeId"), "nome": e.get("nome"), "pontos": e.get("pontos", 0)}
                         for e in h.get("especies") or [] if isinstance(e, dict)],
        })
    return out


# Variantes Outland (#2001+): o nome é "<prefixo> <espécie base>" e elas herdam o sprite da base.
OUTLAND_MIN, OUTLAND_MAX = 2001, 2059
OUTLAND_LEGACY_MIN, OUTLAND_LEGACY_MAX = 10501, 10548   # faixa antiga do espelho: normaliza para 2001+
ORRE_MIN, ORRE_MAX = 13000, 14000                        # clones de Orre (#13000 + dex): sprite do nacional
OUTLAND_PREFIXES = (
    "Brave ", "Tribal ", "Ancient ", "War ", "Furious ", "Charged ", "Magnetic ", "Evil ", "Freezing ", "Psy ",
    "Heavy ", "Milch-", "Roll ", "Hard ", "Brute ", "Enraged ", "Dark ", "Trickmaster ", "Banshee ",
    "Taekwondo ", "Enigmatic ", "Magma ", "Toxic ",
)
CATALOG_FILES = ("creatures.json", "creatures-novos.json", "creatures-outland-novos.json", "creatures-formas.json")


def merge_creatures(parts: list[dict], lab: dict | None = None) -> list[dict]:
    """Junta os arquivos de espécies do jogo como o cliente oficial faz: lista única, normaliza o Outland antigo,
    aplica os looktypes do lab e faz Orre e Outland herdarem o sprite da espécie base. Devolve as espécies completas."""
    creatures: list[dict] = []
    for p in parts:
        creatures.extend(c for c in (p or {}).get("creatures", []) if isinstance(c, dict) and c.get("pokeId") is not None)
    creatures = [dict(c) for c in creatures]
    for c in creatures:
        if OUTLAND_LEGACY_MIN <= int(c["pokeId"]) < OUTLAND_LEGACY_MAX:
            c["pokeId"] = int(c["pokeId"]) - (OUTLAND_LEGACY_MIN - OUTLAND_MIN)
    by_id: dict[int, dict] = {}
    for c in creatures:
        by_id.setdefault(int(c["pokeId"]), c)
    for patch in (lab or {}).get("patches", []):
        c = by_id.get(patch.get("pokeId"))
        if c is not None and patch.get("looktype"):
            c["looktype"] = patch["looktype"]
    by_name = {str(c.get("name", "")).lower(): c for c in creatures if int(c["pokeId"]) <= 1025}
    for c in creatures:
        pid = int(c["pokeId"])
        base = None
        if ORRE_MIN <= pid < ORRE_MAX:
            base = by_id.get(pid - ORRE_MIN)
        elif OUTLAND_MIN <= pid < OUTLAND_MAX:
            name = str(c.get("name", "")).strip()
            for pre in OUTLAND_PREFIXES:
                if name.startswith(pre):
                    name = name[len(pre):]
                    break
            base = by_name.get(name.lower())
        if base is not None and (base.get("looktype") or 0) > 1:
            c["looktype"] = base["looktype"]
    return creatures


def merge_catalog(parts: list[dict], lab: dict | None = None) -> dict:
    """O mesmo catálogo, no formato compacto que o navegador baixa."""
    return compact_creatures({"creatures": merge_creatures(parts, lab)})


CATALOG_TTL_S = 3600
_catalog: dict = {}


async def load_catalog() -> dict | None:
    """Baixa (cache de 1 h) os arquivos de espécies do jogo. Devolve {"compact": {...}, "full": {pokeId: espécie}}
    ou None se o site não respondeu e não há cópia anterior."""
    if _catalog.get("exp", 0) > time.time():
        return _catalog
    import aiohttp

    async def fetch(s, name: str):
        try:
            async with s.get(f"{SITE}/assets/{name}") as resp:
                return json.loads(await resp.text()) if resp.status == 200 else None
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return None  # arquivo opcional: o catálogo fica só com o que veio

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
        *parts, lab = await asyncio.gather(*(fetch(s, n) for n in (*CATALOG_FILES, "creatures-sprites-lab.json")))
    if not parts[0]:
        return _catalog or None
    full = merge_creatures(parts, lab)
    _catalog.update(exp=time.time() + CATALOG_TTL_S, compact=compact_creatures({"creatures": full}),
                    full={int(c["pokeId"]): c for c in full})
    return _catalog


def compact_creatures(raw: dict) -> dict:
    """creatures.json do jogo -> {pokeId: {n: nome, t: [tipos], l: [nomes de loot], lk: looktype}} (leve para o navegador)."""
    out: dict[str, dict] = {}
    for c in raw.get("creatures", []):
        if not isinstance(c, dict) or c.get("pokeId") is None:
            continue
        types = [t for t in (c.get("type1"), c.get("type2")) if t]
        loot = [l.get("name") for l in c.get("loot") or [] if isinstance(l, dict) and l.get("name")]
        out[str(c["pokeId"])] = {"n": c.get("name"), "t": types, "l": loot, "lk": c.get("looktype")}
    return out


def register_action_routes(app: FastAPI, manager: "AccountManager", store: Store, auth: Auth) -> None:
    def guard(request: Request, tok: str | None):
        return auth.guard(request, tok)

    def conn_of(acc_id: int) -> AccountConnection | None:
        return manager.get(acc_id)

    @app.get("/api/hunts")
    async def hunts(request: Request, tok: str | None = Query(None, alias="token"), account: str | None = None):
        if (r := guard(request, tok)):
            return r
        conns = manager.connections()
        pick = next((c for c in conns if f"acc{c.acc.index}" == account), None) if account else None
        pick = pick or next((c for c in conns if c.hunts), None)
        if pick is None:
            return {"account": None, "level": 0, "current": None, "hunts": []}
        s = pick.hunt.session
        return {"account": f"acc{pick.acc.index}", "level": pick.estado.get("level") or 0,
                "current": s.slug if s else pick.estado.get("huntSlug"), "hunts": hunt_catalog(pick),
                "outland": {"tiers": pick.outland_tiers, "tier": pick.outland_tier()["tier"]}}

    @app.get("/api/creatures")
    async def creatures(request: Request, tok: str | None = Query(None, alias="token")):
        """creatures.json do jogo (tipos e loot), com cache de 1h: o site não envia CORS."""
        if (r := guard(request, tok)):
            return r
        cat = await load_catalog()
        if cat is None:
            return JSONResponse({"error": "não consegui baixar os dados do jogo"}, status_code=502)
        return JSONResponse(cat["compact"], headers={"Cache-Control": "max-age=3600"})

    @app.post("/api/accounts/{acc_id}/hunt")
    async def select_hunt(acc_id: int, body: HuntIn, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        if not conn.can_send:
            return JSONResponse({"error": "A conta está offline."}, status_code=409)
        if body.slug not in {h.get("slug") for h in conn.hunts if isinstance(h, dict)}:
            return JSONResponse({"error": "Hunt desconhecida para esta conta."}, status_code=400)
        # Em combate o jogo recusa a troca: entra na fila e o bot troca sozinho quando a trava acabar.
        wait = conn.combat_lock_ms()
        if wait > 0:
            conn.queue_hunt(body.slug)
            return {"ok": True, "confirmed": False, "queued": True, "waitMs": wait, "slug": body.slug}
        conn.queue_hunt(None)  # um pedido novo sem trava substitui qualquer fila antiga
        await conn.hunt.select_hunt(body.slug)
        # O envio não prova nada: quem confirma é o evento `hunt` do jogo (recusa em combate/nível não responde).
        for _ in range(int(HUNT_CONFIRM_TIMEOUT_S / 0.25)):
            await asyncio.sleep(0.25)
            s = conn.hunt.session
            if s is not None and s.slug == body.slug:
                return {"ok": True, "confirmed": True, "slug": body.slug}
        return {"ok": True, "confirmed": False, "slug": body.slug}

    @app.post("/api/accounts/{acc_id}/outland-tier")
    async def select_outland_tier(acc_id: int, body: OutlandTierIn, request: Request,
                                  tok: str | None = Query(None, alias="token")):
        """Troca o nível de Outland da conta (como o seletor do mapa do jogo)."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        if not conn.can_send:
            return JSONResponse({"error": "A conta está offline."}, status_code=409)
        tier = next((t for t in conn.outland_tiers if t["tier"] == body.tier), None)
        if tier is None:
            return JSONResponse({"error": "Nível de Outland desconhecido."}, status_code=400)
        level = conn.estado.get("level") or 0
        if level < tier["nivel"]:
            return JSONResponse({"error": f"{tier['rotulo']} pede nível {tier['nivel']} de treinador."}, status_code=400)
        await conn.hunt.select_outland_tier(tier["tier"])
        for _ in range(int(HUNT_CONFIRM_TIMEOUT_S / 0.25)):      # quem confirma é o `estado.outlandTier` do jogo
            await asyncio.sleep(0.25)
            if conn.outland_tier()["tier"] == tier["tier"] and conn.estado.get("outlandTier") == tier["tier"]:
                return {"ok": True, "confirmed": True, "tier": tier["tier"]}
        return {"ok": True, "confirmed": False, "tier": tier["tier"]}

    @app.post("/api/accounts/{acc_id}/pass/claim")
    async def claim_pass(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Resgata o dia do Passe de Batalha da conta (o mesmo botão do jogo)."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        if not conn.can_send:
            return JSONResponse({"error": "A conta está offline."}, status_code=409)
        why = conn.pass_status()
        if why == "nivel":
            return JSONResponse({"error": "O Passe de Batalha libera no nível 10 de treinador."}, status_code=400)
        if why == "ja_resgatado":
            return JSONResponse({"error": "O dia de hoje já foi resgatado. O próximo libera à meia-noite de Brasília."},
                                status_code=409)
        seq = conn.pass_claim_seq
        await conn.claim_pass()
        for _ in range(int(PASS_CLAIM_TIMEOUT_S / 0.25)):       # quem confirma é a resposta `passe.resgate` do jogo
            await asyncio.sleep(0.25)
            if conn.pass_claim_seq != seq:
                return {"ok": True, "confirmed": True, "claim": conn.pass_claim}
        return {"ok": True, "confirmed": False, "claim": None}

    @app.delete("/api/accounts/{acc_id}/hunt/queue")
    async def cancel_hunt_queue(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        conn.queue_hunt(None)
        return {"ok": True}

    @app.get("/api/accounts/{acc_id}/sheet")
    async def pokemon_sheet(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Ficha do Pokémon equipado (o que a calculadora de hunt precisa), direto do estado do jogo."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        pk = conn.hunt.active_pokemon()
        if not pk or not isinstance(pk.get("stats"), dict) or not isinstance(pk.get("ivs"), dict):
            return JSONResponse({"error": "A conta não tem um Pokémon equipado com ficha completa."}, status_code=409)
        return {
            "id": pk.get("id"), "speciesId": pk.get("speciesId"), "nome": pk.get("nome"), "looktype": pk.get("looktype"),
            "level": pk.get("level") or 1, "shiny": bool(pk.get("shiny")), "quality": pk.get("quality"),
            "potencia": pk.get("potencia") or 1, "stats": pk["stats"], "ivs": pk["ivs"], "tmAoe": bool(pk.get("tmAoe")),
            "trainerLevel": conn.estado.get("level") or 1,
        }

    @app.post("/api/session/reset")
    async def reset_session(request: Request, tok: str | None = Query(None, alias="token"), account: int | None = None):
        """Zera a sessão (tempo e itens coletados) de uma conta ou de todas as ligadas."""
        if (r := guard(request, tok)):
            return r
        targets = [c for c in manager.connections() if account in (None, c.acc.index)]
        if not targets:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        for c in targets:
            c.reset_session()
        return {"ok": True, "reset": [f"acc{c.acc.index}" for c in targets]}

    @app.post("/api/accounts/{acc_id}/equip")
    async def equip(acc_id: int, body: EquipIn, request: Request, tok: str | None = Query(None, alias="token")):
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        if not conn.can_send:
            return JSONResponse({"error": "A conta está offline."}, status_code=409)
        is_ball = body.kind == "ball"
        if (is_ball and body.id not in BALL_NAMES) or (not is_ball and body.id not in KNOWN_POTION_IDS):
            return JSONResponse({"error": "Item inválido."}, status_code=400)
        await conn.set_automation({"ballIds": [body.id]} if is_ball else {"potionIds": [body.id]})
        # A escolha vira o alvo da reposição automática (e sobrevive a reinícios).
        field = "ball_id" if is_ball else "potion_id"
        store.update_account(acc_id, {"options": {field: body.id}})
        conn.acc = replace(conn.acc, **{field: body.id})
        bucket = "balls" if is_ball else "items"
        stock = int((conn.estado.get(bucket) or {}).get(str(body.id), 0) or 0)
        threshold = conn.acc.ball_restock_threshold if is_ball else conn.acc.potion_restock_threshold
        enabled = conn.acc.auto_ball_restock if is_ball else conn.acc.auto_potion
        buyable = (body.id in BUYABLE_BALL_IDS) if is_ball else True
        will_buy = enabled and buyable and stock < threshold
        if will_buy:
            await conn.restock_now("ball" if is_ball else "item")
        return {"ok": True, "stock": stock, "willBuy": will_buy, "restockEnabled": enabled, "buyable": buyable}

    @app.post("/api/accounts/{acc_id}/pause")
    async def toggle_pause(acc_id: int, request: Request, body: PauseIn | None = None,
                           tok: str | None = Query(None, alias="token")):
        """Pausa ou retoma manualmente uma conta sem removê-la do Dashboard."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        target = (not conn.manual_paused) if (body is None or body.paused is None) else bool(body.paused)
        await conn.set_manual_pause(target)
        return {"ok": True, "paused": conn.manual_paused, "state": conn.state.value}

    @app.get("/api/accounts/{acc_id}/live")
    async def account_live(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Visão Ao Vivo (Modo Live) da conta em tempo real: Pokémon ativo, slots do campo de batalha e feed."""
        if (r := auth.read_guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        from game_data import POKEMON_NAMES
        from sprite_outfit import look_of

        conn.hunt._prune_live_slots()
        s = conn.hunt.session
        slug = s.slug if s else conn.estado.get("huntSlug")
        hunt_obj = next((h for h in conn.hunts if isinstance(h, dict) and h.get("slug") == slug), None)
        # Mapa de nome -> pokeId para enriquecer os slots selvagens com o sprite da espécie
        name_to_pid: dict[str, int] = {}
        for pid, pname in POKEMON_NAMES.items():
            if pname:
                name_to_pid.setdefault(str(pname).lower(), int(pid))
        for h in conn.hunts:
            if isinstance(h, dict):
                for e in h.get("especies") or []:
                    if isinstance(e, dict) and e.get("nome") and e.get("pokeId"):
                        name_to_pid[str(e["nome"]).lower()] = int(e["pokeId"])
        cat = _catalog.get("full") or {}

        def _look_for(pid: int | None, raw_look: int | None = None) -> int | None:
            if raw_look and raw_look > 1:
                return raw_look
            if pid and pid in cat and (cat[pid].get("looktype") or 0) > 1:
                return cat[pid]["looktype"]
            if pid and 1 <= pid <= 1025:
                return 60000 + pid
            return raw_look

        now_mono = time.monotonic()
        slots = []
        for slot_id in sorted(conn.hunt.live_slots):
            raw_s = conn.hunt.live_slots[slot_id]
            sname = str(raw_s.get("name") or "").strip()
            pid = raw_s.get("pokeId") or (name_to_pid.get(sname.lower()) if sname else None)
            try:
                pid_int = int(pid) if pid is not None else None
            except (TypeError, ValueError):
                pid_int = None
            raw_ball = raw_s.get("ballId")
            try:
                ball_int = int(raw_ball) if raw_ball is not None else None
            except (TypeError, ValueError):
                ball_int = None
            slots.append({
                "slot": slot_id,
                "name": sname or (POKEMON_NAMES.get(pid_int) if pid_int else f"Selvagem #{slot_id}"),
                "pokeId": pid_int,
                "looktype": _look_for(pid_int, raw_s.get("looktype")),
                "level": raw_s.get("level"),
                "shiny": bool(raw_s.get("shiny")),
                "inferred": bool(raw_s.get("inferred")),
                "hp": raw_s.get("hp"),
                "maxHp": raw_s.get("maxHp"),
                "state": raw_s.get("state", "fighting"),
                "lastMove": raw_s.get("lastMove"),
                "lastDamage": raw_s.get("lastDamage"),
                "ballId": ball_int,
                "ballName": BALL_NAMES.get(ball_int) if ball_int is not None else None,
                "chance": raw_s.get("chance"),
                "xp": raw_s.get("xp"),
                "gold": raw_s.get("gold"),
                "drops": raw_s.get("drops") or [],
                "ageMs": max(0, int((now_mono - raw_s.get("_t", now_mono)) * 1000)),
            })
        hunt_species = []
        if isinstance(hunt_obj, dict):
            for e in hunt_obj.get("especies") or []:
                if isinstance(e, dict) and e.get("pokeId"):
                    try:
                        epid = int(e["pokeId"])
                    except (TypeError, ValueError):
                        continue
                    hunt_species.append({
                        "pokeId": epid,
                        "name": e.get("nome") or POKEMON_NAMES.get(epid) or f"#{epid}",
                        "points": e.get("pontos", 0),
                        "looktype": _look_for(epid),
                    })
        pk = conn.hunt.active_pokemon()
        return {
            "account": f"acc{conn.acc.index}",
            "numericId": conn.acc.index,
            "nick": conn.acc.nick,
            "state": conn.state.value,
            "paused": conn.manual_paused or conn.state == State.PAUSED_MANUAL,
            "lastReason": conn.last_reason,
            "combatLockMs": conn.combat_lock_ms(),
            "hunt": {
                "slug": slug,
                "name": (s.nome if s and s.nome else (hunt_obj or {}).get("nome")) or slug,
                "level": (hunt_obj or {}).get("nivel") or 0,
                "kills": s.kills if s else 0,
                "minutes": round(s.elapsed_h * 60, 1) if s else 0,
                "species": hunt_species,
            } if slug else None,
            "pokemon": {
                "name": pk.get("nome", "?"),
                "hp": pk.get("hp", 0),
                "maxHp": pk.get("maxHp", 0),
                "level": pk.get("level"),
                "looktype": look_of(pk),
                "shiny": bool(pk.get("shiny")),
            } if pk else None,
            "slots": slots,
            "events": list(conn.hunt.live_events),
        }

    @app.post("/api/accounts/{acc_id}/farm-pause")
    async def toggle_farm_pause(acc_id: int, request: Request, body: PauseIn | None = None,
                                tok: str | None = Query(None, alias="token")):
        """Pausa/retoma o farm mantendo a conta ONLINE (envia ao Centro Pokémon e fica parada lá)."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        target = (not conn.farm_paused) if (body is None or body.paused is None) else bool(body.paused)
        return await conn.set_farm_pause(target)

    @app.post("/api/bulk/farm-pause")
    async def bulk_farm_pause(body: BulkPauseIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Pausa/retoma o farm (Centro Pokémon) em todas as contas gerenciadas."""
        if (r := guard(request, tok)):
            return r
        conns = manager.connections()
        for c in conns:
            await c.set_farm_pause(body.paused)
        return {"ok": True, "farmPaused": body.paused, "count": len(conns)}

    @app.post("/api/accounts/{acc_id}/center")
    async def go_center(acc_id: int, request: Request, tok: str | None = Query(None, alias="token")):
        """Envia a conta ao Centro Pokémon (centro.ir)."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        if not conn.can_send:
            return JSONResponse({"error": "conta offline no momento"}, status_code=409)
        lock = conn.combat_lock_ms()
        if lock > 0:
            return JSONResponse({"error": f"Em combate — aguarde {int((lock + 999) // 1000)}s para ir ao Centro."}, status_code=409)
        await conn.hunt.go_to_center()
        conn.hunt._push_live_event("center", name=conn.acc.nick, manual=True)
        return {"ok": True}

    @app.post("/api/accounts/{acc_id}/automation")
    async def toggle_automation(acc_id: int, body: AutomationPatchIn, request: Request,
                                tok: str | None = Query(None, alias="token")):
        """Ativa ou desativa itens de automação em tempo real (sem reiniciar a conexão da conta)."""
        if (r := guard(request, tok)):
            return r
        conn = conn_of(acc_id)
        if conn is None:
            return JSONResponse({"error": "conta não encontrada ou desligada"}, status_code=404)
        sent = body.model_fields_set
        opts: dict = {}
        acc_changes: dict = {}
        if "autoCatch" in sent and body.autoCatch is not None:
            opts["auto_catch"] = acc_changes["auto_catch"] = bool(body.autoCatch)
            conn.balls.enabled = bool(body.autoCatch)
        if "autoPotion" in sent and body.autoPotion is not None:
            opts["auto_potion"] = acc_changes["auto_potion"] = bool(body.autoPotion)
        if "potionThreshold" in sent and body.potionThreshold is not None:
            v = min(max(int(body.potionThreshold), 0), 100000)
            opts["potion_restock_threshold"] = acc_changes["potion_restock_threshold"] = v
        if "potionQty" in sent and body.potionQty is not None:
            v = min(max(int(body.potionQty), 1), 100000)
            opts["potion_restock_qty"] = acc_changes["potion_restock_qty"] = v
        if "autoBallRestock" in sent and body.autoBallRestock is not None:
            opts["auto_ball_restock"] = acc_changes["auto_ball_restock"] = bool(body.autoBallRestock)
        if "ballThreshold" in sent and body.ballThreshold is not None:
            v = min(max(int(body.ballThreshold), 0), 100000)
            opts["ball_restock_threshold"] = acc_changes["ball_restock_threshold"] = v
        if "ballQty" in sent and body.ballQty is not None:
            v = min(max(int(body.ballQty), 1), 100000)
            opts["ball_restock_qty"] = acc_changes["ball_restock_qty"] = v
        if "autoPotionFallback" in sent and body.autoPotionFallback is not None:
            opts["auto_potion_fallback"] = acc_changes["auto_potion_fallback"] = bool(body.autoPotionFallback)
        if "autoCenter" in sent and body.autoCenter is not None:
            opts["auto_center"] = acc_changes["auto_center"] = bool(body.autoCenter)
        if "autoCenterHpPct" in sent and body.autoCenterHpPct is not None:
            v = min(max(int(body.autoCenterHpPct), 5), 80)
            opts["auto_center_hp_pct"] = acc_changes["auto_center_hp_pct"] = v
        if "goldReserve" in sent and body.goldReserve is not None:
            v = max(0, int(body.goldReserve))
            opts["gold_reserve"] = acc_changes["gold_reserve"] = v
        if "huntSlug" in sent and body.huntSlug is not None:
            slug_v = body.huntSlug.strip()
            opts["hunt_slug"] = slug_v
            acc_changes["hunt_slug"] = slug_v or None
            if slug_v:
                # Ao escolher uma hunt fixa específica, desliga auto_best_hunt para não conflitar
                opts["auto_best_hunt"] = acc_changes["auto_best_hunt"] = False
                if conn.can_send and not conn.farm_paused:
                    conn.queue_hunt(slug_v)
        if "autoBestHunt" in sent and body.autoBestHunt is not None:
            on = bool(body.autoBestHunt)
            opts["auto_best_hunt"] = acc_changes["auto_best_hunt"] = on
            if on:
                # Ao ligar auto_best_hunt, limpa hunt fixa para não conflitar
                opts["hunt_slug"] = ""
                acc_changes["hunt_slug"] = None
                conn._last_auto_hunt_at = 0.0
        if "autoBestHuntRegion" in sent and body.autoBestHuntRegion is not None:
            reg = (body.autoBestHuntRegion or "all").strip().lower() or "all"
            opts["auto_best_hunt_region"] = acc_changes["auto_best_hunt_region"] = reg
            conn._last_auto_hunt_at = 0.0
        if "pvpAuto" in sent and body.pvpAuto is not None:
            opts["pvp_auto"] = acc_changes["pvp_auto"] = bool(body.pvpAuto)
            conn.pvp.auto = bool(body.pvpAuto)
        if acc_changes:
            conn.acc = replace(conn.acc, **acc_changes)
            restock_keys = {"auto_potion", "potion_restock_threshold", "potion_restock_qty",
                            "auto_ball_restock", "ball_restock_threshold", "ball_restock_qty"}
            if restock_keys & acc_changes.keys():
                conn.rebuild_restockers()
            store.update_account(acc_id, {"options": opts})
        game_patch: dict = {}
        if "gameAutoPotion" in sent and body.gameAutoPotion is not None:
            game_patch["autoPotion"] = bool(body.gameAutoPotion)
        if "hpLimiarPct" in sent and body.hpLimiarPct is not None:
            pct = min(max(int(body.hpLimiarPct), 10), 95)
            game_patch["hpLimiar"] = round(pct / 100.0, 2)
        if game_patch:
            if not conn.can_send:
                return JSONResponse({"error": "conta offline para alterar a cura automática do jogo"}, status_code=409)
            await conn.set_automation(game_patch)
            auto = conn.estado.setdefault("automation", {})
            auto.update(game_patch)
        from telemetry import _automation_snapshot
        return {"ok": True, "automation": _automation_snapshot(conn)}

    @app.get("/api/captures")
    async def list_captures(
        request: Request,
        tok: str | None = Query(None, alias="token"),
        account: str | None = None,
        only_caught: bool = False,
        only_shiny: bool = False,
        limit: int = 200,
    ):
        """Histórico de capturas (tentativas de bola) salvo em banco + estatísticas agregadas."""
        if (r := auth.read_guard(request, tok)):
            return r
        acc_id: int | None = None
        if account and account != "all":
            digits = "".join(ch for ch in str(account) if ch.isdigit())
            if digits:
                acc_id = int(digits)
        items = store.list_captures(
            account_id=acc_id,
            only_caught=only_caught,
            only_shiny=only_shiny,
            limit=limit,
        )
        for it in items:
            it["ballName"] = BALL_NAMES.get(it["ballId"]) if it.get("ballId") else None
        stats = store.capture_stats(account_id=acc_id)
        for b in stats["byBall"]:
            b["ballName"] = BALL_NAMES.get(b["ballId"]) or f"Bola #{b['ballId']}"
        return {"stats": stats, "items": items}

    # ---------------------------------------------------------- Ações em Massa (Modo Eco)
    @app.post("/api/bulk/pause")
    async def bulk_pause(body: BulkPauseIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Pausa ou retoma todas as contas gerenciadas de uma vez."""
        if (r := guard(request, tok)):
            return r
        conns = manager.connections()
        for c in conns:
            await c.set_manual_pause(body.paused)
        return {"ok": True, "paused": body.paused, "count": len(conns)}

    @app.post("/api/bulk/center")
    async def bulk_center(request: Request, tok: str | None = Query(None, alias="token")):
        """Envia todas as contas online (fora de trava de combate) ao Centro Pokémon."""
        if (r := guard(request, tok)):
            return r
        sent: list[str] = []
        skipped: list[str] = []
        for c in manager.connections():
            if not c.can_send or c.combat_lock_ms() > 0:
                skipped.append(c.acc.nick)
                continue
            try:
                await c.hunt.go_to_center()
                c.hunt._push_live_event("center", name=c.acc.nick, manual=True)
                sent.append(c.acc.nick)
            except Exception:  # noqa: BLE001
                skipped.append(c.acc.nick)
        return {"ok": True, "sent": sent, "skipped": skipped}

    @app.post("/api/bulk/equip")
    async def bulk_equip(body: BulkEquipIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Equipa a mesma Poção ou Bola em todas as contas online."""
        if (r := guard(request, tok)):
            return r
        is_ball = body.kind == "ball"
        valid = set(BALL_NAMES) if is_ball else KNOWN_POTION_IDS
        if body.id not in valid:
            return JSONResponse({"error": "item desconhecido"}, status_code=400)
        field = "ballIds" if is_ball else "potionIds"
        opt = "ball_id" if is_ball else "potion_id"
        updated: list[str] = []
        skipped: list[str] = []
        for c in manager.connections():
            if not c.can_send:
                skipped.append(c.acc.nick)
                continue
            try:
                await c.set_automation({field: [body.id]})
                c.acc = replace(c.acc, **{opt: body.id})
                store.update_account(c.acc.index, {"options": {opt: body.id}})
                updated.append(c.acc.nick)
            except Exception:  # noqa: BLE001
                skipped.append(c.acc.nick)
        return {"ok": True, "updated": updated, "skipped": skipped}

    @app.post("/api/bulk/hunt")
    async def bulk_hunt(body: BulkHuntIn, request: Request, tok: str | None = Query(None, alias="token")):
        """Seleciona (ou coloca na fila de combate) a mesma hunt em todas as contas online."""
        if (r := guard(request, tok)):
            return r
        sent: list[str] = []
        queued: list[str] = []
        skipped: list[str] = []
        for c in manager.connections():
            if not c.can_send or not any(h.get("slug") == body.slug for h in c.hunts if isinstance(h, dict)):
                skipped.append(c.acc.nick)
                continue
            if c.combat_lock_ms() > 0:
                c.queue_hunt(body.slug)
                queued.append(c.acc.nick)
            else:
                try:
                    c.queue_hunt(None)
                    await c.hunt.select_hunt(body.slug)
                    sent.append(c.acc.nick)
                except Exception:  # noqa: BLE001
                    skipped.append(c.acc.nick)
        return {"ok": True, "sent": sent, "queued": queued, "skipped": skipped}
