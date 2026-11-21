"""Notificações multi-gateway (Discord e/ou Telegram) + estatísticas diárias.

Webhook do Discord, Bot do Telegram (token + chat_id), hora da virada do dia e fuso são
configurados no painel (aba Configurações). As variáveis DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN,
TELEGRAM_CHAT_ID, DAILY_REPORT_HOUR e REPORT_TZ do .env são lidas como padrão inicial (e
importadas para o banco na 1ª execução).

O envio é assíncrono por uma fila: nunca bloqueia o bot e respeita o rate limit (429) de cada gateway.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone, tzinfo

import aiohttp

from session_stats import ITEM_LABELS

log = logging.getLogger("notify")

RED, GREEN, GOLD, BLUE = 0xE74C3C, 0x2ECC71, 0xF1C40F, 0x3498DB
TELEGRAM_API_BASE = "https://api.telegram.org"

# Base pública do dashboard (ex.: https://seu-dominio.exemplo), usada para
# montar a URL do ícone (thumbnail) nos embeds — ex.: item raro obtido. Sem ela,
# os embeds saem sem thumbnail (nada quebra, só fica sem o ícone).
PUBLIC_URL = os.getenv("PUBLIC_URL", "").strip().rstrip("/")


def set_public_url(url: str) -> None:
    """Define a URL pública do dashboard (configurável no painel)."""
    global PUBLIC_URL
    PUBLIC_URL = (url or "").strip().rstrip("/")


def rare_icon_url(key: str) -> str | None:
    """URL do ícone padronizado (scripts/gen_rare_icons.py) de um item raro
    da sessão (chaves de session_stats.TRACKED), ou None sem PUBLIC_URL."""
    return f"{PUBLIC_URL}/rare-icons/{key}.png" if PUBLIC_URL else None


def fmt_duration(seconds: float) -> str:
    s = int(max(seconds, 0))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}min"
    if m:
        return f"{m}min{sec:02d}s"
    return f"{sec}s"


def _md_to_tg_html(text: str) -> str:
    """Escapa HTML e converte negrito Markdown (**texto**) em <b>texto</b> para o Telegram."""
    escaped = html.escape(str(text or ""), quote=False)
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)


def embed_to_telegram_html(embed: dict) -> str:
    """Formata um embed padrão do bot em mensagem HTML limpa para o Telegram."""
    lines: list[str] = []
    title = str(embed.get("title") or "").strip()
    desc = str(embed.get("description") or "").strip()
    if title:
        lines.append(f"<b>{html.escape(title, quote=False)}</b>")
    if desc:
        lines.append(_md_to_tg_html(desc))
    fields = embed.get("fields") or []
    if fields:
        for f in fields:
            name = html.escape(str(f.get("name") or ""), quote=False)
            val = _md_to_tg_html(str(f.get("value") or ""))
            if "\n" in val:
                lines.append(f"\n<b>{name}</b>\n{val}")
            else:
                lines.append(f"• <b>{name}:</b> {val}")
    return "\n".join(lines).strip()


class Notifier:
    def __init__(
        self,
        url: str | None = None,
        *,
        discord_enabled: bool = True,
        telegram_token: str | None = None,
        telegram_chat_id: str | None = None,
        telegram_enabled: bool = True,
        store=None,
    ) -> None:
        use_env = url is None
        self.url = (os.getenv("DISCORD_WEBHOOK_URL", "") if use_env else (url or "")).strip()
        self.discord_enabled = bool(discord_enabled)
        self.telegram_token = (
            os.getenv("TELEGRAM_BOT_TOKEN", "") if (telegram_token is None and use_env) else (telegram_token or "")
        ).strip()
        self.telegram_chat_id = (
            os.getenv("TELEGRAM_CHAT_ID", "") if (telegram_chat_id is None and use_env) else (telegram_chat_id or "")
        ).strip()
        self.telegram_enabled = bool(telegram_enabled)
        self._store = store
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)

    @classmethod
    def from_store(cls, store) -> "Notifier":
        return cls(
            store.get_setting("discord_webhook"),
            discord_enabled=store.get_setting("discord_enabled") != "0",
            telegram_token=store.get_setting("telegram_bot_token"),
            telegram_chat_id=store.get_setting("telegram_chat_id"),
            telegram_enabled=store.get_setting("telegram_enabled") != "0",
            store=store,
        )

    def apply_store(self, store) -> None:
        self._store = store
        self.url = store.get_setting("discord_webhook").strip()
        self.discord_enabled = store.get_setting("discord_enabled") != "0"
        self.telegram_token = store.get_setting("telegram_bot_token").strip()
        self.telegram_chat_id = store.get_setting("telegram_chat_id").strip()
        self.telegram_enabled = store.get_setting("telegram_enabled") != "0"

    @property
    def discord_configured(self) -> bool:
        return bool(self.url)

    @property
    def discord_active(self) -> bool:
        return bool(self.url and self.discord_enabled)

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_token and self.telegram_chat_id)

    @property
    def telegram_active(self) -> bool:
        return bool(self.telegram_token and self.telegram_chat_id and self.telegram_enabled)

    @property
    def enabled(self) -> bool:
        return self.discord_active or self.telegram_active

    def send(self, title: str, description: str = "", color: int = BLUE,
             fields: list[tuple[str, str, bool]] | None = None,
             thumbnail: str | None = None,
             *, targets: set[str] | None = None) -> None:
        """Enfileira uma notificação (sem await) e grava na Central de Notificações do painel.
        `thumbnail` (se dado) vira a imagem no canto superior direito do embed do Discord.
        `targets` (opcional) restringe o envio a {'discord'} ou {'telegram'} (ex.: botão de teste)."""
        if self._store is not None and hasattr(self._store, "add_notification"):
            level = {RED: "error", GREEN: "ok", GOLD: "warn"}.get(color, "info")
            plain_fields = [{"name": n, "value": v} for n, v, _ in (fields or [])]
            try:
                self._store.add_notification(title, description, level=level, fields=plain_fields)
            except Exception:  # noqa: BLE001 - falha no histórico não interrompe envio
                log.debug("falha ao salvar notificação no banco")
        if targets is None:
            if not self.enabled:
                return
        else:
            if ("discord" in targets and not self.discord_configured) and (
                "telegram" in targets and not self.telegram_configured
            ):
                return
        embed = {
            "title": title,
            "description": description,
            "color": color,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if fields:
            embed["fields"] = [{"name": n, "value": v, "inline": i} for n, v, i in fields]
        if thumbnail:
            embed["thumbnail"] = {"url": thumbnail}
        item: dict = {"embeds": [embed]}  # sem "username": vale o nome/avatar que o usuário configurou no Discord
        if targets is not None:
            item["_targets"] = list(targets)
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            log.warning("fila de notificações cheia; mensagem descartada")

    async def _post_discord(self, session: aiohttp.ClientSession, embeds: list[dict]) -> None:
        if not self.url:
            return
        payload = {"embeds": embeds}
        for attempt in range(4):
            try:
                async with session.post(self.url, json=payload) as r:
                    if r.status == 429:
                        retry = 1.0
                        try:
                            retry = float((await r.json()).get("retry_after", 1))
                        except Exception:  # noqa: BLE001
                            pass
                        await asyncio.sleep(retry + 0.2)
                        continue
                    if r.status >= 400:
                        log.warning("webhook Discord respondeu HTTP %s", r.status)
                    break
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                log.warning("falha ao enviar webhook Discord (%s), tentativa %d", type(e).__name__, attempt + 1)
                await asyncio.sleep(2 * (attempt + 1))

    async def _post_telegram(self, session: aiohttp.ClientSession, embeds: list[dict]) -> None:
        if not (self.telegram_token and self.telegram_chat_id and embeds):
            return
        text = embed_to_telegram_html(embeds[0])
        if not text:
            return
        api_url = f"{TELEGRAM_API_BASE}/bot{self.telegram_token}/sendMessage"
        payload = {
            "chat_id": self.telegram_chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        for attempt in range(4):
            try:
                async with session.post(api_url, json=payload) as r:
                    if r.status == 429:
                        retry = 1.0
                        try:
                            body = await r.json()
                            retry = float((body.get("parameters") or {}).get("retry_after") or body.get("retry_after", 1))
                        except Exception:  # noqa: BLE001
                            pass
                        await asyncio.sleep(retry + 0.2)
                        continue
                    if r.status >= 400:
                        log.warning("Telegram respondeu HTTP %s", r.status)
                    break
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                log.warning("falha ao enviar Telegram (%s), tentativa %d", type(e).__name__, attempt + 1)
                await asyncio.sleep(2 * (attempt + 1))

    async def run(self) -> None:
        """Worker: esvazia a fila para sempre (rodar em paralelo com o bot).
        Fica de pé mesmo sem gateway configurado: eles podem ser definidos depois, pelo painel."""
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            while True:
                item = await self._queue.get()
                embeds = item.get("embeds") or []
                targets = set(item["_targets"]) if "_targets" in item else None
                tasks = []
                if (targets is not None and "discord" in targets and self.discord_configured) or (
                    targets is None and self.discord_active
                ):
                    tasks.append(self._post_discord(session, embeds))
                if (targets is not None and "telegram" in targets and self.telegram_configured) or (
                    targets is None and self.telegram_active
                ):
                    tasks.append(self._post_telegram(session, embeds))
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await asyncio.sleep(0.5)  # espaçamento entre mensagens


class DailyStats:
    """XP, ouro, kills e itens raros por conta no período corrente (persistido em JSON)."""

    def __init__(self, path: str | None = None, report_hour: int | None = None,
                 tz_name: str | None = None) -> None:
        self.path = path or os.getenv("DAILY_FILE") or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "daily_state.json")
        self.report_hour = (report_hour if report_hour is not None
                            else int(os.getenv("DAILY_REPORT_HOUR", "0") or 0)) % 24
        self.tz = _load_tz(tz_name or os.getenv("REPORT_TZ", "America/Sao_Paulo"))
        self._dirty = False
        self.period: str = self.current_period()
        self.accounts: dict[str, dict] = {}
        try:
            with open(self.path, encoding="utf8") as fh:
                d = json.load(fh)
            if isinstance(d, dict) and isinstance(d.get("accounts"), dict):
                self.period = str(d.get("period") or self.period)
                self.accounts = _migrate_account_keys(d["accounts"])
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as e:
            log.warning("daily_state ilegível (%s); começando do zero", e)

    def set_schedule(self, report_hour: int, tz_name: str) -> None:
        """Muda hora de virada do dia e fuso (painel). O período corrente é recalculado no próximo ciclo."""
        self.report_hour = int(report_hour) % 24
        self.tz = _load_tz(tz_name or "America/Sao_Paulo")

    # --- período
    def current_period(self) -> str:
        return (datetime.now(self.tz) - timedelta(hours=self.report_hour)).date().isoformat()

    # --- contadores
    def _acc(self, name: str) -> dict:
        return self.accounts.setdefault(name, {"xp": 0, "gold": 0, "kills": 0,
                                                "items": {k: 0 for k in ITEM_LABELS}})

    def add_kill(self, name: str, xp: int, gold: int) -> None:
        a = self._acc(name)
        a["xp"] += int(xp or 0)
        a["gold"] += int(gold or 0)
        a["kills"] += 1
        self._dirty = True

    def add_item(self, name: str, key: str, n: int) -> int:
        """Soma n itens raros e devolve o total do período para aquele item."""
        items = self._acc(name)["items"]
        items[key] = items.get(key, 0) + n
        self._dirty = True
        self.save()
        return items[key]

    # --- persistência
    def save(self) -> None:
        self._dirty = False
        try:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf8") as fh:
                json.dump({"period": self.period, "accounts": self.accounts}, fh)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("não consegui gravar %s: %s", self.path, e)

    # --- relatório
    def has_data(self) -> bool:
        return any(a["kills"] or any(a["items"].values()) for a in self.accounts.values())

    def send_report(self, notifier: Notifier) -> None:
        fields: list[tuple[str, str, bool]] = []
        tot_xp = tot_gold = tot_kills = 0
        tot_items = {k: 0 for k in ITEM_LABELS}
        for name, a in sorted(self.accounts.items()):
            tot_xp += a["xp"]; tot_gold += a["gold"]; tot_kills += a["kills"]
            for k, v in a["items"].items():
                tot_items[k] = tot_items.get(k, 0) + v
            fields.append((name, f"⭐ XP: **{a['xp']:,}**\n💰 Ouro: **{a['gold']:,}**\n"
                                 f"⚔️ Kills: {a['kills']:,}\n💎 Raros: {_items_text(a['items'])}", True))
        if len(self.accounts) > 1:
            fields.append(("Total", f"⭐ XP: **{tot_xp:,}**\n💰 Ouro: **{tot_gold:,}**\n"
                                    f"⚔️ Kills: {tot_kills:,}\n💎 Raros: {_items_text(tot_items)}", False))
        notifier.send(f"📊 Relatório diário — {_br_date(self.period)}",
                      "Resumo do dia por conta." if fields else "Sem atividade no período.",
                      BLUE, fields)

    def roll_over(self, notifier: Notifier) -> None:
        """Se o período mudou: envia o relatório do anterior e zera."""
        now_period = self.current_period()
        if now_period == self.period:
            return
        if self.has_data():
            self.send_report(notifier)
        self.period = now_period
        self.accounts = {}
        self.save()

    async def run(self, notifier: Notifier) -> None:
        while True:
            self.roll_over(notifier)
            if self._dirty:
                self.save()
            await asyncio.sleep(30)


_ACC_PREFIX = re.compile(r"^ACC\d+:(.+)$")


def _migrate_account_keys(accounts: dict) -> dict:
    """Normaliza chaves antigas "ACCn:nick" (de antes da correção do webhook)
    para o nick puro, mesclando com uma entrada "nick" já existente no mesmo
    período, se houver."""
    out: dict = {}
    for name, a in accounts.items():
        m = _ACC_PREFIX.match(name)
        key = m.group(1) if m else name
        if key not in out:
            out[key] = a
            continue
        prev = out[key]
        prev["xp"] += a.get("xp", 0)
        prev["gold"] += a.get("gold", 0)
        prev["kills"] += a.get("kills", 0)
        for k, v in (a.get("items") or {}).items():
            prev.setdefault("items", {})[k] = prev.get("items", {}).get(k, 0) + v
    return out


def _items_text(items: dict) -> str:
    parts = [f"{ITEM_LABELS.get(k, k)} ×{v}" for k, v in items.items() if v]
    return ", ".join(parts) if parts else "nenhum"


def _br_date(period: str) -> str:
    try:
        y, m, d = period.split("-")
        return f"{d}/{m}/{y}"
    except ValueError:
        return period


def _load_tz(name: str) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - sem tzdata: usa UTC-3 fixo
        log.warning("fuso %s indisponível; usando UTC-3", name)
        return timezone(timedelta(hours=-3))
