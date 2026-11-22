"""Telemetria em tempo real: snapshot das contas + servidor FastAPI.

Endpoints:
    GET /healthz          liveness (sem auth)
    GET /api/telemetry    snapshot atual (JSON)
    WS  /ws/telemetry     snapshot a cada TELEMETRY_INTERVAL_S segundos

Autenticação (auth.py): cookie de sessão (painel) ou TELEMETRY_TOKEN por
`Authorization: Bearer <token>` / `?token=` (scripts). O WebSocket usa o cookie ou `?token=`.

Nunca expõe token/proxy/device_id das contas. As rotas de gestão ficam em admin_api.py.
"""
from __future__ import annotations

from battle_pass import passe_publico
from maps import REGION_LABELS, region_of_hunt
from session_stats import hunt_is_outland
from sprite_outfit import look_of

import asyncio
import json
import os
import time
from typing import TYPE_CHECKING, Callable

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from connection import State
from game_data import ball_name, item_meta
from item_labels import display_name, is_zmove_item, item_icon_path, item_name

if TYPE_CHECKING:
    from connection import AccountConnection

_STATUS = {
    State.ONLINE: "online",
    State.PAUSED_COOLDOWN: "paused_cooldown",
    State.PAUSED_MANUAL: "paused_cooldown",
    State.BLOCKED: "blocked",
}  # o resto (DISCONNECTED/CONNECTING/AUTHENTICATING) -> "offline"


def _count(raw: dict, ids: set[int] | None = None) -> int:
    total = 0
    for k, v in (raw or {}).items():
        try:
            if ids is None or int(k) in ids:
                total += int(v)
        except (TypeError, ValueError):
            continue
    return total


SITE = "https://pokeidle.io"
BALL_ICONS = {1: "/assets/site/assets/ui/ball-poke.png", 2: "/assets/site/assets/ui/ball-great.png",
              3: "/img/ball-super.png", 4: "/assets/site/assets/ui/ball-ultra.png", 5: "/img/ball-beast.png"}


# Nomes em português para itens raros que o jogo envia em inglês.
PT_NAMES = {70011: "Fragmento de Chave", 70012: "Fragmento de Shiny Stone", 70013: "Fragmento de Bicicleta"}

NOT_RARE_CATEGORIES = frozenset({"stone", "heal", "revive"})


def _abs(path: str | None) -> str | None:
    if not path:
        return None
    return SITE + (path if path.startswith("/") else f"/assets/{path}")


def item_rows(c: "AccountConnection") -> list[dict]:
    """Itens da conta com nome/categoria/raro/ícone. Itens só do servidor (70xxx)
    vêm do `welcome.itensNossos`; os demais das tabelas de game_data."""
    rows = []
    for raw_id, qty in (c.estado.get("items") or {}).items():
        try:
            iid, qty = int(raw_id), int(qty)
        except (TypeError, ValueError):
            continue
        nos = c.itens_nossos.get(iid)
        if nos:
            name, cat, rare, icon = nos.get("name", item_name(iid)), nos.get("category", "special"), bool(nos.get("rare")), nos.get("icon")
        else:
            name = item_name(iid)
            cat, rare = item_meta(iid)
            icon = item_icon_path(iid)
        name = PT_NAMES.get(iid, display_name(name))
        if is_zmove_item(iid):
            rare = True
        if cat in NOT_RARE_CATEGORIES:  # pedras e poções não contam como raros, mesmo que o jogo marque
            rare = False
        rows.append({"id": iid, "name": name, "qty": qty, "category": cat, "rare": rare, "icon": _abs(icon)})
    rows.sort(key=lambda r: -r["qty"])
    return rows


def ball_rows(c: "AccountConnection") -> list[dict]:
    return [{"id": i, "name": n, "qty": q, "icon": _abs(BALL_ICONS.get(i))} for i, n, q in c.inventory.balls()]


def _collection_ids(est: dict) -> set[int]:
    auto = est.get("automation") if isinstance(est.get("automation"), dict) else {}
    out: set[int] = set()
    for x in auto.get("pokemonTravado") or []:
        try:
            out.add(int(x))
        except (TypeError, ValueError):
            continue
    return out


_IV_STATS = ("hp", "atk", "def", "spAtk", "spDef", "speed")
_IV_MIN, _IV_MAX = 1, 32


def _normalize_auto_colecao(auto: dict) -> dict:
    """Espelha `autoColecaoEfetiva` / `autoColecaoValida` de shared/auto-colecao.mjs (7 critérios oficiais)."""
    raw = auto.get("autoColecao") if isinstance(auto.get("autoColecao"), dict) else None
    cfg = {
        "lendario": {"on": True},
        "shiny": {"on": True},
        "pot": {"on": True, "min": 4},
        "qual": {"on": False, "min": 1.5},
        "iv": {"on": False, "min": {s: _IV_MIN for s in _IV_STATS}},
        "nota": {"on": False, "min": 3.5},
        "potencial": {"on": False},
    }
    if raw is None:
        cfg["nota"]["on"] = bool(auto.get("autoLockNota9", False))
        try:
            n = float(auto.get("autoLockNotaMin"))
            if 0 <= n <= 10:
                cfg["nota"]["min"] = round(n, 3)
        except (TypeError, ValueError):
            pass
        return cfg

    for key in ("lendario", "shiny", "potencial"):
        v = raw.get(key)
        if isinstance(v, dict) and isinstance(v.get("on"), bool):
            cfg[key]["on"] = v["on"]
    v = raw.get("pot")
    if isinstance(v, dict):
        if isinstance(v.get("on"), bool):
            cfg["pot"]["on"] = v["on"]
        if v.get("min") in (2, 3, 4, 5):
            cfg["pot"]["min"] = int(v["min"])
    v = raw.get("qual")
    if isinstance(v, dict):
        if isinstance(v.get("on"), bool):
            cfg["qual"]["on"] = v["on"]
        try:
            q = round(float(v.get("min")), 1)
            if q in (1.1, 1.3, 1.5, 1.6):
                cfg["qual"]["min"] = q
        except (TypeError, ValueError):
            pass
    v = raw.get("nota")
    if isinstance(v, dict):
        if isinstance(v.get("on"), bool):
            cfg["nota"]["on"] = v["on"]
        try:
            n = float(v.get("min"))
            if 0 <= n <= 10:
                cfg["nota"]["min"] = round(n, 3)
        except (TypeError, ValueError):
            pass
    v = raw.get("iv")
    if isinstance(v, dict):
        if isinstance(v.get("on"), bool):
            cfg["iv"]["on"] = v["on"]
        mins = v.get("min")
        if isinstance(mins, dict):
            for s in _IV_STATS:
                try:
                    iv_val = int(mins.get(s, _IV_MIN))
                    if _IV_MIN <= iv_val <= _IV_MAX:
                        cfg["iv"]["min"][s] = iv_val
                except (TypeError, ValueError):
                    pass
    return cfg


def pokemon_rows(c: "AccountConnection") -> list[dict]:
    """Lista compacta de Pokémons da conta (servida sob demanda em /api/pokemons)."""
    acc_id = f"acc{c.acc.index}"
    locked = _collection_ids(c.estado)
    rows = []
    for p in c.inventory.pokemons():
        ivs = p.get("ivs") or {}
        pid = p.get("id")
        in_col = isinstance(pid, int) and pid in locked
        rows.append({
            "id": pid, "account": acc_id, "speciesId": p.get("speciesId"),
            "name": p.get("nome"), "types": p.get("tipos") or [], "level": p.get("level"),
            "shiny": bool(p.get("shiny")), "quality": p.get("quality"), "power": p.get("poder"),
            "grade": p.get("nota"), "slot": p.get("slot"), "ivTotal": sum(v for v in ivs.values() if isinstance(v, (int, float))),
            "ivs": {s: int(ivs.get(s) or 0) for s in _IV_STATS} if isinstance(ivs, dict) else None,
            "inCollection": in_col,
            "caughtAt": p.get("caughtAt"), "looktype": look_of(p), "potency": p.get("potencia"),
        })
    return rows


ATLAS_TTL_S = 300   # curto: o jogo troca o atlas a cada atualização e posições velhas + imagem nova embaralham os retratos


def atlas_payload(j: dict) -> dict:
    """Índice de retratos do jogo. A imagem sempre leva `?v=<versão>`: sem isso o navegador reaproveita a
    imagem antiga (cache de horas) com as posições novas."""
    image = j.get("image") or "/assets/site/assets/maps/marker-atlas.png"
    version = str(j.get("version") or "")
    if version and "v=" not in image:
        image += ("&" if "?" in image else "?") + "v=" + version
    return {"cell": j.get("cell", 64), "cols": j.get("cols", 16), "rows": j.get("rows", 1),
            "version": version, "image": SITE + image, "slots": j.get("slots", {})}


def equipped_rows(c: "AccountConnection") -> dict:
    """Poção, Ball e Revive equipados no momento (com quantidade), p/ os cards do dashboard."""
    from shop import KNOWN_POTION_IDS, KNOWN_REVIVE_IDS  # evita ciclo em import-time

    est = c.estado
    pk = c.hunt.active_pokemon()
    auto = est.get("automation") or {}

    def _item_opt(i: int) -> dict:
        nos = c.itens_nossos.get(i) or {}
        return {"id": i, "name": nos.get("name") or item_name(i),
                "qty": int((est.get("items") or {}).get(str(i), 0) or 0), "icon": _abs(nos.get("icon") or item_icon_path(i))}

    held = pk.get("heldItemId") if pk else None
    # A automação do jogo é a verdade (o jogador pode trocar a poção lá): só cai na escolha guardada se ela vier vazia.
    potion_id = next((i for i in auto.get("potionIds", []) if i in KNOWN_POTION_IDS), None)
    potion_id = potion_id or c.acc.potion_id or (held if held in KNOWN_POTION_IDS else None)
    potion = _item_opt(potion_id) if potion_id is not None else None

    ball_id = c.acc.ball_id or next(iter(auto.get("ballIds", [])), None) or next(iter(c.acc.ball_priority), None)
    ball = None
    if ball_id is not None:
        ball = {"id": ball_id, "name": ball_name(ball_id),
                "qty": int((est.get("balls") or {}).get(str(ball_id), 0) or 0), "icon": _abs(BALL_ICONS.get(ball_id))}

    revive_id = next((i for i in (auto.get("reviveIds") or []) if i in KNOWN_REVIVE_IDS), None)
    revive_id = revive_id or (c.acc.revive_id if c.acc.revive_id in KNOWN_REVIVE_IDS else None) or 205
    revive = _item_opt(revive_id) if revive_id is not None else None

    # Opções do seletor do card (clicar na poção/bola/revive): todos os itens do jogo, com o estoque da conta.
    options = {
        "potion": [_item_opt(i) for i in sorted(KNOWN_POTION_IDS)],
        "ball": [{"id": i, "name": ball_name(i), "qty": int((est.get("balls") or {}).get(str(i), 0) or 0),
                  "icon": _abs(BALL_ICONS.get(i))} for i in sorted(BALL_ICONS)],
        "revive": [_item_opt(i) for i in sorted(KNOWN_REVIVE_IDS)],
    }
    return {"potion": potion, "ball": ball, "revive": revive, "options": options}


def _pending_hunt(c: "AccountConnection") -> dict | None:
    slug = c.pending_hunt
    if not slug:
        return None
    name = next((h.get("nome") for h in c.hunts if isinstance(h, dict) and h.get("slug") == slug), None)
    return {"slug": slug, "name": name or slug}


def _map_info(c: "AccountConnection", slug: str | None) -> dict | None:
    """Mapa onde a conta caça (região) e, em Outland, o nível dela. O painel mostra isso no card."""
    hunt = next((h for h in c.hunts if isinstance(h, dict) and h.get("slug") == slug), None)
    region = region_of_hunt(hunt)
    if region is None:
        return None
    info: dict = {"region": region, "label": REGION_LABELS.get(region) or region.capitalize(), "outland": None}
    if region == "outland":
        t = c.outland_tier()
        info["outland"] = {"tier": t["tier"], "label": t["rotulo"], "mult": t["mult"]}
        info["label"] = t["rotulo"]
    return info


def _proxy_snapshot(c: "AccountConnection", proxy_names: dict[tuple, str] | None = None) -> dict | None:
    p = c.acc.proxy
    if p is None:
        return None
    key = (p.scheme.lower(), p.host.strip().lower(), int(p.port), p.username or "")
    saved_name = (proxy_names or {}).get(key) or ""
    exit_ip = c.exit_ip if getattr(c, "exit_ip", None) and c.exit_ip != "-" else None
    return {
        "name": saved_name or f"{p.host}:{p.port}",
        "scheme": p.scheme,
        "host": p.host,
        "port": p.port,
        "exitIp": exit_ip,
    }


def _team_snapshot(c: "AccountConnection") -> list[dict]:
    """Todos os Pokémons na equipe ativa (slot != None, ordenados por slot, mais o ativo se fora de slot)."""
    est = c.estado
    active_id = est.get("activeId")
    members: list[dict] = []
    seen_ids: set[int] = set()
    for p in est.get("pokemons") or []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if p.get("slot") is None and pid != active_id:
            continue
        if isinstance(pid, int):
            seen_ids.add(pid)
        ivs = p.get("ivs") or {}
        members.append({
            "id": pid,
            "speciesId": p.get("speciesId"),
            "name": p.get("nome", "?"),
            "level": p.get("level") or 0,
            "hp": p.get("hp") or 0,
            "maxHp": p.get("maxHp") or 0,
            "looktype": look_of(p),
            "shiny": bool(p.get("shiny")),
            "slot": p.get("slot"),
            "active": pid is not None and pid == active_id,
            "quality": p.get("quality"),
            "potency": p.get("potencia"),
            "grade": p.get("nota"),
            "ivTotal": sum(v for v in ivs.values() if isinstance(v, (int, float))),
        })
    members.sort(key=lambda m: (0 if m["active"] else 1, m["slot"] if m["slot"] is not None else 999))
    return members


def _automation_snapshot(c: "AccountConnection") -> dict:
    from shop import KNOWN_REVIVE_IDS

    auto = c.estado.get("automation") or {}
    items = c.estado.get("items") or {}
    raw_limiar = auto.get("hpLimiar")
    try:
        hp_limiar_pct = round(float(raw_limiar) * 100) if raw_limiar is not None else None
    except (TypeError, ValueError):
        hp_limiar_pct = None
    auto_revive_ids = [i for i in (auto.get("reviveIds") or []) if i in KNOWN_REVIVE_IDS]
    revive_id = c.acc.revive_id if c.acc.revive_id in KNOWN_REVIVE_IDS else (auto_revive_ids[0] if auto_revive_ids else 205)
    return {
        "autoCatch": bool(c.balls.enabled),
        "autoPotion": bool(c.acc.auto_potion),
        "potionThreshold": int(c.acc.potion_restock_threshold),
        "potionQty": int(c.acc.potion_restock_qty),
        "autoBallRestock": bool(c.acc.auto_ball_restock),
        "ballThreshold": int(c.acc.ball_restock_threshold),
        "ballQty": int(c.acc.ball_restock_qty),
        "autoReviveRestock": bool(c.acc.auto_revive_restock),
        "reviveId": int(revive_id),
        "reviveThreshold": int(c.acc.revive_restock_threshold),
        "reviveQty": int(c.acc.revive_restock_qty),
        "reviveStock": {
            "205": int(items.get("205", 0) or 0),
            "206": int(items.get("206", 0) or 0),
        },
        "autoPotionFallback": bool(c.acc.auto_potion_fallback),
        "autoCenter": bool(c.acc.auto_center),
        "autoCenterHpPct": int(c.acc.auto_center_hp_pct),
        "goldReserve": int(c.acc.gold_reserve),
        "huntSlug": c.acc.hunt_slug or "",
        "autoBestHunt": bool(c.acc.auto_best_hunt),
        "autoBestHuntRegion": c.acc.auto_best_hunt_region or "all",
        "autoBestHuntPriority": c.acc.auto_best_hunt_priority or "xp",
        "autoBestHuntSlug": c.acc.auto_best_hunt_slug or "",
        "autoPassClaim": bool(c.acc.auto_pass_claim),
        "autoColecao": _normalize_auto_colecao(auto),
        "collectionCount": len(_collection_ids(c.estado)),
        "gameAutoPotion": bool(auto.get("autoPotion", True)),
        "gameAutoRevive": bool(auto.get("autoRevive", False)),
        "autoVoltarHunt": bool(auto.get("autoVoltarHunt", False)),
        "hpLimiar": raw_limiar,
        "hpLimiarPct": hp_limiar_pct,
        "pvpAuto": bool(c.pvp.auto),
        "autoVendaDepot": auto.get("autoVendaDepot") is True,
        "autoPrey": bool(getattr(c.acc, "auto_prey", False)),
        "bossAuto": bool((c.estado.get("boss") or {}).get("auto")) if isinstance(c.estado.get("boss"), dict) else False,
        "bossAutoKey": (c.estado.get("boss") or {}).get("autoKey") if isinstance(c.estado.get("boss"), dict) else None,
    }


BOOST_META: dict[str, tuple[str, str]] = {
    "xp": ("XP Boost", "/assets/site/assets/loja/exp.png"),
    "pokexp": ("XP Pokémon", "/assets/site/assets/loja/boost.png"),
    "loot": ("Loot Boost", "/assets/site/assets/loja/loot.png"),
    "captura": ("Capture Boost", "/assets/site/assets/loja/catch.png"),
    "shiny": ("Shiny Lure", "/assets/site/assets/loja/shinysecretlure.png"),
    "vip": ("VIP", "/assets/site/assets/loja/vip.png"),
}


def _fmt_mult(m) -> str | None:
    try:
        v = float(m)
    except (TypeError, ValueError):
        return None
    if v <= 1.0001:
        return None
    return f"×{int(v)}" if v == int(v) else f"×{v:.2f}".rstrip("0").rstrip(".")


def _boosts_snapshot(c: "AccountConnection") -> list[dict]:
    """Boosts ativos na conta agora (loja, VIP, guild, Twitch/Kick, evento, Atrasados)."""
    est = c.estado
    now = c.server_now_ms() or int(est.get("servidorAgora") or 0) or int(time.time() * 1000)
    loja = est.get("loja") if isinstance(est.get("loja"), dict) else {}
    tipos = getattr(c, "tipos_boost", {}) or {}
    out: list[dict] = []

    # 1. Boosts da Loja (xp, pokexp, loot, captura, shiny, etc.)
    boosts_map = loja.get("boosts") if isinstance(loja.get("boosts"), dict) else {}
    for key, exp in boosts_map.items():
        if not isinstance(exp, (int, float)) or exp <= now:
            continue
        k = str(key)
        meta_name, meta_icon = BOOST_META.get(k, (k.capitalize(), None))
        tb = tipos.get(k) or {}
        name = tb.get("nome") or tb.get("name") or meta_name
        mult = _fmt_mult(tb.get("mult"))
        out.append({
            "key": k,
            "name": name,
            "detail": mult,
            "expiresAt": int(exp),
            "icon": _abs(meta_icon) if meta_icon else None,
        })

    # 2. VIP
    vip_ate = loja.get("vipAte")
    if isinstance(vip_ate, (int, float)) and vip_ate > now:
        out.append({
            "key": "vip",
            "name": "VIP",
            "detail": "×1.5 XP",
            "expiresAt": int(vip_ate),
            "icon": _abs(BOOST_META["vip"][1]),
        })

    # 3. Boost da Guild & Ranking da Guild
    guild = est.get("guild") if isinstance(est.get("guild"), dict) else {}
    guild_boost = guild.get("boostAte")
    if isinstance(guild_boost, (int, float)) and guild_boost > now:
        out.append({"key": "guild", "name": "Boost Guild", "detail": None, "expiresAt": int(guild_boost), "icon": None})
    guild_pct = est.get("guildBonusPct")
    if isinstance(guild_pct, (int, float)) and guild_pct > 0:
        out.append({"key": "guildRank", "name": "Rank Guild", "detail": f"+{round(guild_pct)}% XP", "expiresAt": None, "icon": None})

    # 4. Twitch / Kick
    for key, label in (("twitch", "Twitch"), ("kick", "Kick")):
        live = est.get(key) if isinstance(est.get(key), dict) else None
        bonus = live.get("bonus") if isinstance(live, dict) and isinstance(live.get("bonus"), dict) else None
        exp = bonus.get("xp") if bonus else None
        if isinstance(exp, (int, float)) and exp > now:
            pct = live.get("pct")
            detail = f"+{round(pct)}% XP" if isinstance(pct, (int, float)) and pct > 0 else None
            out.append({"key": key, "name": label, "detail": detail, "expiresAt": int(exp), "icon": None})

    # 5. Evento do servidor
    ev = est.get("evento") if isinstance(est.get("evento"), dict) else None
    if ev and isinstance(ev.get("terminaEm"), (int, float)) and ev["terminaEm"] > now:
        tr = int(ev.get("xpTreinadorPct") or 0)
        pk = int(ev.get("xpPokemonPct") or 0)
        pct = max(tr, pk)
        out.append({
            "key": "evento",
            "name": "Evento",
            "detail": f"+{pct}% XP" if pct > 0 else None,
            "expiresAt": int(ev["terminaEm"]),
            "icon": None,
        })

    # 6. Boost dos Atrasados
    at = loja.get("atrasados") if isinstance(loja.get("atrasados"), dict) else None
    lvl = int(est.get("level") or 0)
    if at and isinstance(at.get("mult"), (int, float)) and at["mult"] > 1 and lvl < int(at.get("alvo") or 0):
        mult = _fmt_mult(at["mult"])
        out.append({
            "key": "atrasados",
            "name": "Atrasados",
            "detail": f"{mult} (até Nv.{int(at['alvo'])})" if mult else f"até Nv.{int(at['alvo'])}",
            "expiresAt": None,
            "icon": None,
        })

    return out


def account_snapshot(c: "AccountConnection", proxy_names: dict[tuple, str] | None = None) -> dict:
    from inventory import POTION_NAMES  # evita ciclo em import-time

    est = c.estado
    pk = c.hunt.active_pokemon()
    s = c.hunt.session
    inv = c.inventory
    summary = inv.pokemon_summary()
    slug = s.slug if s else est.get("huntSlug")
    outland = hunt_is_outland(c.hunts, slug)
    return {
        "id": f"acc{c.acc.index}",
        "nick": c.acc.nick,
        "level": est.get("level") or 0,
        "status": _STATUS.get(c.state, "offline"),
        "state": c.state.value,  # estado detalhado, p/ debug
        "paused": bool(getattr(c, "manual_paused", False) or c.state == State.PAUSED_MANUAL),
        "farmPaused": bool(getattr(c, "farm_paused", False)),
        "farmPausePending": bool(getattr(c, "_farm_pause_pending_center", False)),
        "location": c.current_location(),
        "escapeRopes": int((est.get("items") or {}).get("70010", 0) or 0),
        "proxy": _proxy_snapshot(c, proxy_names),
        "blocked": c.block,      # {kind, detail} quando o jogo recusou a conta
        "lastReason": c.last_reason,
        "pokemon": {
            "id": pk.get("id"),
            "speciesId": pk.get("speciesId"),
            "name": pk.get("nome", "?"),
            "hp": pk.get("hp", 0),
            "maxHp": pk.get("maxHp", 0),
            "level": pk.get("level"),
            "xp": {"atual": pk.get("xp"), "nivel": pk.get("xpNivel"), "proximo": pk.get("xpProximo")},
            "looktype": look_of(pk),
            "shiny": bool(pk.get("shiny")),
        } if pk else None,
        "team": _team_snapshot(c),
        "automation": _automation_snapshot(c),
        "xpPerHour": round(s.xp_por_hora) if s else 0,
        "goldPerHour": round(s.gold_por_hora) if s else 0,
        "xp": {"atual": est.get("xp"), "nivel": est.get("xpNivel"), "proximo": est.get("xpProximo")},
        "hunt": {"slug": s.slug, "kills": s.kills, "minutes": round(s.elapsed_h * 60, 1)} if s else None,
        "vip": (est.get("loja") or {}).get("vipAte", 0) > (est.get("servidorAgora") or 0),
        "boosts": _boosts_snapshot(c),
        "huntName": s.nome if s else None,
        "map": _map_info(c, slug),
        "pass": passe_publico(est.get("passe")),
        # Em combate a conta não troca de hunt: tempo restante e a hunt que está na fila (se houver).
        "combatLockMs": c.combat_lock_ms(),
        "huntPending": _pending_hunt(c),
        "session": {
            "startedAt": int(c.session_started * 1000) if c.session_started else None,
            "items": dict(c.session_items.gained),
            "shinies": {"seen": c.shinies.seen, "captured": c.shinies.captured},
            "outland": outland,   # o painel mostra shinies fora de Outland e itens raros em Outland
        },
        "equipped": equipped_rows(c),
        "gold": est.get("gold") or 0,
        "gems": est.get("orbs") or 0,
        "diamonds": est.get("diamonds") or 0,
        "potions": _count(est.get("items"), set(POTION_NAMES)),
        "balls": _count(est.get("balls")),
        "captured": {
            "session": c.balls.caught,
            "failed": c.balls.failed,
            "total": summary["total"],
            "shiny": summary["shiny"],
        },
        "inventory": {
            "balls": ball_rows(c),
            "items": item_rows(c),
            "pokedexSpecies": inv.pokedex_species_count(),
        },
    }


def _proxy_name_map(store) -> dict[tuple, str]:
    if store is None or not hasattr(store, "list_proxies"):
        return {}
    out: dict[tuple, str] = {}
    for row in store.list_proxies():
        if row.get("name"):
            key = (str(row.get("scheme") or "socks5").lower(), str(row["host"]).strip().lower(),
                   int(row.get("port") or 0), str(row.get("username") or ""))
            out[key] = row["name"]
    return out


def build_snapshot(conns: "list[AccountConnection]", store=None) -> dict:
    pnames = _proxy_name_map(store) if store is not None else None
    return {
        "type": "snapshot",
        "ts": int(time.time() * 1000),
        "accounts": [account_snapshot(c, pnames) for c in conns],
    }


_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://pokeidle.io; "
        "connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
_SECURITY_HEADERS = {
    "Content-Security-Policy": _CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
}  # nosniff, Referrer-Policy, HSTS e X-Frame-Options já vêm do Caddy (não duplicar)


# O worker da "Melhor hunt" roda o motor de um site de terceiros (PokéIdle Hub). Esta CSP, entregue com o próprio
# arquivo do worker, só deixa esse código falar com o Hub e o isola em sandbox: ele não alcança a nossa API.
HUNT_HUB = "https://pokeidleguide.io"
_HUNT_HUBS = "https://pokeidleguide.io https://pokeidle-gg.pages.dev"
_WORKER_CSP = f"default-src 'none'; script-src {_HUNT_HUBS}; connect-src {_HUNT_HUBS}; sandbox allow-scripts"
_WORKER_PATH = "/hunt-worker.js"


def _origin_matches_host(headers, cors_origins: list[str] | None = None) -> bool:
    """Confere se o cabeçalho Origin (quando enviado pelo navegador) pertence ao próprio host ou às origens CORS."""
    origin = headers.get("origin")
    if not origin:
        return True  # clientes que não são navegador (scripts com token) não enviam Origin
    if cors_origins and ("*" in cors_origins or origin in cors_origins):
        return True
    from urllib.parse import urlparse
    host = (headers.get("x-forwarded-host") or headers.get("host", "")).split(",")[0].strip()
    return urlparse(origin).netloc == host


def _ws_origin_ok(ws: WebSocket) -> bool:
    """Bloqueia WebSocket iniciado por outro site (CSWSH): a origem precisa ser o próprio host."""
    return _origin_matches_host(ws.headers)


def create_app(
    conns: "list[AccountConnection] | Callable[[], list[AccountConnection]]",
    auth,
    interval: float = 1.0,
    cors_origins: list[str] | None = None,
    manager=None,
    store=None,
    updater=None,
) -> FastAPI:
    """`conns` pode ser uma lista fixa ou uma função (contas mudam em tempo de execução).
    `auth` (auth.Auth) protege tudo. Com `manager` e `store`, registra as rotas de gestão (admin_api.py)."""
    get_conns = conns if callable(conns) else (lambda: conns)
    app = FastAPI(title="Pokeidle Manager Telemetry", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not _origin_matches_host(request.headers, cors_origins):
            return JSONResponse({"error": "Origem não autorizada (CSRF)."}, status_code=403)
        resp = await call_next(request)
        for k, v in _SECURITY_HEADERS.items():
            resp.headers.setdefault(k, v)
        if request.url.path == _WORKER_PATH:
            resp.headers["Content-Security-Policy"] = _WORKER_CSP
        if request.url.path.startswith("/api/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp
    if cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=cors_origins,
                           allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
                           allow_headers=["Authorization", "Content-Type"])

    from auth import register_auth_routes

    register_auth_routes(app, auth)

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.get("/api/telemetry")
    async def telemetry(request: Request, tok: str | None = Query(None, alias="token")):
        if (denied := auth.read_guard(request, tok)):
            return denied
        return build_snapshot(get_conns(), store=store)

    atlas_cache: dict = {}

    @app.get("/api/sprite-atlas")
    async def sprite_atlas():
        """Proxy (com cache de 1h) do índice de retratos do jogo: o site não envia CORS."""
        import aiohttp

        if atlas_cache.get("exp", 0) < time.time():
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
                    async with s.get(f"{SITE}/assets/site/assets/maps/marker-atlas.json") as r:
                        j = json.loads(await r.text())
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                if "data" not in atlas_cache:
                    return JSONResponse({"error": "atlas indisponível"}, status_code=502)
                atlas_cache["exp"] = time.time() + 60   # mantém o último bom e tenta de novo logo
            else:
                atlas_cache.update(exp=time.time() + ATLAS_TTL_S, data=atlas_payload(j))
        return JSONResponse(atlas_cache["data"], headers={"Cache-Control": f"max-age={ATLAS_TTL_S}"})

    @app.get("/api/pokemons")
    async def pokemons(request: Request, tok: str | None = Query(None, alias="token"),
                       account: str | None = None):
        if (denied := auth.read_guard(request, tok)):
            return denied
        rows: list[dict] = []
        for c in get_conns():
            if account in (None, "", f"acc{c.acc.index}"):
                rows.extend(pokemon_rows(c))
        return {"ts": int(time.time() * 1000), "pokemons": rows}

    @app.post("/api/sell-depot")
    async def sell_depot(request: Request, tok: str | None = Query(None, alias="token"),
                          account: str | None = None):
        """Vende o Depot (shop.sellAllPokemons, spec do protocolo §17) de uma conta
        ou de todas. AÇÃO IRREVERSÍVEL no jogo — a confirmação ao usuário é feita
        no dashboard antes desta chamada; aqui só se executa o comando."""
        if (denied := auth.guard(request, tok)):  # ação: exige login mesmo sem senha exigida nas leituras
            return denied
        targets = [c for c in get_conns() if account in (None, "", f"acc{c.acc.index}")]
        if not targets:
            return JSONResponse({"error": "conta não encontrada"}, status_code=404)

        async def _sell_one(c: "AccountConnection") -> dict:
            acc_id = f"acc{c.acc.index}"
            try:
                r = await c.shop.sell_all_pokemons()
                return {"account": acc_id, "nick": c.acc.nick, "ok": True, **r}
            except RuntimeError as e:
                return {"account": acc_id, "nick": c.acc.nick, "ok": False, "error": str(e)}

        results = await asyncio.gather(*(_sell_one(c) for c in targets))
        return {"results": results}

    @app.websocket("/ws/telemetry")
    async def ws_telemetry(ws: WebSocket, tok: str | None = Query(None, alias="token")):
        if not _ws_origin_ok(ws) or (auth.required() and not auth.check_ws(ws)):
            await ws.close(code=4401)  # antes do accept => HTTP 403 no handshake
            return
        await ws.accept()
        try:
            while True:
                await ws.send_json(build_snapshot(get_conns(), store=store))
                await asyncio.sleep(interval)
        except (WebSocketDisconnect, RuntimeError):
            pass

    if manager is not None and store is not None:
        from admin_api import register_admin_routes
        register_admin_routes(app, manager, store, auth)
        from market_api import register_market_routes
        register_market_routes(app, manager, store, auth)
        from actions_api import register_action_routes
        register_action_routes(app, manager, store, auth)
        from features_api import register_feature_routes
        register_feature_routes(app, manager, store, auth)
        from chat_api import register_chat_routes
        register_chat_routes(app, manager, auth)
        from pvp_api import register_pvp_routes
        register_pvp_routes(app, manager, store, auth)
        from pvp_team_api import register_pvp_team_routes
        register_pvp_team_routes(app, manager, auth)
        from pokemon_sheet_api import register_pokemon_sheet_routes
        register_pokemon_sheet_routes(app, manager, auth)
        from sprite_outfit import register_sprite_routes
        register_sprite_routes(app, auth)
    if updater is not None:
        from updater import register_update_routes
        register_update_routes(app, updater, auth)

    # Dashboard estático (build do Vite) na raiz; rotas /api e /ws acima têm prioridade.
    web_dir = os.getenv("WEB_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_dist")
    if os.path.isdir(web_dir):
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")

    return app
