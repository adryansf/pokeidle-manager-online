// Worker da "Melhor hunt" (aba Mapa). Roda o motor da calculadora de hunt do PokéIdle Guide
// (https://pokeidleguide.io), carregado do site deles na hora: o código NÃO é copiado para este projeto.
//
// Segurança: este arquivo é servido com uma CSP própria (ver telemetry.py) que só permite falar com o
// site do Hub. Mesmo sendo da mesma origem do painel, o código de fora não consegue chamar a nossa API.
// Além disso, removemos o acesso ao Cache Storage (PWA) e ao IndexedDB antes de carregar qualquer módulo externo.
// Entrada: o Pokémon equipado (já com os stats do jogo) e o nível do treinador. Nada disso sai do navegador.
for (const api of ["caches", "indexedDB"]) {
  try {
    Object.defineProperty(self, api, { value: undefined, writable: false, configurable: false });
  } catch {
    /* ambiente sem a propriedade */
  }
}
const HUB = "https://pokeidleguide.io";
const BLOCO = 100;
const ZERO = { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, speed: 0 };

let pronto = null;
const carregar = () =>
  (pronto ??= (async () => {
    const [cat, hun, sim] = await Promise.all([
      import(`${HUB}/js/jogo/catalogo.js`),
      import(`${HUB}/js/jogo/hunts.js`),
      import(`${HUB}/js/jogo/simulador.js`),
    ]);
    const jogo = await cat.carregarJogo();
    const dados = await fetch(`${HUB}/data/jogo/hunts.json`, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`hunts.json: ${r.status}`);
      return r.json();
    });
    const { hunts } = hun.prepararHunts(dados, jogo);
    const bolas = (jogo.constantes?.bolas ?? []).map((b) => ({
      id: Number(b.id),
      nome: b.nome ?? b.name ?? `Bola #${b.id}`,
      catchRate: Number(b.catchRate ?? 1),
    }));
    const ovo = jogo.mod?.ovoShiny;
    const fragmento = ovo
      ? {
          nivelMin: ovo.NIVEL_MIN_FRAGMENTO_OVO_SHINY ?? 5000,
          porOvo: ovo.CUSTO_FRAGMENTOS_OVO_SHINY ?? 10,
          horasChoca: ovo.HORAS_OVO_SHINY ?? 48,
        }
      : { nivelMin: 5000, porOvo: 10, horasChoca: 48 };
    return { jogo, hunts, sim: sim.criarSimulador(jogo, hunts), bolas, fragmento };
  })().catch((e) => {
    pronto = null; // tenta de novo na próxima vez
    throw e;
  }));

const leve = (l) => ({
  slug: l.slug,
  nome: l.nome,
  regiao: l.regiao ?? null,
  nivel: l.nivel ?? 1,
  liberada: !!l.liberada,
  inviavel: !!l.inviavel,
  motivo: l.motivo ?? null,
  xpPokemonH: l.xpPokemonH ?? 0,
  xpTreinadorH: l.xpTreinadorH ?? 0,
  ouroH: l.ouroH ?? 0,
  kph: l.kph ?? 0,
  kphFaixa: Array.isArray(l.kphFaixa) ? l.kphFaixa : null,
  ttk: Number.isFinite(l.ttk) ? l.ttk : null,
  mortesH: l.mortesH ?? 0,
  umHit: !!l.umHit,
  hitPct: l.hitPct ?? 0,
  ritmo: l.ritmo ?? null,
  mapa: l.mapa ?? null,
  aoe: l.aoe ? (typeof l.aoe === "object" ? l.aoe : { estimado: false }) : null,
  melhorGolpe: l.melhorGolpe ?? null,
  efetividade: l.efetividade ?? 1,
  capturaChance: l.capturaChance ?? null,
  capturasH: l.capturasH ?? 0,
  shinyChance: l.shinyChance ?? null,
  shinyH: l.shinyH ?? 0,
  fragmentoChance: l.fragmentoChance ?? 0,
  fragmentoH: l.fragmentoH ?? 0,
});

async function calcular({ sheet, nivelTreinador, opcoes = {} }) {
  const d = await carregar();
  const esp = d.jogo.especies.get(sheet.speciesId);
  if (!esp) throw new Error(`a espécie #${sheet.speciesId} não está no catálogo do PokéIdle Guide`);
  const refino = { ...ZERO, ...(sheet.refino || {}) };
  const tmAoe = opcoes.aoe != null ? !!opcoes.aoe : !!sheet.tmAoe;
  const comPocao = opcoes.comPocao != null ? !!opcoes.comPocao : sheet.comPocao ?? true;
  const tipoDoDia = opcoes.tipoDoDia !== undefined ? (opcoes.tipoDoDia || null) : (sheet.tipoDoDia || null);
  const escudo = Boolean(tipoDoDia && (opcoes.escudo != null ? !!opcoes.escudo : !!sheet.escudo));
  const bola = opcoes.bola != null ? Number(opcoes.bola) : (sheet.ballId != null ? Number(sheet.ballId) : null);

  const pokemon = {
    esp,
    nascimento: {
      ivs: { ...sheet.ivs },
      qualidade: sheet.quality,
      potencia: sheet.potencia,
      shiny: !!sheet.shiny,
      refino,
    },
    statsInformados: { ...sheet.stats },
    nivelDosStats: sheet.level,
    tmAoe,
  };
  let linhas = [];
  let capturaInfo = null;
  for (let i = 0; i < d.hunts.length; i += BLOCO) {
    const r = d.sim.analisarHunts({
      pokemon,
      nivelPokemon: sheet.level,
      nivelTreinador,
      hunts: d.hunts.slice(i, i + BLOCO),
      soLiberadas: false,
      comPocao,
      tipoDoDia,
      escudo,
      bola,
    });
    if (!capturaInfo && r.captura) capturaInfo = r.captura;
    linhas = linhas.concat(r.linhas.map(leve));
  }
  return {
    versao: d.jogo.versao ?? null,
    total: linhas.length,
    linhas,
    bolas: d.bolas,
    fragmento: d.fragmento,
    captura: capturaInfo ? { bola: capturaInfo.bola, chanceShiny: capturaInfo.chanceShiny } : null,
  };
}

self.onmessage = async ({ data }) => {
  const { id, entrada } = data;
  try {
    self.postMessage({ id, ok: true, dados: await calcular(entrada) });
  } catch (err) {
    self.postMessage({ id, ok: false, erro: String(err?.message ?? err) });
  }
};
