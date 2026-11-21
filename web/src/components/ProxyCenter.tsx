import { Check, Download, Globe, Layers, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Check2, Labeled, Modal, Notice } from "@/components/SettingsView";
import { ConfirmDialog } from "@/components/ui";
import { admin, type AdminAccount, type SavedProxy } from "@/lib/admin";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Erro inesperado");
const SCHEMES = ["socks5", "socks5h", "http", "https", "socks4"];

interface FormState {
  name: string;
  scheme: string;
  host: string;
  port: string;
  username: string;
  password: string;
  notes: string;
  syncAccounts: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  scheme: "socks5",
  host: "",
  port: "",
  username: "",
  password: "",
  notes: "",
  syncAccounts: true,
};

function fmtTested(ts: number | null) {
  if (!ts) return "nunca testado";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

/** Seletor rápido da Central de Proxies usado em Adicionar/Editar conta. */
export function ProxyPicker({
  selectedId,
  onSelect,
}: {
  selectedId: number | null;
  onSelect: (p: SavedProxy | null) => void;
}) {
  const [proxies, setProxies] = useState<SavedProxy[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    admin
      .proxies()
      .then((r) => {
        if (alive) {
          setProxies(r.proxies);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded || proxies.length === 0) return null;

  return (
    <div className="space-y-1.5 rounded-lg border border-edge/50 bg-void/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-poke-gold">
          <Globe className="size-3.5" aria-hidden />
          Central de Proxies ({proxies.length})
        </span>
        {selectedId !== null && (
          <button type="button" className="text-xs font-semibold text-mute underline hover:text-fg" onClick={() => onSelect(null)}>
            Editar manualmente
          </button>
        )}
      </div>
      <select
        className="field w-full text-sm"
        value={selectedId ?? ""}
        onChange={(e) => {
          const val = e.target.value;
          if (!val) return onSelect(null);
          const found = proxies.find((p) => p.id === Number(val)) ?? null;
          onSelect(found);
        }}
      >
        <option value="">— Escolher um proxy salvo da Central —</option>
        {proxies.map((p) => {
          const statusIcon = p.lastOk === true ? "🟢" : p.lastOk === false ? "🔴" : "⚪";
          const used = p.usedBy.length > 0 ? ` · em uso: ${p.usedBy.map((u) => u.nick).join(", ")}` : " · livre";
          return (
            <option key={p.id} value={p.id}>
              {statusIcon} {p.name} ({p.scheme}://{p.host}:{p.port}){used}
            </option>
          );
        })}
      </select>
      {selectedId !== null && (
        <p className="text-xs text-poke-green">
          Proxy da Central selecionado — credenciais salvas serão aplicadas automaticamente.
        </p>
      )}
    </div>
  );
}

/** Central de Proxies: cadastro individual, importação em lote, teste em massa e atribuição rápida às contas. */
export function ProxyCenterSection({
  accounts: externalAccounts,
  onAccountsChanged,
}: {
  accounts?: AdminAccount[];
  onAccountsChanged?: () => void;
}) {
  const [proxies, setProxies] = useState<SavedProxy[]>([]);
  const [accounts, setAccounts] = useState<AdminAccount[]>(externalAccounts ?? []);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [mode, setMode] = useState<"none" | "new" | "edit" | "bulk">("none");
  const [editing, setEditing] = useState<SavedProxy | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [bulkText, setBulkText] = useState("");
  const [bulkScheme, setBulkScheme] = useState("socks5");
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<number | "all" | null>(null);
  const [assignBusyId, setAssignBusyId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedProxy | null>(null);

  useEffect(() => {
    if (externalAccounts) setAccounts(externalAccounts);
  }, [externalAccounts]);

  const load = useCallback(async () => {
    try {
      const [pr, ac] = await Promise.all([
        admin.proxies(),
        externalAccounts ? Promise.resolve(null) : admin.accounts(),
      ]);
      setProxies(pr.proxies);
      if (ac) setAccounts(ac.accounts);
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setLoading(false);
    }
  }, [externalAccounts]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setMode("new");
    setMsg(null);
  };

  const openEdit = (p: SavedProxy) => {
    setEditing(p);
    setForm({
      name: p.rawName || "",
      scheme: p.scheme,
      host: p.host,
      port: String(p.port),
      username: p.username,
      password: "",
      notes: p.notes || "",
      syncAccounts: true,
    });
    setMode("edit");
    setMsg(null);
  };

  const saveForm = async () => {
    if (!form.host.trim() || !Number(form.port)) {
      setMsg({ tone: "error", text: "Preencha pelo menos o host e a porta do proxy." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "edit" && editing) {
        const r = await admin.updateProxy(editing.id, {
          name: form.name,
          scheme: form.scheme,
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username,
          password: form.password === "" ? null : form.password,
          notes: form.notes,
          sync_accounts: form.syncAccounts,
        });
        setMsg({
          tone: "ok",
          text:
            r.syncedAccounts > 0
              ? `Proxy atualizado e sincronizado em ${r.syncedAccounts} conta(s).`
              : "Proxy atualizado.",
        });
        if (r.syncedAccounts > 0) onAccountsChanged?.();
      } else {
        await admin.createProxy({
          name: form.name,
          scheme: form.scheme,
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username,
          password: form.password,
          notes: form.notes,
        });
        setMsg({ tone: "ok", text: "Proxy salvo na Central." });
      }
      setMode("none");
      setEditing(null);
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const runBulk = async () => {
    if (!bulkText.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await admin.bulkImportProxies(bulkText, bulkScheme);
      setProxies(r.proxies);
      setBulkText("");
      setMode("none");
      const extra = r.errors.length > 0 ? ` (${r.errors.length} linha(s) com erro: ${r.errors[0]})` : "";
      setMsg({
        tone: r.errors.length > 0 && r.added === 0 ? "error" : r.errors.length > 0 ? "warn" : "ok",
        text: `${r.added} proxy(s) importado(s), ${r.skipped} já existiam.${extra}`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const importFromAccounts = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await admin.importProxiesFromAccounts();
      setProxies(r.proxies);
      setMsg({
        tone: r.added > 0 ? "ok" : "warn",
        text: r.added > 0 ? `${r.added} proxy(s) puxado(s) das contas para a Central.` : "Todos os proxies das contas já estavam na Central.",
      });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const testOne = async (p: SavedProxy) => {
    setTestingId(p.id);
    setMsg(null);
    try {
      const r = await admin.testSavedProxy(p.id);
      setProxies((prev) => prev.map((x) => (x.id === p.id ? r.proxy : x)));
      setMsg({
        tone: r.ok ? "ok" : "error",
        text: r.ok
          ? `${p.name}: online · IP ${r.ip}${r.latencyMs ? ` (${r.latencyMs}ms)` : ""}`
          : `${p.name}: ${r.detail || "falhou"}`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setTestingId(null);
    }
  };

  const testAll = async () => {
    setTestingId("all");
    setMsg(null);
    try {
      const r = await admin.testAllProxies();
      setProxies(r.proxies);
      const okCount = r.proxies.filter((x) => x.lastOk === true).length;
      setMsg({
        tone: okCount === r.proxies.length ? "ok" : "warn",
        text: `Teste finalizado: ${okCount}/${r.proxies.length} proxy(s) respondendo.`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setTestingId(null);
    }
  };

  const assignTo = async (p: SavedProxy, target: string) => {
    if (!target) return;
    const ids = target === "all" ? accounts.map((a) => a.numericId) : [Number(target)];
    if (ids.length === 0) return;
    setAssignBusyId(p.id);
    setMsg(null);
    try {
      const r = await admin.assignProxy(p.id, ids);
      await load();
      onAccountsChanged?.();
      setMsg({
        tone: "ok",
        text: `Proxy "${p.name}" aplicado em ${r.applied.length} conta(s) e reconexão iniciada.`,
      });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setAssignBusyId(null);
    }
  };

  const removeProxy = async (p: SavedProxy) => {
    setBusy(true);
    try {
      await admin.deleteProxy(p.id);
      setConfirmDelete(null);
      await load();
      setMsg({ tone: "ok", text: `Proxy "${p.name}" removido da Central.` });
    } catch (e) {
      setMsg({ tone: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const okCount = proxies.filter((p) => p.lastOk === true).length;
  const hasAccountsWithProxy = accounts.some((a) => !!a.proxy);

  return (
    <div className="space-y-3">
      {/* Barra de ações */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-mute sm:text-sm">
          <span className="tnum font-bold text-fg">{proxies.length}</span> salvo(s)
          {proxies.length > 0 && (
            <>
              {" · "}
              <span className="tnum font-semibold text-poke-green">{okCount} funcionando</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn" data-active={mode === "new"} onClick={() => (mode === "new" ? setMode("none") : openNew())}>
            <Plus className="size-4" aria-hidden />
            Novo proxy
          </button>
          <button
            type="button"
            className="btn"
            data-active={mode === "bulk"}
            onClick={() => {
              setMode(mode === "bulk" ? "none" : "bulk");
              setMsg(null);
            }}
          >
            <Upload className="size-4" aria-hidden />
            Importar lista
          </button>
          {hasAccountsWithProxy && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void importFromAccounts()}
              title="Salva na Central os proxies que já estão configurados nas suas contas"
            >
              <Download className="size-4" aria-hidden />
              Puxar das contas
            </button>
          )}
          {proxies.length > 0 && (
            <button
              type="button"
              className="btn"
              disabled={testingId !== null}
              onClick={() => void testAll()}
            >
              <RefreshCw className={`size-4 ${testingId === "all" ? "animate-spin" : ""}`} aria-hidden />
              {testingId === "all" ? "Testando…" : "Testar todos"}
            </button>
          )}
        </div>
      </div>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* Formulário: Importar lista em lote */}
      {mode === "bulk" && (
        <div className="space-y-3 rounded-xl border border-edge/60 bg-black/25 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide text-poke-gold">
              <Layers className="size-4" aria-hidden />
              Importar vários proxies de uma vez
            </h3>
            <label className="flex items-center gap-2 text-xs text-mute">
              Tipo padrão:
              <select className="field py-1 text-xs" value={bulkScheme} onChange={(e) => setBulkScheme(e.target.value)}>
                {SCHEMES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-mute">
            Cole um proxy por linha. Aceita <code>host:porta:usuario:senha</code>,{" "}
            <code>socks5://usuario:senha@host:porta</code>, <code>usuario:senha@host:porta</code> ou{" "}
            <code>host:porta</code>. Você pode colocar <code># Apelido</code> no final da linha.
          </p>
          <textarea
            className="field h-28 w-full resize-y py-2 font-mono text-xs"
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"185.12.34.56:1080:usuario:senha # ISP SP 1\nsocks5://user:pass@proxy.exemplo.com:1080 # ISP RJ"}
            spellCheck={false}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setMode("none")} disabled={busy}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn border-0 bg-poke-gold font-bold text-void hover:bg-[#f6ca5e]"
              onClick={() => void runBulk()}
              disabled={busy || !bulkText.trim()}
            >
              {busy ? "Importando…" : "Importar proxies"}
            </button>
          </div>
        </div>
      )}

      {/* Formulário: Novo / Editar proxy */}
      {(mode === "new" || mode === "edit") && (
        <div className="space-y-3 rounded-xl border border-edge/60 bg-black/25 p-3.5">
          <h3 className="text-sm font-bold uppercase tracking-wide text-poke-gold">
            {mode === "edit" ? `Editar proxy: ${editing?.name}` : "Cadastrar novo proxy"}
          </h3>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-6">
            <div className="sm:col-span-3">
              <Labeled label="Apelido (opcional)">
                <input
                  className="field w-full"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex.: ISP Brasil 1"
                />
              </Labeled>
            </div>
            <div className="sm:col-span-3">
              <Labeled label="Observação (opcional)">
                <input
                  className="field w-full"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Ex.: Webshare vence dia 15"
                />
              </Labeled>
            </div>
            <div className="sm:col-span-2">
              <Labeled label="Tipo">
                <select className="field w-full" value={form.scheme} onChange={(e) => setForm({ ...form, scheme: e.target.value })}>
                  {SCHEMES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Labeled>
            </div>
            <div className="sm:col-span-3">
              <Labeled label="Host / IP">
                <input
                  className="field w-full"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="proxy.exemplo.com"
                  autoComplete="off"
                />
              </Labeled>
            </div>
            <div className="sm:col-span-1">
              <Labeled label="Porta">
                <input
                  className="field w-full"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, "") })}
                  placeholder="1080"
                />
              </Labeled>
            </div>
            <div className="sm:col-span-3">
              <Labeled label="Usuário">
                <input
                  className="field w-full"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="off"
                />
              </Labeled>
            </div>
            <div className="sm:col-span-3">
              <Labeled label="Senha">
                <input
                  className="field w-full"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={mode === "edit" && editing?.hasPassword ? "(mantém a atual)" : ""}
                  autoComplete="new-password"
                />
              </Labeled>
            </div>
          </div>
          {mode === "edit" && (editing?.usedBy.length ?? 0) > 0 && (
            <Check2 checked={form.syncAccounts} onChange={(v) => setForm({ ...form, syncAccounts: v })}>
              Atualizar e reconectar automaticamente as contas que usam este proxy (
              {editing!.usedBy.map((u) => u.nick).join(", ")})
            </Check2>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setMode("none")} disabled={busy}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn border-0 bg-poke-gold font-bold text-void hover:bg-[#f6ca5e]"
              onClick={() => void saveForm()}
              disabled={busy}
            >
              {busy ? "Salvando…" : mode === "edit" ? "Salvar alterações" : "Salvar proxy"}
            </button>
          </div>
        </div>
      )}

      {/* Lista de proxies */}
      {loading ? (
        <p className="text-sm text-mute">Carregando proxies…</p>
      ) : proxies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-mute">
          Nenhum proxy salvo na Central ainda.
          <br />
          Clique em <b>Novo proxy</b> ou <b>Importar lista</b> para salvar seus proxies uma única vez e aplicar nas contas com 1 clique.
        </div>
      ) : (
        <div className="space-y-2">
          {proxies.map((p) => {
            const dotCls =
              p.lastOk === true
                ? "bg-poke-green"
                : p.lastOk === false
                  ? "bg-poke-red"
                  : "bg-mute/60";
            const isTesting = testingId === p.id || testingId === "all";
            const isAssigning = assignBusyId === p.id;
            return (
              <div key={p.id} className="rounded-xl border border-line bg-tile p-3">
                <div className="flex flex-wrap items-start justify-between gap-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`size-2.5 shrink-0 rounded-full ${dotCls}`}
                        title={p.lastOk === true ? "Online" : p.lastOk === false ? "Falhou no último teste" : "Não testado"}
                      />
                      <span className="truncate text-sm font-extrabold sm:text-base">{p.name}</span>
                      <span className="rounded border border-line bg-void px-1.5 py-0.5 font-mono text-[11px] text-mute">
                        {p.scheme}://{p.host}:{p.port}
                      </span>
                      {p.username && (
                        <span className="text-xs text-mute">
                          usuário: <b className="text-fg">{p.username}</b>
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute">
                      {p.lastOk === true && (
                        <span className="flex items-center gap-1 text-poke-green">
                          <Check className="size-3.5" aria-hidden />
                          IP de saída: <b className="tnum">{p.lastIp}</b> ({fmtTested(p.lastTestedAt)})
                        </span>
                      )}
                      {p.lastOk === false && (
                        <span className="text-poke-red">
                          {p.lastError || "Falhou"} ({fmtTested(p.lastTestedAt)})
                        </span>
                      )}
                      {p.lastOk === null && <span>Não testado ainda</span>}
                      {p.notes && <span className="italic">· {p.notes}</span>}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {p.usedBy.length > 0 ? (
                        p.usedBy.map((u) => (
                          <span
                            key={u.id}
                            className="inline-flex items-center gap-1 rounded-md border border-[#2f6b3a] bg-[#16301c] px-2 py-0.5 text-[11px] font-bold text-poke-green"
                          >
                            <ShieldCheck className="size-3" aria-hidden />
                            {u.nick}
                          </span>
                        ))
                      ) : (
                        <span className="rounded-md border border-line bg-void px-2 py-0.5 text-[11px] font-semibold text-mute">
                          Disponível (livre)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Ações do proxy */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {accounts.length > 0 && (
                      <select
                        className="field h-9 py-1 text-xs font-semibold"
                        value=""
                        disabled={isAssigning}
                        aria-label={`Aplicar ${p.name} em uma conta`}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) void assignTo(p, v);
                        }}
                      >
                        <option value="">{isAssigning ? "Aplicando…" : "Aplicar na conta…"}</option>
                        {accounts.map((a) => (
                          <option key={a.numericId} value={a.numericId}>
                            → {a.nick}
                          </option>
                        ))}
                        {accounts.length > 1 && <option value="all">→ Todas as contas ({accounts.length})</option>}
                      </select>
                    )}
                    <button
                      type="button"
                      className="btn h-9 px-2.5 text-xs"
                      disabled={isTesting}
                      onClick={() => void testOne(p)}
                      title="Testar conexão e descobrir IP de saída"
                    >
                      <RefreshCw className={`size-3.5 ${isTesting ? "animate-spin" : ""}`} aria-hidden />
                      Testar
                    </button>
                    <button
                      type="button"
                      className="btn h-9 px-2.5 text-xs"
                      onClick={() => openEdit(p)}
                      title="Editar proxy"
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn h-9 px-2.5 text-xs"
                      onClick={() => setConfirmDelete(p)}
                      title="Remover da Central"
                      aria-label={`Remover ${p.name}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Remover proxy "${confirmDelete?.name ?? ""}"?`}
        message={
          confirmDelete && confirmDelete.usedBy.length > 0
            ? `Este proxy sairá da Central, mas as contas que já o utilizam (${confirmDelete.usedBy.map((u) => u.nick).join(", ")}) continuarão funcionando até você trocar o proxy delas.`
            : "O proxy será removido da Central de Proxies."
        }
        confirmLabel="Remover"
        busy={busy}
        onCancel={() => !busy && setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void removeProxy(confirmDelete)}
      />
    </div>
  );
}

/** Modal da Central de Proxies acessível em 1 clique no cabeçalho do Dashboard. */
export function ProxyCenterModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Central de Proxies" onClose={onClose} wide>
      <ProxyCenterSection />
    </Modal>
  );
}
