/**
 * Navegação entre abas pelo hash (#inventario, #capturas...). O parâmetro opcional `conta`
 * pré-seleciona a conta no filtro da aba (ex.: "#capturas?conta=acc3"); o App lê e limpa.
 */
export function goToTab(tab: string, account?: string) {
  location.hash = account ? `${tab}?conta=${encodeURIComponent(account)}` : tab;
}

/** Separa "#capturas?conta=acc3" em { tab: "capturas", account: "acc3" }. */
export function parseHash(hash = location.hash): { tab: string; account: string | null } {
  const raw = hash.replace(/^#/, "");
  const [tab, query = ""] = raw.split("?");
  return { tab, account: new URLSearchParams(query).get("conta") };
}
