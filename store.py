"""Persistência em SQLite: contas e configurações globais do painel.

Arquivo: $DATA_DIR/app.db (padrão: ./data/app.db ao lado do código). Guarda tokens e
senhas de proxy em texto puro, então o arquivo é criado com permissão restrita
(0600 em Linux/macOS). Não exponha a pasta de dados nem faça commit dela.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time

import config

log = logging.getLogger("store")

DEVICE_ID_RE = re.compile(r"^[a-zA-Z0-9-]{8,64}$")  # mesmo formato aceito pelo jogo

# Configurações globais: chave -> padrão
SETTING_DEFAULTS: dict[str, str] = {
    "ws_url": config.DEFAULT_WS_URL,
    "discord_webhook": "",
    "discord_enabled": "1",
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "telegram_enabled": "1",
    "report_hour": "0",
    "report_tz": "America/Sao_Paulo",
    "public_url": "",
    "sniper_enabled": "0",   # chave geral: sem ela ligada, nenhuma regra de compra automática roda
    "alert_sell": "1",       # item meu está bem acima da média (bom momento de vender)
    "alert_sell_pct": "30",  # quanto acima da média (%) para avisar
    "alert_sold": "1",       # um anúncio de uma das minhas contas foi vendido
    "external_login_wait_min": "5",   # min de espera antes de reconectar uma conta aberta em outro lugar
}
SECRET_SETTINGS = {"discord_webhook", "telegram_bot_token"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL,
    token TEXT NOT NULL,
    device_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    proxy_scheme TEXT, proxy_host TEXT, proxy_port INTEGER,
    proxy_user TEXT, proxy_pass TEXT,
    opts TEXT NOT NULL DEFAULT '{}',
    token_status TEXT NOT NULL DEFAULT 'unknown',
    token_detail TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS market_favs (
    item_id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS market_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- 'alert' | 'snipe'
    enabled INTEGER NOT NULL DEFAULT 1,
    spec TEXT NOT NULL,            -- JSON: alvo, moeda, preço máximo, filtros, conta, orçamento...
    spent REAL NOT NULL DEFAULT 0, -- gasto no dia (snipe)
    spent_day TEXT NOT NULL DEFAULT '',
    last_fire REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS price_history (
    ts INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    min_gold INTEGER, min_orb INTEGER,
    ads INTEGER NOT NULL, units INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_item ON price_history(item_id, ts);
CREATE TABLE IF NOT EXISTS market_sales (
    id INTEGER PRIMARY KEY,          -- id da venda no jogo (único e crescente)
    ts INTEGER NOT NULL,             -- ms
    kind TEXT NOT NULL,              -- item | pokemon
    moeda TEXT NOT NULL,             -- gold | orb
    price REAL NOT NULL,             -- valor total da venda
    qty INTEGER NOT NULL,
    name TEXT NOT NULL,
    species INTEGER,
    shiny INTEGER NOT NULL DEFAULT 0,
    iv INTEGER,
    level INTEGER,
    look INTEGER                     -- looktype do Pokémon (sprite)
);
CREATE INDEX IF NOT EXISTS idx_sales_ts ON market_sales(ts);
CREATE INDEX IF NOT EXISTS idx_sales_name ON market_sales(kind, moeda, name, ts);
CREATE TABLE IF NOT EXISTS market_rule_spend (
    rule_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    spent REAL NOT NULL DEFAULT 0,   -- gasto do dia desta conta nesta regra (o orçamento vale por conta)
    PRIMARY KEY (rule_id, account_id)
);
CREATE TABLE IF NOT EXISTS market_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    account_id INTEGER,
    rule_id INTEGER,
    status TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    scheme TEXT NOT NULL DEFAULT 'socks5',
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    last_ip TEXT NOT NULL DEFAULT '',
    last_ok INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_tested_at REAL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    account_nick TEXT NOT NULL,
    pokemon_name TEXT NOT NULL,
    poke_id INTEGER,
    looktype INTEGER,
    level INTEGER,
    shiny INTEGER NOT NULL DEFAULT 0,
    ball_id INTEGER,
    success INTEGER NOT NULL,
    chance REAL,
    hunt_slug TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_captures_ts ON captures(ts DESC);
CREATE INDEX IF NOT EXISTS idx_captures_acc ON captures(account_id, ts DESC);
"""


def data_dir() -> str:
    d = os.getenv("DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(d, exist_ok=True)
    return d


def new_device_id() -> str:
    import uuid
    return str(uuid.uuid4())


def mask(secret: str, keep: int = 4) -> str:
    """'abcdef123456' -> '…3456' (nunca devolve o segredo inteiro)."""
    if not secret:
        return ""
    return "…" + secret[-keep:] if len(secret) > keep * 2 else "…"


class Store:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(data_dir(), "app.db")
        new = not os.path.exists(self.path)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)
            self._db.commit()
        if new:
            try:
                os.chmod(self.path, 0o600)  # no Windows é ignorado
            except OSError:
                pass

    # ----------------------------------------------------------- contas
    @staticmethod
    def _row(r: sqlite3.Row) -> dict:
        proxy = None
        if r["proxy_host"]:
            proxy = {"scheme": r["proxy_scheme"] or "socks5", "host": r["proxy_host"],
                     "port": r["proxy_port"], "username": r["proxy_user"] or "",
                     "password": r["proxy_pass"] or ""}
        try:
            options = json.loads(r["opts"] or "{}")
        except ValueError:
            options = {}
        return {"id": r["id"], "nick": r["nick"], "token": r["token"], "device_id": r["device_id"],
                "enabled": bool(r["enabled"]), "proxy": proxy, "options": options,
                "token_status": r["token_status"], "token_detail": r["token_detail"],
                "created_at": r["created_at"]}

    def list_accounts(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM accounts ORDER BY id").fetchall()
        return [self._row(r) for r in rows]

    def get_account(self, acc_id: int) -> dict | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM accounts WHERE id=?", (acc_id,)).fetchone()
        return self._row(r) if r else None

    def count_accounts(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]

    def add_account(self, d: dict, acc_id: int | None = None) -> int:
        p = d.get("proxy") or {}
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO accounts (id, nick, token, device_id, enabled, proxy_scheme, proxy_host,"
                " proxy_port, proxy_user, proxy_pass, opts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (acc_id, d["nick"], d["token"], d["device_id"], 1 if d.get("enabled", True) else 0,
                 p.get("scheme"), p.get("host"), p.get("port"), p.get("username"), p.get("password"),
                 json.dumps(d.get("options") or {}), time.time()))
            self._db.commit()
            return int(cur.lastrowid)

    def update_account(self, acc_id: int, changes: dict) -> None:
        """Atualiza só as chaves presentes: nick, token, device_id, enabled, proxy (None limpa), options (mescla)."""
        cols: list[str] = []
        vals: list = []
        for k in ("nick", "token", "device_id"):
            if k in changes:
                cols.append(f"{k}=?")
                vals.append(changes[k])
        if "enabled" in changes:
            cols.append("enabled=?")
            vals.append(1 if changes["enabled"] else 0)
        if "proxy" in changes:
            p = changes["proxy"] or {}
            for col, key in (("proxy_scheme", "scheme"), ("proxy_host", "host"), ("proxy_port", "port"),
                             ("proxy_user", "username"), ("proxy_pass", "password")):
                cols.append(f"{col}=?")
                vals.append(p.get(key))
        if "options" in changes:
            cur = self.get_account(acc_id)
            merged = {**(cur["options"] if cur else {}), **(changes["options"] or {})}
            cols.append("opts=?")
            vals.append(json.dumps(merged))
        if "token" in changes or "nick" in changes:
            cols += ["token_status=?", "token_detail=?"]
            vals += ["unknown", ""]
        if not cols:
            return
        with self._lock:
            self._db.execute(f"UPDATE accounts SET {', '.join(cols)} WHERE id=?", (*vals, acc_id))
            self._db.commit()

    def set_token(self, acc_id: int, token: str) -> None:
        """Token renovado pelo servidor (sessao.renovada): não zera o status."""
        with self._lock:
            self._db.execute("UPDATE accounts SET token=? WHERE id=?", (token, acc_id))
            self._db.commit()

    def set_token_status(self, acc_id: int, status: str, detail: str = "") -> None:
        with self._lock:
            self._db.execute("UPDATE accounts SET token_status=?, token_detail=? WHERE id=?",
                             (status, detail, acc_id))
            self._db.commit()

    def delete_account(self, acc_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM accounts WHERE id=?", (acc_id,))
            self._db.commit()

    # ----------------------------------------------------------- central de proxies
    @staticmethod
    def _proxy_row(r: sqlite3.Row) -> dict:
        return {
            "id": r["id"],
            "name": r["name"] or "",
            "scheme": r["scheme"] or "socks5",
            "host": r["host"],
            "port": int(r["port"]),
            "username": r["username"] or "",
            "password": r["password"] or "",
            "notes": r["notes"] or "",
            "last_ip": r["last_ip"] or "",
            "last_ok": None if r["last_ok"] is None else bool(r["last_ok"]),
            "last_error": r["last_error"] or "",
            "last_tested_at": r["last_tested_at"],
            "created_at": r["created_at"],
        }

    def list_proxies(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM proxies ORDER BY id").fetchall()
        return [self._proxy_row(r) for r in rows]

    def get_proxy(self, proxy_id: int) -> dict | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM proxies WHERE id=?", (proxy_id,)).fetchone()
        return self._proxy_row(r) if r else None

    def add_proxy(self, d: dict) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO proxies (name, scheme, host, port, username, password, notes, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    (d.get("name") or "").strip(),
                    (d.get("scheme") or "socks5").strip().lower(),
                    d["host"].strip(),
                    int(d["port"]),
                    d.get("username") or "",
                    d.get("password") or "",
                    (d.get("notes") or "").strip(),
                    time.time(),
                ),
            )
            self._db.commit()
            return int(cur.lastrowid)

    def update_proxy(self, proxy_id: int, changes: dict) -> None:
        cols: list[str] = []
        vals: list = []
        for k in ("name", "scheme", "host", "port", "username", "password", "notes"):
            if k in changes:
                cols.append(f"{k}=?")
                v = changes[k]
                if k == "scheme" and isinstance(v, str):
                    v = v.strip().lower()
                elif k in ("name", "host", "notes") and isinstance(v, str):
                    v = v.strip()
                elif k == "port":
                    v = int(v)
                vals.append(v)
        if any(k in changes for k in ("scheme", "host", "port", "username", "password")):
            cols += ["last_ok=?", "last_ip=?", "last_error=?", "last_tested_at=?"]
            vals += [None, "", "", None]
        if not cols:
            return
        with self._lock:
            self._db.execute(f"UPDATE proxies SET {', '.join(cols)} WHERE id=?", (*vals, proxy_id))
            self._db.commit()

    def set_proxy_test(self, proxy_id: int, ok: bool, ip: str = "", error: str = "") -> None:
        with self._lock:
            self._db.execute(
                "UPDATE proxies SET last_ok=?, last_ip=?, last_error=?, last_tested_at=? WHERE id=?",
                (1 if ok else 0, ip if ok else "", "" if ok else error[:300], time.time(), proxy_id),
            )
            self._db.commit()

    def delete_proxy(self, proxy_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM proxies WHERE id=?", (proxy_id,))
            self._db.commit()

    # ----------------------------------------------------------- histórico de capturas
    CAPTURES_MAX = 5000

    def add_capture(self, d: dict) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO captures (ts, account_id, account_nick, pokemon_name, poke_id, looktype, "
                "level, shiny, ball_id, success, chance, hunt_slug) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    int(d.get("ts") or time.time() * 1000),
                    int(d["account_id"]),
                    str(d.get("account_nick") or ""),
                    str(d.get("pokemon_name") or "Desconhecido"),
                    int(d["poke_id"]) if d.get("poke_id") is not None else None,
                    int(d["looktype"]) if d.get("looktype") is not None else None,
                    int(d["level"]) if d.get("level") is not None else None,
                    1 if d.get("shiny") else 0,
                    int(d["ball_id"]) if d.get("ball_id") is not None else None,
                    1 if d.get("success") else 0,
                    float(d["chance"]) if d.get("chance") is not None else None,
                    str(d.get("hunt_slug") or ""),
                ),
            )
            self._db.execute(
                "DELETE FROM captures WHERE id NOT IN (SELECT id FROM captures ORDER BY id DESC LIMIT ?)",
                (self.CAPTURES_MAX,),
            )
            self._db.commit()
            return int(cur.lastrowid)

    def list_captures(
        self,
        *,
        account_id: int | None = None,
        only_caught: bool = False,
        only_shiny: bool = False,
        limit: int = 200,
    ) -> list[dict]:
        where: list[str] = []
        vals: list = []
        if account_id is not None:
            where.append("account_id=?")
            vals.append(int(account_id))
        if only_caught:
            where.append("success=1")
        if only_shiny:
            where.append("shiny=1")
        sql = "SELECT * FROM captures"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        vals.append(min(max(int(limit), 1), 1000))
        with self._lock:
            rows = self._db.execute(sql, vals).fetchall()
        return [
            {
                "id": r["id"],
                "ts": r["ts"],
                "accountId": r["account_id"],
                "account": f"acc{r['account_id']}",
                "nick": r["account_nick"],
                "name": r["pokemon_name"],
                "pokeId": r["poke_id"],
                "looktype": r["looktype"],
                "level": r["level"],
                "shiny": bool(r["shiny"]),
                "ballId": r["ball_id"],
                "success": bool(r["success"]),
                "chance": r["chance"],
                "huntSlug": r["hunt_slug"],
            }
            for r in rows
        ]

    def capture_stats(self, account_id: int | None = None) -> dict:
        where = " WHERE account_id=?" if account_id is not None else ""
        vals = (int(account_id),) if account_id is not None else ()
        with self._lock:
            r = self._db.execute(
                f"SELECT COUNT(*) AS total, "
                f"SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS caught, "
                f"SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed, "
                f"SUM(CASE WHEN shiny=1 THEN 1 ELSE 0 END) AS shiny_seen, "
                f"SUM(CASE WHEN shiny=1 AND success=1 THEN 1 ELSE 0 END) AS shiny_caught "
                f"FROM captures{where}",
                vals,
            ).fetchone()
            ball_rows = self._db.execute(
                f"SELECT ball_id, COUNT(*) AS used, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS caught "
                f"FROM captures{where} GROUP BY ball_id",
                vals,
            ).fetchall()
        total = int(r["total"] or 0)
        caught = int(r["caught"] or 0)
        failed = int(r["failed"] or 0)
        return {
            "total": total,
            "caught": caught,
            "failed": failed,
            "rate": round((caught / total) * 100, 1) if total > 0 else 0.0,
            "shinySeen": int(r["shiny_seen"] or 0),
            "shinyCaught": int(r["shiny_caught"] or 0),
            "byBall": [
                {"ballId": br["ball_id"], "used": int(br["used"] or 0), "caught": int(br["caught"] or 0)}
                for br in ball_rows
                if br["ball_id"] is not None
            ],
        }

    # ----------------------------------------------------------- configurações
    def get_setting(self, key: str) -> str:
        with self._lock:
            r = self._db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r["value"] if r else SETTING_DEFAULTS.get(key, "")

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO settings(key, value) VALUES(?, ?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
            self._db.commit()

    def all_settings(self) -> dict[str, str]:
        return {k: self.get_setting(k) for k in SETTING_DEFAULTS}

    # ----------------------------------------------------------- sessões do painel
    def add_session(self, token_hash: str, expires: float) -> None:
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            self._db.execute("INSERT OR REPLACE INTO sessions(token_hash, expires) VALUES(?, ?)",
                             (token_hash, expires))
            self._db.commit()

    def session_valid(self, token_hash: str) -> bool:
        with self._lock:
            r = self._db.execute("SELECT expires FROM sessions WHERE token_hash=?", (token_hash,)).fetchone()
        return bool(r) and r["expires"] > time.time()

    def delete_session(self, token_hash: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
            self._db.commit()

    def clear_sessions(self) -> None:
        with self._lock:
            self._db.execute("DELETE FROM sessions")
            self._db.commit()

    # ----------------------------------------------------------- mercado
    def market_favs(self) -> list[int]:
        with self._lock:
            return [r[0] for r in self._db.execute("SELECT item_id FROM market_favs ORDER BY item_id")]

    def set_market_fav(self, item_id: int, on: bool) -> None:
        with self._lock:
            if on:
                self._db.execute("INSERT OR IGNORE INTO market_favs(item_id) VALUES(?)", (item_id,))
            else:
                self._db.execute("DELETE FROM market_favs WHERE item_id=?", (item_id,))
            self._db.commit()

    @staticmethod
    def _rule(r: sqlite3.Row) -> dict:
        try:
            spec = json.loads(r["spec"] or "{}")
        except ValueError:
            spec = {}
        return {"id": r["id"], "kind": r["kind"], "enabled": bool(r["enabled"]), "spec": spec,
                "spent": r["spent"], "spent_day": r["spent_day"], "last_fire": r["last_fire"],
                "created_at": r["created_at"]}

    def list_rules(self, kind: str | None = None) -> list[dict]:
        with self._lock:
            if kind:
                rows = self._db.execute("SELECT * FROM market_rules WHERE kind=? ORDER BY id", (kind,)).fetchall()
            else:
                rows = self._db.execute("SELECT * FROM market_rules ORDER BY id").fetchall()
        return [self._rule(r) for r in rows]

    def get_rule(self, rule_id: int) -> dict | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM market_rules WHERE id=?", (rule_id,)).fetchone()
        return self._rule(r) if r else None

    def add_rule(self, kind: str, spec: dict, enabled: bool = True) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO market_rules(kind, enabled, spec, created_at) VALUES(?,?,?,?)",
                (kind, 1 if enabled else 0, json.dumps(spec), time.time()))
            self._db.commit()
            return int(cur.lastrowid)

    def update_rule(self, rule_id: int, *, spec: dict | None = None, enabled: bool | None = None) -> None:
        cols, vals = [], []
        if spec is not None:
            cols.append("spec=?")
            vals.append(json.dumps(spec))
        if enabled is not None:
            cols.append("enabled=?")
            vals.append(1 if enabled else 0)
        if not cols:
            return
        with self._lock:
            self._db.execute(f"UPDATE market_rules SET {', '.join(cols)} WHERE id=?", (*vals, rule_id))
            self._db.commit()

    def delete_rule(self, rule_id: int) -> None:
        with self._lock:
            self._db.execute("DELETE FROM market_rules WHERE id=?", (rule_id,))
            self._db.execute("DELETE FROM market_rule_spend WHERE rule_id=?", (rule_id,))
            self._db.commit()

    def rule_spent(self, rule_id: int, day: str) -> float:
        """Gasto do dia da regra (zera sozinho quando o dia vira)."""
        with self._lock:
            r = self._db.execute("SELECT spent, spent_day FROM market_rules WHERE id=?", (rule_id,)).fetchone()
        return float(r["spent"]) if r and r["spent_day"] == day else 0.0

    def account_spent(self, rule_id: int, account_id: int, day: str) -> float:
        """Gasto do dia de UMA conta numa regra (o orçamento diário vale por conta)."""
        with self._lock:
            r = self._db.execute("SELECT spent, day FROM market_rule_spend WHERE rule_id=? AND account_id=?",
                                 (rule_id, account_id)).fetchone()
        return float(r["spent"]) if r and r["day"] == day else 0.0

    def add_rule_spent(self, rule_id: int, day: str, amount: float, account_id: int | None = None) -> None:
        if account_id is not None:
            base = self.account_spent(rule_id, account_id, day)
            with self._lock:
                self._db.execute("INSERT INTO market_rule_spend(rule_id, account_id, day, spent) VALUES(?,?,?,?) "
                                 "ON CONFLICT(rule_id, account_id) DO UPDATE SET day=excluded.day, spent=excluded.spent",
                                 (rule_id, account_id, day, base + amount))
                self._db.commit()
        with self._lock:
            r = self._db.execute("SELECT spent, spent_day FROM market_rules WHERE id=?", (rule_id,)).fetchone()
            if not r:
                return
            base = float(r["spent"]) if r["spent_day"] == day else 0.0
            self._db.execute("UPDATE market_rules SET spent=?, spent_day=? WHERE id=?", (base + amount, day, rule_id))
            self._db.commit()

    def touch_rule(self, rule_id: int) -> None:
        with self._lock:
            self._db.execute("UPDATE market_rules SET last_fire=? WHERE id=?", (time.time(), rule_id))
            self._db.commit()

    def add_price_snapshot(self, ts: int, rows: list[tuple]) -> None:
        """rows: (item_id, min_gold, min_orb, anuncios, unidades). Poda o que passa de 45 dias."""
        with self._lock:
            self._db.executemany(
                "INSERT INTO price_history(ts, item_id, min_gold, min_orb, ads, units) VALUES(?,?,?,?,?,?)",
                [(ts, *r) for r in rows])
            self._db.execute("DELETE FROM price_history WHERE ts < ?", (ts - 45 * 86400 * 1000,))
            self._db.commit()

    def price_history(self, item_id: int, since_ms: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT ts, min_gold, min_orb, ads, units FROM price_history WHERE item_id=? AND ts>=? ORDER BY ts",
                (item_id, since_ms)).fetchall()
        return [{"ts": r["ts"], "minGold": r["min_gold"], "minOrb": r["min_orb"],
                 "ads": r["ads"], "units": r["units"]} for r in rows]

    def last_price_snapshot_ts(self) -> int:
        with self._lock:
            r = self._db.execute("SELECT MAX(ts) FROM price_history").fetchone()
        return int(r[0] or 0)

    # ----------------------------------------------------------- vendas do servidor (análise do mercado)
    SALES_KEEP_DAYS = 60

    def last_sale_id(self) -> int:
        with self._lock:
            r = self._db.execute("SELECT MAX(id) FROM market_sales").fetchone()
        return int(r[0] or 0)

    def add_sales(self, rows: list[tuple]) -> int:
        """rows: (id, ts, kind, moeda, price, qty, name, species, shiny, iv, level, look). Ignora ids já gravados."""
        if not rows:
            return 0
        with self._lock:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO market_sales(id, ts, kind, moeda, price, qty, name, species, shiny, iv, level, look) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            added = self._db.total_changes - before
            self._db.execute("DELETE FROM market_sales WHERE ts < ?",
                             (int(time.time() * 1000) - self.SALES_KEEP_DAYS * 86_400_000,))
            self._db.commit()
        return added

    def sales_query(self, sql: str, params: dict) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, params).fetchall()

    def add_market_log(self, account_id: int | None, rule_id: int | None, status: str, text: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO market_log(ts, account_id, rule_id, status, text) VALUES(?,?,?,?,?)",
                             (time.time(), account_id, rule_id, status, text[:500]))
            self._db.execute(
                "DELETE FROM market_log WHERE id NOT IN (SELECT id FROM market_log ORDER BY id DESC LIMIT 300)")
            self._db.commit()

    def market_log(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM market_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"id": r["id"], "ts": r["ts"], "accountId": r["account_id"], "ruleId": r["rule_id"],
                 "status": r["status"], "text": r["text"]} for r in rows]

    # ----------------------------------------------------------- migração do .env
    def import_env_once(self) -> int:
        """Na 1ª execução com banco vazio, importa ACC1..ACC4 e WS_URL/webhook/etc. do ambiente."""
        if self.get_setting("env_imported") == "1":
            return 0
        n = 0
        if self.count_accounts() == 0:
            for acc in config.load_env_accounts():
                self.add_account(acc, acc_id=acc["id"])  # preserva o id (acc1..acc4)
                n += 1
        for env_key, key in (("WS_URL", "ws_url"), ("DISCORD_WEBHOOK_URL", "discord_webhook"),
                             ("TELEGRAM_BOT_TOKEN", "telegram_bot_token"), ("TELEGRAM_CHAT_ID", "telegram_chat_id"),
                             ("DAILY_REPORT_HOUR", "report_hour"), ("REPORT_TZ", "report_tz"),
                             ("PUBLIC_URL", "public_url")):
            val = os.getenv(env_key, "").strip()
            if val and not val.startswith("wss://CHANGE_ME"):
                if key == "ws_url" and not config.is_allowed_ws_url(val):
                    continue
                self.set_setting(key, val.rstrip("/") if key == "public_url" else val)
        self.set_setting("env_imported", "1")
        if n:
            log.info("%d conta(s) importada(s) do .env para o banco", n)
        return n
