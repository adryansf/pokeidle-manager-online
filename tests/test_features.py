"""Recursos extras (features.py / features_api.py): auto-venda, avisos, juntar coins, anúncios, prey, boss e
oferenda/sacrifício. O "socket" falso grava os frames enviados e responde como o jogo responderia."""
import asyncio
import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

import features
from auth import Auth
from config import build_account_config
from connection import AccountConnection, State
from hunt import HuntSession
from manager import AccountManager
from notify import DailyStats, Notifier
from telemetry import _automation_snapshot, create_app

KEY = "chave-de-teste"
H = {"Authorization": f"Bearer {KEY}"}
TOKEN = "tok_" + "z" * 30
NOW_MS = 1_795_000_000_000          # 2026-11-18 ~12:26 UTC (antes das 18:00 de Brasília)


class FakeWS:
    """Grava o que é enviado; `responder(frame)` devolve frames que o "jogo" manda de volta."""

    def __init__(self, conn_ref):
        self.sent = []
        self.responder = None
        self._conn = conn_ref

    async def send(self, raw):
        frame = json.loads(raw)
        self.sent.append(frame)
        if self.responder:
            loop = asyncio.get_running_loop()
            for reply in self.responder(frame) or []:
                loop.call_soon(self._dispatch, reply)

    def _dispatch(self, msg):
        conn = self._conn()
        conn.hunt.handle_frame(msg)
        conn.features.handle_frame(msg)


def batalha(*evs):
    return {"t": "batalha", "ev": list(evs)}


def _online(conn, gold=500_000, nick_level=50):
    conn.state = State.ONLINE
    ws = FakeWS(lambda: conn)
    conn.hunt._ws = ws
    conn.market._ws = ws
    conn.market.clock_offset_ms = 0
    conn.estado.update({
        "level": nick_level, "gold": gold, "huntSlug": "shellder", "servidorAgora": NOW_MS,
        "items": {"200": 9, "70001": 3}, "activeId": 1,
        "automation": {"autoPotion": True, "pokemonTravado": [3]},
        "pokemons": [
            {"id": 1, "nome": "Charizard", "speciesId": 6, "slot": 0, "level": 100},
            {"id": 2, "nome": "Rattata", "speciesId": 19, "slot": None, "level": 20, "nota": 3.6},
            {"id": 3, "nome": "Pidgey", "speciesId": 16, "slot": None, "level": 20},
            {"id": 4, "nome": "Gyarados", "speciesId": 130, "slot": None, "level": 80, "shiny": True},
            {"id": 5, "nome": "Zubat", "speciesId": 41, "slot": None, "level": 15},
            {"id": 6, "nome": "Mewtwo", "speciesId": 150, "slot": None, "level": 70},
        ],
    })
    conn.server_now_ms = lambda: NOW_MS
    return ws


@pytest.fixture
def env(store, tmp_path, monkeypatch):
    monkeypatch.setattr(features, "BANK_COOLDOWN_S", 0.0)
    mgr = AccountManager(store, Notifier(""), DailyStats(path=str(tmp_path / "d.json")))

    def fake_spawn(self, row):
        conn = AccountConnection(build_account_config(row), self.settings(), self.notifier, self.daily)
        self._conns[conn.acc.index] = conn

    monkeypatch.setattr(AccountManager, "_spawn", fake_spawn)
    a1 = mgr.add({"nick": "Ash", "token": TOKEN, "device_id": "dev-12345678"})
    a2 = mgr.add({"nick": "Misty", "token": TOKEN + "b", "device_id": "dev-87654321"})
    c1, c2 = mgr.get(a1), mgr.get(a2)
    ws1, ws2 = _online(c1, gold=500_000), _online(c2, gold=12_000)
    c1.hunts.extend([
        {"slug": "shellder", "nome": "Shellder", "area": "kanto", "nivel": 30, "especies": [{"pokeId": 90, "nome": "Shellder"}]},
        {"slug": "onix", "nome": "Onix", "area": "kanto", "nivel": 40, "especies": [{"pokeId": 95, "nome": "Onix"}]},
        {"slug": "dragonite", "nome": "Dragonite", "area": "kanto", "nivel": 900, "especies": [{"pokeId": 149, "nome": "Dragonite"}]},
    ])
    c1.hunt.session = HuntSession(slug="shellder")
    sent_notes = []
    for c in (c1, c2):
        c.notifier.send = lambda title, desc="", color=0, fields=None, *a, **k: sent_notes.append((title, desc, fields))
    app = create_app(mgr.connections, Auth(store, exposed=False, env_token=KEY), manager=mgr, store=store)
    return {"c": TestClient(app), "mgr": mgr, "c1": c1, "c2": c2, "ws1": ws1, "ws2": ws2, "a1": a1, "a2": a2,
            "store": store, "notes": sent_notes}


# ---------------------------------------------------------------- 1) Auto-venda do Depot
def test_auto_venda_depot_sends_frame_and_reflects_state(env):
    c, conn, ws, a1 = env["c"], env["c1"], env["ws1"], env["a1"]
    assert c.post(f"/api/accounts/{a1}/features/auto-venda", json={"ativo": True}).status_code == 401
    r = c.post(f"/api/accounts/{a1}/features/auto-venda", json={"ativo": True}, headers=H).json()
    assert r == {"ok": True, "autoVendaDepot": True}
    assert ws.sent == [{"t": "shop.autoVendaDepot", "ativo": True}]
    assert _automation_snapshot(conn)["autoVendaDepot"] is True
    # O jogo também pode desligar (outro cliente): o evento atualiza o estado.
    conn.features.handle_frame(batalha({"k": "autoVendaDepot", "ativo": False}))
    assert _automation_snapshot(conn)["autoVendaDepot"] is False
    assert c.get(f"/api/accounts/{a1}/features", headers=H).json()["autoVendaDepot"] is False


def test_auto_venda_offline_is_refused(env):
    c, conn, a1 = env["c"], env["c1"], env["a1"]
    conn.state = State.DISCONNECTED
    assert c.post(f"/api/accounts/{a1}/features/auto-venda", json={"ativo": True}, headers=H).status_code == 409


# ---------------------------------------------------------------- 2) Avisos
def test_notifications_for_market_egg_and_boss(env):
    conn, notes = env["c1"], env["notes"]
    conn.features.handle_frame(batalha(
        {"k": "marketVendido", "descricao": "10× Fire Stone", "valor": 5000, "moeda": "gold"},
        {"k": "marketExpirou", "descricao": "Rattata Nv 20"},
        {"k": "ovoChocou", "pokemon": {"nome": "Togepi", "shiny": True}},
        {"k": "bossMorto", "nome": "Entei", "key": "entei", "drops": [{"nome": "Boss Token", "qtd": 2}]},
        {"k": "hunt", "slug": "x"},   # evento sem aviso
    ))
    assert len(notes) == 4
    assert "5,000 coins" in notes[0][1] and "Fire Stone" in notes[0][1]
    assert "vencido" in notes[1][1]
    assert "Togepi" in notes[2][1] and "shiny" in notes[2][1]
    assert "Entei" in notes[3][1] and notes[3][2] == [("Drops", "Boss Token×2", False)]
    kinds = [e["kind"] for e in conn.features.feed]
    assert kinds == ["bossMorto", "ovoChocou", "marketExpirou", "marketVendido"]


# ---------------------------------------------------------------- 3) Juntar coins
def _bank_responder(dest_level=50, refuse=None):
    def resp(f):
        if f["t"] == "banco.consultar":
            if refuse:
                return [batalha({"k": "bancoDestino", "pedido": f["nick"], "erro": refuse})]
            return [batalha({"k": "bancoDestino", "pedido": f["nick"], "nick": f["nick"], "level": dest_level})]
        if f["t"] == "banco.coins":
            return [batalha({"k": "amigoCoinsEnviou", "nick": f["nick"], "valor": f["valor"],
                             "liquido": f["valor"] - features.bank_fee(f["valor"])})]
        return []
    return resp


def test_consolidate_preview_respects_reserve_min_and_target(env):
    c, a1, a2 = env["c"], env["a1"], env["a2"]
    body = {"target": "Brock", "accounts": [a1, a2], "reserve": 11_500}
    r = c.post("/api/coins/consolidate/preview", json=body, headers=H).json()
    p1, p2 = r["plan"]
    assert p1["status"] == "ok" and p1["amount"] == 488_500 and p1["fee"] == 73_275 and p1["net"] == 415_225
    assert p2["status"] == "skip" and "mínimo" in p2["detail"]      # 12.000 - 11.500 = 500 < 1.000
    assert r["total"] == {"accounts": 1, "amount": 488_500, "fee": 73_275, "net": 415_225}
    # A própria conta de destino nunca envia para si mesma.
    r = c.post("/api/coins/consolidate/preview", json={**body, "target": "ash"}, headers=H).json()
    assert r["plan"][0]["status"] == "skip" and "destino" in r["plan"][0]["detail"]
    assert c.post("/api/coins/consolidate/preview", json={**body, "target": "a b"}, headers=H).status_code == 400
    assert env["ws1"].sent == [] and env["ws2"].sent == []


def test_consolidate_requires_confirm_and_sends_per_account(env):
    c, a1, a2, ws1, ws2 = env["c"], env["a1"], env["a2"], env["ws1"], env["ws2"]
    body = {"target": "Brock", "accounts": [a1, a2], "reserve": 2_000}
    r = c.post("/api/coins/consolidate", json=body, headers=H)
    assert r.status_code == 400 and ws1.sent == []
    ws1.responder = ws2.responder = _bank_responder()
    r = c.post("/api/coins/consolidate", json={**body, "confirm": True}, headers=H).json()
    assert ws1.sent == [{"t": "banco.consultar", "nick": "Brock"}, {"t": "banco.coins", "nick": "Brock", "valor": 498_000}]
    assert ws2.sent == [{"t": "banco.consultar", "nick": "Brock"}, {"t": "banco.coins", "nick": "Brock", "valor": 10_000}]
    assert [x["status"] for x in r["results"]] == ["enviado", "enviado"]
    assert r["total"]["amount"] == 508_000 and r["total"]["fee"] == 74_700 + 1_500


def test_consolidate_stops_when_destination_is_refused(env):
    c, a1, ws1 = env["c"], env["a1"], env["ws1"]
    ws1.responder = _bank_responder(refuse="banco.nickNaoEncontrado")
    r = c.post("/api/coins/consolidate", json={"target": "Ninguem", "accounts": [a1], "confirm": True}, headers=H).json()
    assert ws1.sent == [{"t": "banco.consultar", "nick": "Ninguem"}]          # banco.coins nunca saiu
    assert r["results"][0]["status"] == "recusado" and "nickNaoEncontrado" in r["results"][0]["detail"]


def test_consolidate_refuses_low_level_destination(env):
    c, a1, ws1 = env["c"], env["a1"], env["ws1"]
    ws1.responder = _bank_responder(dest_level=5)
    r = c.post("/api/coins/consolidate", json={"target": "Novato", "accounts": [a1], "confirm": True}, headers=H).json()
    assert [f["t"] for f in ws1.sent] == ["banco.consultar"]
    assert r["results"][0]["status"] == "recusado"


# ---------------------------------------------------------------- 4) Mercado
def test_create_item_listing(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    body = {"tipo": "item", "itemId": 70001, "qtd": 2, "preco": 900, "moeda": "gold"}
    assert c.post(f"/api/accounts/{a1}/market/listings", json=body, headers=H).status_code == 400   # sem confirm
    r = c.post(f"/api/accounts/{a1}/market/listings", json={**body, "qtd": 4, "confirm": True}, headers=H)
    assert r.status_code == 400 and "3 livre" in r.json()["error"]
    assert c.post(f"/api/accounts/{a1}/market/listings", json={**body, "preco": 1, "confirm": True}, headers=H).status_code == 400
    ws.responder = lambda f: [batalha({"k": "marketCriado", "descricao": "2× Item"})] if f["t"] == "market.criar" else []
    r = c.post(f"/api/accounts/{a1}/market/listings", json={**body, "confirm": True}, headers=H).json()
    assert r["ok"] is True and r["confirmed"] is True
    assert ws.sent == [{"t": "market.criar", "tipo": "item", "itemId": 70001, "pokemonId": None, "casaId": None,
                        "bicicletaId": None, "qtd": 2, "preco": 900, "moeda": "gold", "dias": None}]


def test_create_pokemon_listing_checks_team_collection_and_days(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    base = {"tipo": "pokemon", "preco": 50_000, "moeda": "gold", "dias": 3, "confirm": True}
    assert c.post(f"/api/accounts/{a1}/market/listings", json={**base, "pokemonId": 1}, headers=H).status_code == 400  # ativo
    assert c.post(f"/api/accounts/{a1}/market/listings", json={**base, "pokemonId": 3}, headers=H).status_code == 400  # coleção
    assert c.post(f"/api/accounts/{a1}/market/listings", json={**base, "pokemonId": 2, "dias": 99}, headers=H).status_code == 400
    ws.responder = lambda f: [batalha({"k": "marketCriado", "descricao": "Rattata"})] if f["t"] == "market.criar" else []
    r = c.post(f"/api/accounts/{a1}/market/listings", json={**base, "pokemonId": 2}, headers=H).json()
    assert r["confirmed"] is True
    assert ws.sent[-1]["pokemonId"] == 2 and ws.sent[-1]["dias"] == 3 and ws.sent[-1]["qtd"] == 1


def test_cancel_and_edit_listing(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    assert c.post(f"/api/accounts/{a1}/market/listings/77/cancel", json={}, headers=H).status_code == 400

    def resp(f):
        if f["t"] == "market.cancelar":
            return [batalha({"k": "marketCancelado"})]
        if f["t"] == "market.estender":
            return [batalha({"k": "marketEstendido", "id": f["id"], "expiraEm": 123})]
        return []
    ws.responder = resp
    r = c.post(f"/api/accounts/{a1}/market/listings/77/cancel", json={"confirm": True}, headers=H).json()
    assert r["confirmed"] is True and ws.sent[-1] == {"t": "market.cancelar", "id": 77}
    r = c.patch(f"/api/accounts/{a1}/market/listings/78", json={"preco": 999, "moeda": "orb", "dias": 2, "confirm": True},
                headers=H).json()
    assert r["ok"] is True and r["extended"]["confirmed"] is True
    assert ws.sent[-2:] == [{"t": "market.estender", "id": 78, "dias": 2},
                            {"t": "market.editar", "id": 78, "preco": 999, "moeda": "orb"}]


# ---------------------------------------------------------------- 5) Prey
def test_prey_day_flips_at_18h_brasilia():
    # 20:59 UTC = 17:59 de Brasília -> ainda o dia anterior; 21:00 UTC -> vira.
    from datetime import datetime, timezone
    ms = lambda h, m: int(datetime(2026, 11, 18, h, m, tzinfo=timezone.utc).timestamp() * 1000)
    assert features.dia_do_prey(ms(20, 59)) == "2026-11-18"
    assert features.dia_do_prey(ms(21, 0)) == "2026-11-19"


def test_auto_prey_rolls_free_and_picks_hunt_species(env):
    c, conn, a1, ws, store = env["c"], env["c1"], env["a1"], env["ws1"], env["store"]
    dia = features.dia_do_prey(NOW_MS)
    r = c.post(f"/api/accounts/{a1}/features/auto-prey", json={"ativo": True}, headers=H).json()
    assert r == {"ok": True, "autoPrey": True}
    assert conn.acc.auto_prey is True
    assert build_account_config(store.get_account(a1)).auto_prey is True

    ws.responder = lambda f: ([batalha({"k": "preyRoletou", "cartela": 0, "categoria": "tudo",
                                        "c": {"lista": [149, 95, 90], "bonus": "captura", "est": 4, "n": [0, 0, 0]}})]
                              if f["t"] == "prey.roletar" else [])

    async def go():
        await conn.features.check_auto_prey()
        await asyncio.sleep(0)
        conn.features._last_prey_tick = 0.0
        await conn.features.check_auto_prey()
    asyncio.run(go())
    assert ws.sent == [{"t": "prey.roletar", "cartela": 0, "categoria": "tudo", "dia": dia, "n": 0},
                       {"t": "prey.escolher", "cartela": 0, "dia": dia, "pk": 90}]   # Shellder = hunt atual
    assert not any(f.get("categoria") in ("pokemon", "bonus", "estrelas") for f in ws.sent)   # nunca roletada paga


def test_auto_prey_off_by_default_and_skips_unknown_species(env):
    conn, ws = env["c1"], env["ws1"]
    assert conn.acc.auto_prey is False
    asyncio.run(conn.features.check_auto_prey())
    assert ws.sent == []
    dia = features.dia_do_prey(NOW_MS)
    conn.acc = replace(conn.acc, auto_prey=True)
    conn.estado["automation"]["prey"] = {"dia": dia, "cartelas": [{"lista": [149], "bonus": "dano", "est": 1, "n": [0, 0, 0]}]}
    asyncio.run(conn.features.check_auto_prey())
    assert ws.sent == []                                             # Dragonite: hunt acima do nível -> escolha manual
    assert "escolha manual" in conn.features.feed[0]["text"]


def test_prey_manual_endpoints(env):
    c, conn, a1, ws = env["c"], env["c1"], env["a1"], env["ws1"]
    dia = features.dia_do_prey(NOW_MS)
    assert c.post(f"/api/accounts/{a1}/prey/roll", json={"cartela": 1}, headers=H).status_code == 400   # bloqueada
    ws.responder = lambda f: ([batalha({"k": "preyRoletou", "cartela": 0, "categoria": "tudo",
                                        "c": {"lista": [95, 90], "bonus": "dano", "est": 2, "n": [0, 0, 0]}})]
                              if f["t"] == "prey.roletar" else
                              [batalha({"k": "preyEscolheu", "cartela": 0,
                                        "c": {"lista": [95, 90], "pk": f.get("pk"), "bonus": "dano", "est": 2, "n": [0, 0, 0]}})])
    r = c.post(f"/api/accounts/{a1}/prey/roll", json={"cartela": 0}, headers=H).json()
    assert r["confirmed"] is True
    assert c.post(f"/api/accounts/{a1}/prey/roll", json={"cartela": 0}, headers=H).status_code == 400  # já roletou hoje
    assert c.post(f"/api/accounts/{a1}/prey/choose", json={"cartela": 0, "pk": 149}, headers=H).status_code == 400
    r = c.post(f"/api/accounts/{a1}/prey/choose", json={"cartela": 0, "pk": 95}, headers=H).json()
    assert r["confirmed"] is True and ws.sent[-1] == {"t": "prey.escolher", "cartela": 0, "dia": dia, "pk": 95}
    view = c.get(f"/api/accounts/{a1}/features", headers=H).json()["prey"]
    assert view["cartelas"][0]["pk"] == 95 and view["cartelas"][0]["pkNome"] == "Onix"


# ---------------------------------------------------------------- 6) Boss
def test_boss_auto_toggle(env):
    c, conn, a1, ws = env["c"], env["c1"], env["a1"], env["ws1"]
    conn.bosses_jogaveis = [{"key": "entei", "name": "Entei", "level": 100, "minNivelTreinador": 40,
                             "entrada": {"itemId": 70001, "qtd": 1, "nome": "Boss Token"}}]
    assert c.post(f"/api/accounts/{a1}/boss/auto", json={"ativo": True, "key": "raikou"}, headers=H).status_code == 400
    r = c.post(f"/api/accounts/{a1}/boss/auto", json={"ativo": True, "key": "entei"}, headers=H).json()
    assert r == {"ok": True, "auto": True, "key": "entei"}
    assert ws.sent == [{"t": "boss.auto", "ativo": True, "key": "entei"}]
    snap = _automation_snapshot(conn)
    assert snap["bossAuto"] is True and snap["bossAutoKey"] == "entei"
    view = c.get(f"/api/accounts/{a1}/features", headers=H).json()["boss"]
    assert view["bosses"][0]["entries"] == 3 and view["bosses"][0]["levelOk"] is True
    conn.features.handle_frame(batalha({"k": "bossAuto", "ativo": False}))
    assert _automation_snapshot(conn)["bossAuto"] is False
    assert c.post(f"/api/accounts/{a1}/boss/enter", json={"key": "entei"}, headers=H).json() == {"ok": True}
    assert ws.sent[-1] == {"t": "boss.entrar", "key": "entei"}


# ---------------------------------------------------------------- 7) Oferenda / Sacrifício
def _prot_responder(prot, ok_kind):
    def resp(f):
        if f["t"] == "oferenda.protegidos":
            return [{"t": "oferenda", "protegidos": prot}]
        if f["t"] in ("oferenda.girar", "sacrificio.sacrificar"):
            return [batalha({"k": ok_kind, "pokemonIds": f["pokemonIds"]})]
        return []
    return resp


def test_oferenda_blocks_shiny_collection_team_legendary_and_protected(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    ws.responder = _prot_responder([5], "oferenda")
    assert c.post(f"/api/accounts/{a1}/oferenda", json={"pokemonIds": [2]}, headers=H).status_code == 400  # sem confirm
    assert ws.sent == []
    r = c.post(f"/api/accounts/{a1}/oferenda", json={"pokemonIds": [1, 2, 3, 4, 5], "confirm": True}, headers=H)
    assert r.status_code == 400
    reasons = {b["id"]: b["reason"] for b in r.json()["blocked"]}
    assert reasons == {1: "ativo", 3: "coleção/travado", 4: "shiny", 5: "protegido pelo jogo"}
    assert [f["t"] for f in ws.sent] == ["oferenda.protegidos"]          # nada destruído
    r = c.post(f"/api/accounts/{a1}/sacrificio", json={"pokemonIds": [6], "confirm": True}, headers=H)
    assert r.status_code == 400 and r.json()["blocked"][0]["reason"] == "lendário/mítico"


def test_oferenda_and_sacrificio_send_only_allowed_ids(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    ws.responder = _prot_responder([], "oferenda")
    r = c.post(f"/api/accounts/{a1}/oferenda", json={"pokemonIds": [2], "confirm": True}, headers=H).json()
    assert r["confirmed"] is True and r["sent"] == [2]
    assert ws.sent[-1] == {"t": "oferenda.girar", "pokemonIds": [2]}
    ws.responder = _prot_responder([], "sacrificio")
    r = c.post(f"/api/accounts/{a1}/sacrificio", json={"pokemonIds": [2], "confirm": True}, headers=H).json()
    assert r["confirmed"] is True and ws.sent[-1] == {"t": "sacrificio.sacrificar", "pokemonIds": [2]}
    cand = c.get(f"/api/accounts/{a1}/destroy/candidates", headers=H).json()["pokemons"]
    allowed = {p["id"] for p in cand if p["allowed"]}
    assert allowed == {2, 5}


def test_oferenda_limit_of_five(env):
    c, a1, ws = env["c"], env["a1"], env["ws1"]
    ws.responder = _prot_responder([], "oferenda")
    r = c.post(f"/api/accounts/{a1}/oferenda", json={"pokemonIds": [2, 5, 7, 8, 9, 10], "confirm": True}, headers=H)
    assert r.status_code == 400 and "5" in r.json()["error"]
    assert ws.sent == []
