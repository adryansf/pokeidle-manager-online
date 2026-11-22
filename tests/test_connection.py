import asyncio
import json

import pytest

import connection
from config import AccountConfig, Settings
from connection import AccountBlocked, AccountConnection, NetworkFull

ACC = AccountConfig(index=1, nick="Ash", token="tok_" + "a" * 20, device_id="dev-12345678", proxy=None)
SET = Settings("wss://x.example", frozenset({4001}), [])


class FakeWS:
    def __init__(self, frames):
        self._frames = frames

    def __aiter__(self):
        async def gen():
            for f in self._frames:
                yield json.dumps(f)
        return gen()


@pytest.fixture
def conn():
    return AccountConnection(ACC, SET)


@pytest.mark.parametrize("chave,kind", [
    ("auth.sessaoInvalida", "invalid"), ("auth.precisaLogin", "invalid"),
    ("auth.contaBanida", "banned"), ("auth.ipBanido", "net_banned"),
    ("auth.provedorBanido", "net_banned"), ("auth.contaExcluida", "deleted"),
    ("login.precisaNick", "needs_nick"),
])
def test_blocking_error_frames(conn, chave, kind):
    with pytest.raises(AccountBlocked) as e:
        conn._check_erro({"t": "erro", "chave": chave})
    assert e.value.kind == kind


def test_ban_reason_is_included(conn):
    with pytest.raises(AccountBlocked) as e:
        conn._check_erro({"t": "erro", "chave": "auth.contaBanida", "motivoBan": "uso de bug"})
    assert "uso de bug" in e.value.detail


def test_network_full_and_ignored_frames(conn):
    with pytest.raises(NetworkFull):
        conn._check_erro({"t": "erro", "chave": "login.limiteOnlineIp"})
    conn._check_erro({"t": "erro", "chave": "chat.espera"})  # erro de chat não bloqueia
    conn._check_erro({"t": "welcome"})
    conn._check_erro({})


def test_token_renewal_is_saved_and_used_in_next_hello(conn):
    seen = []
    conn.on_token_renewed = lambda i, t: seen.append((i, t))
    new = "novo_" + "b" * 20
    asyncio.run(conn._recv_loop(FakeWS([{"t": "sessao.renovada", "token": new}])))
    assert conn.acc.token == new and seen == [(1, new)]
    assert json.loads(conn._hello())["token"] == new


def test_error_frame_after_welcome_blocks(conn):
    with pytest.raises(AccountBlocked):
        asyncio.run(conn._recv_loop(FakeWS([{"t": "erro", "chave": "auth.contaBanida"}])))


def test_hello_shape():
    h = json.loads(connection.build_hello(ACC))
    assert h == {"t": "hello", "nick": "Ash", "token": ACC.token, "delta": 1, "dispositivo": "dev-12345678"}


def test_server_rare_item_notifies_once_per_gain(conn):
    sent = []
    conn.notifier = type("N", (), {"send": lambda self, *a, **k: sent.append((a, k))})()
    conn.itens_nossos = {70091: {"name": "Mystery Egg P2", "rare": True, "category": "special", "icon": "/img/egg.png"},
                         70050: {"name": "Pedra comum", "rare": True, "category": "stone"}}
    conn.estado["items"] = {"70091": 5, "70050": 1, "70000": 3}      # 70000 = Boss Token (não avisa)
    conn._rare_last = conn._rare_counts()
    conn._check_server_rares()
    assert sent == []                                                  # sem aumento: nada
    conn.estado["items"] = {"70091": 6, "70050": 9, "70000": 4}
    conn._check_server_rares()
    assert len(sent) == 1 and "1× Mystery Egg P2" in sent[0][0][1]
    assert sent[0][1]["thumbnail"].endswith("/img/egg.png")
    conn._check_server_rares()                                         # mesmo estado: não repete
    assert len(sent) == 1
    conn.estado["items"]["70091"] = 3                                  # gastar não avisa
    conn._check_server_rares()
    assert len(sent) == 1


class ClosableWS:
    def __init__(self):
        self.closed = None

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)


def test_frame_watchdog_reconnects_silent_session(conn, monkeypatch):
    """Sessão 'zumbi' (ping ok, nenhum frame do jogo com hunt ativa) é fechada para o supervisor reconectar."""
    monkeypatch.setattr(connection.config, "FRAME_CHECK_S", 0.01)
    monkeypatch.setattr(connection.config, "FRAME_SILENCE_S", 0.05)
    conn.estado["huntSlug"] = "larvitar"
    ws = ClosableWS()
    asyncio.run(asyncio.wait_for(conn._frame_watchdog(ws), 2))
    assert ws.closed and ws.closed[0] == 4000


def test_frame_watchdog_ignores_account_without_hunt(conn, monkeypatch):
    monkeypatch.setattr(connection.config, "FRAME_CHECK_S", 0.01)
    monkeypatch.setattr(connection.config, "FRAME_SILENCE_S", 0.05)
    ws = ClosableWS()
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(asyncio.wait_for(conn._frame_watchdog(ws), 0.3))
    assert ws.closed is None


def _alert_conn(monkeypatch, delay):
    monkeypatch.setattr(connection.config, "DOWN_ALERT_DELAY_S", delay)
    c = AccountConnection(ACC, SET)
    sent = []
    c.notifier = type("N", (), {"send": lambda self, *a, **k: sent.append(a[1])})()
    c._set(connection.State.ONLINE, "ok")
    return c, sent


def test_short_drop_does_not_alert(monkeypatch):
    """O jogo reinicia o servidor e a conta volta em segundos: sem 'Caiu'/'Voltou' no Discord."""
    async def go():
        c, sent = _alert_conn(monkeypatch, 0.2)
        c._set(connection.State.DISCONNECTED, "x", "erro")
        await asyncio.sleep(0.05)
        c._set(connection.State.ONLINE, "ok")
        await asyncio.sleep(0.3)
        return sent
    assert asyncio.run(go()) == []


def test_long_drop_alerts_down_and_back(monkeypatch):
    async def go():
        c, sent = _alert_conn(monkeypatch, 0.05)
        c._set(connection.State.DISCONNECTED, "x", "erro")
        await asyncio.sleep(0.2)
        c._set(connection.State.ONLINE, "ok")
        return sent
    assert asyncio.run(go()) == ["🔴 Caiu.", "🟢 Voltou ao ar."]


def test_block_alerts_immediately(monkeypatch):
    async def go():
        c, sent = _alert_conn(monkeypatch, 60)
        c._set(connection.State.BLOCKED, "x", "conta banida")
        return sent
    assert asyncio.run(go()) == ["🔴 Caiu."]


def test_reconnect_delay_is_immediate_only_after_a_working_session(conn, monkeypatch):
    """Caiu uma sessão que funcionava: volta na hora. Se a tentativa falha (manutenção), espera 10s entre as seguintes."""
    import time as _t
    conn._online_since = None                      # a tentativa nem chegou a ficar ONLINE
    assert conn._reconnect_delay() == connection.config.RECONNECT_DELAY == 10
    conn._online_since = _t.monotonic() - 60       # estava online há 1 min
    assert conn._reconnect_delay() == 0
    conn._online_since = _t.monotonic()            # caiu logo depois de conectar: não fica em laço apertado
    assert conn._reconnect_delay() == 10


def test_friendly_reasons_have_no_technical_codes():
    from websockets.frames import Close
    from websockets.exceptions import ConnectionClosedError
    restart = ConnectionClosedError(Close(1012, "reinicio"), Close(1012, "reinicio"), True)
    assert connection.friendly_reason(restart) == "O jogo reiniciou o servidor."
    cut = ConnectionClosedError(None, None, None)
    assert connection.friendly_reason(cut) == "A conexão com o jogo foi interrompida."
    assert "rede" in connection.friendly_reason(OSError("x"))
    for e in (restart, cut, OSError("x"), TimeoutError(), RuntimeError("x")):
        txt = connection.friendly_reason(e)
        assert "Error" not in txt and "1012" not in txt


def test_discord_payload_keeps_webhook_name():
    """O aviso não manda 'username': o Discord usa o nome e o avatar que o usuário configurou no webhook."""
    import notify
    n = notify.Notifier("https://discord.example/api/webhooks/1/x")
    n.send("Conta", "texto", notify.GREEN)
    payload = n._queue.get_nowait()
    assert "username" not in payload and payload["embeds"]


def test_multi_gateway_telegram_and_discord():
    import notify
    # Só Telegram ativo
    n = notify.Notifier("", telegram_token="123456:ABCDEF1234567890abcdef", telegram_chat_id="-100999")
    assert n.enabled and not n.discord_active and n.telegram_active
    n.send("Ash", "✨ capturou um shiny **Gengar**!", notify.GOLD, [("Total no dia", "2", True)])
    item = n._queue.get_nowait()
    html_msg = notify.embed_to_telegram_html(item["embeds"][0])
    assert "<b>Ash</b>" in html_msg
    assert "<b>Gengar</b>" in html_msg
    assert "• <b>Total no dia:</b> 2" in html_msg


@pytest.mark.parametrize("telegram_enabled", [True, False])
def test_capture_alerts_use_confirmed_results_and_keep_shiny_alert(conn, monkeypatch, telegram_enabled):
    from notify import Notifier, embed_to_telegram_html

    conn.notifier = Notifier("https://discord.example/api/webhooks/1/x",
                             telegram_token="test", telegram_chat_id="12345",
                             telegram_enabled=telegram_enabled)
    monkeypatch.setattr(conn, "_save_session", lambda: None)
    conn.estado["huntSlug"] = "tower"
    conn.hunts = [{"slug": "tower", "nome": "Pokémon Tower"}]
    shiny = {"k": "bola", "slot": 3, "nome": "Haunter", "sucesso": True, "shiny": True}
    asyncio.run(conn._recv_loop(FakeWS([
        {"t": "batalha", "ev": [{"k": "bola", "slot": 1, "nome": "Cubone", "sucesso": False}]},
        {"t": "batalha", "ev": [{"k": "bola", "slot": 2, "nome": "Gastly", "sucesso": True,
                               "level": 20, "ballId": 1}]},
        {"t": "batalha", "ev": [shiny, shiny]},
    ])))

    if telegram_enabled:
        capture = conn.notifier._queue.get_nowait()
        assert capture["_targets"] == ["telegram"]
        body = embed_to_telegram_html(capture["embeds"][0])
        assert all(part in body for part in ("<b>Ash</b>", "Gastly", "20", "Poké Ball", "Pokémon Tower"))
    shiny_alert = conn.notifier._queue.get_nowait()
    assert "_targets" not in shiny_alert
    assert "shiny **Haunter**" in shiny_alert["embeds"][0]["description"]
    assert conn.notifier._queue.empty()


def test_blocked_before_first_login_alerts_once_with_account(conn):
    from notify import Notifier

    conn.notifier = Notifier("", telegram_token="test", telegram_chat_id="12345")
    for _ in range(2):
        conn._alert_state(connection.State.BLOCKED, "Sessão inválida")
    embed = conn.notifier._queue.get_nowait()["embeds"][0]
    assert embed["title"] == "Ash"
    assert embed["fields"][0]["value"] == "Sessão inválida"
    assert conn.notifier._queue.empty()


def test_external_login_wait_is_configurable():
    import config as cfg
    assert cfg.external_login_wait_s() == 300             # padrão: 5 min
    cfg.set_external_login_wait_min(12)
    assert cfg.external_login_wait_s() == 720
    cfg.set_external_login_wait_min("lixo")                # inválido volta ao padrão
    assert cfg.external_login_wait_s() == 300
    cfg.set_external_login_wait_min(0)                     # nunca menos de 1 min (evita martelar o login)
    assert cfg.external_login_wait_s() == 60
    cfg.set_external_login_wait_min(5)

