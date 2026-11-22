# PokéIdle Manager Online

Gerenciador headless em Python (FastAPI + WebSockets) com dashboard web em React/TypeScript para administrar até **4 contas simultâneas** do jogo **pokeidle.io** em background — ideal para rodar 24/7 em container Docker (**Dokploy** / VPS Linux) ou localmente no Windows/Linux/macOS.

> **Aviso Legal:** Projeto independente e não oficial, sem vínculo com o pokeidle.io.
> Segundo os [Termos de Uso do jogo](https://pokeidle.io/terms#conduta), cada pessoa pode ter no máximo **4 contas** no total (e até 4 conexões por IP/rede). Por isso o sistema possui trava rígida de no máximo **4 contas**. O uso é de inteira responsabilidade do usuário.

---

## Principais Recursos

- **Gestão Multi-Conta (até 4 contas):**
  - Conexão WebSocket persistente por conta com heartbeat, watchdog anti-travamento e reconexão inteligente.
  - Suporte a **Proxy dedicado por conta** (`SOCKS5`, `SOCKS5h`, `SOCKS4`, `HTTP`, `HTTPS`) com verificador de IP de saída (`api.ipify.org`).
  - Pausa automática (cooldown configurável) ao detectar login externo (`close code 4001`) e bloqueio automático em caso de sessão expirada/ban, evitando reconexões em loop.
  - Renovação e persistência automática de tokens de sessão (`sessao.renovada`).
- **Automação de Hunt, Captura e Loja:**
  - Seleção de qualquer hunt/mapa do jogo (incluindo troca de nível/tier de **Outland 1 a 8**). Se a conta estiver em combate, a troca entra na fila e executa automaticamente assim que a trava (`centroLivreEm`) termina.
  - Captura automática de cadáveres (`ball.throw`) respeitando janela e cooldown do servidor.
  - Reposição automática de **Poções** e **Balls** equipadas na loja NPC (`shop.buy`).
  - Recomendador **"Melhor Hunt"** integrado ao motor de simulação em Web Worker isolado.
- **Múltiplos Gateways de Notificação (Discord e/ou Telegram):**
  - Envio de alertas em tempo real para **Discord** (Webhook), **Telegram** (Bot API em HTML) ou **ambos simultaneamente**, com chaves independentes para ativar/pausar cada gateway.
  - Alertas de queda/retorno de conta, captura/encontro de **Shiny**, drop de **Itens Raros**, compras do Sniper, oportunidades de venda acima da média, anúncios vendidos e **Relatório Diário** consolidado.
  - O Telegram também avisa cada captura comum bem-sucedida. Os alertas identificam a conta pelo nick. Bloqueios no login são avisados mesmo antes de a conta entrar pela primeira vez.
- **Mercado da Comunidade, Análise e Sniper:**
  - Visão geral de preços mínimos e médias de 7 dias (Gold e Gemas), vitrine de Pokémon com filtros avançados, histórico global com busca por sugestões e extrato de compras/vendas.
  - **Análise do Mercado (24h, 7d e 30d):** coleta contínua de vendas do servidor no SQLite local combinada ao histórico do `pokeidleguide.io` (com fallback automático), exibindo itens/Pokémons mais vendidos, mediana e quartis de preço, maiores altas/quedas, índice de inflação e horários de pico.
  - **Sniper de Mercado** (desligado por padrão) com teto de preço fixo ou percentual abaixo da média, orçamento diário individual por conta, sincronização com o relógio do servidor e disputa simultânea no sorteio de liberação.
  - **Carteira somente leitura:** consulta saldo e extrato de Gemas sem implementar comandos de saque (`orbs.sacar`) ou transferência de Coins (`banco.coins`).
- **Dashboard Personalizável, PVP Ranqueado, Passe, Chat e Ficha Completa:**
  - **Medidores de XP e Modelos de Card:** progresso em tempo real e estimativa de tempo para subir de nível tanto do treinador quanto do Pokémon equipado, com 4 estilos visuais em Configurações (*Padrão*, *Medalhão*, *Versus* e *Corrida*) e troca instantânea do idioma dos itens (*PT*, *EN*, *ES*).
  - **PVP Ranqueado:** fila automática para qualquer conta, histórico de partidas da sessão, editor visual de equipe com tabuleiro de posicionamento, ranking Top 1.000 e Top PVP Mensal.
  - **Ficha e Calculadora de Pokémon:** inspeção completa de IVs, stats, evolução, nota de nascença (0 a 10), projeção na evolução final e poder PVE/PVP (para Pokémons próprios, do mercado ou compartilhados no chat).
  - **Passe de Batalha:** visualização da trilha de 30 dias e resgate diário com um clique.
  - **Chat em Tempo Real:** leitura unificada e envio de mensagens nos canais públicos (*Mundo*, *Comércio*, *Dúvidas*) com modo janela flutuante (*Picture-in-Picture*).

---

## Deploy no Dokploy (Domínio HTTPS + Secret de Proteção)

O projeto já vem pré-configurado para rodar em container no **Dokploy**, exposto por um domínio **HTTPS** (via Traefik + Let's Encrypt) e protegido por um **Secret (`TELEMETRY_TOKEN`)** desde o primeiro boot.

Veja o guia detalhado em **[`dokploy/README.md`](dokploy/README.md)**.

### Como funciona a proteção por Secret (`TELEMETRY_TOKEN`)

Quando `TELEMETRY_TOKEN` é definido nas variáveis de ambiente:
1. O painel **desativa o modo de setup aberto** — ninguém consegue acessar o seu domínio público para cadastrar uma senha antes de você.
2. O próprio `TELEMETRY_TOKEN` funciona como **senha de login** no navegador e como token `Authorization: Bearer` para automações/API.
3. Após entrar no painel com o secret, você também pode definir uma senha própria em **Configurações → Segurança**.

### Passo a passo rápido no Dokploy (Modo Compose)

1. Crie um serviço **Compose** no Dokploy conectado a este repositório e defina o **Compose Path** como:
   ```text
   docker-compose.dokploy.yml
   ```
2. Na aba **Environment**, defina apenas o secret de proteção e o seu domínio (todo o resto — contas, proxies, **Discord e Telegram** — é configurado diretamente na interface do Dashboard):
   ```env
   TELEMETRY_TOKEN=coloque-aqui-um-secret-forte-de-32-caracteres
   PUBLIC_URL=https://pokeidle.seudominio.com
   ```
3. Na aba **Domains**, adicione o seu domínio apontando para o serviço `pokeidle` na porta **`8080`** com **HTTPS (Let's Encrypt)** ativado.
4. Clique em **Deploy**. Todos os dados (banco SQLite `app.db`, sessões e estatísticas diárias) ficam persistidos no volume `/data`.

> Também está disponível o template automático do Dokploy em [`dokploy/template.toml`](dokploy/template.toml) + [`dokploy/docker-compose.yml`](dokploy/docker-compose.yml), que gera o `TELEMETRY_TOKEN` automaticamente (`${password:32}`) e provisiona o domínio HTTPS.

---

## Rodando com Docker Compose (Local ou VPS)

```bash
cp .env.example .env
# Edite o .env e defina TELEMETRY_TOKEN (e PUBLIC_URL se usar proxy reverso HTTPS)
docker compose up -d --build
```

- Por padrão, [`docker-compose.yml`](docker-compose.yml) faz bind apenas em `127.0.0.1:8080:8080` (para uso com túnel SSH ou proxy reverso local). Para expor em todas as interfaces, defina `BIND_HOST=0.0.0.0`.
- Os dados ficam salvos no volume `pokeidle-data` montado em `/data`.

---

## Instalação Local (Sem Docker)

Guia passo a passo completo para Windows, Linux, macOS, systemd e Android/Termux em **[`INSTALACAO.md`](INSTALACAO.md)**.

```bash
git clone https://github.com/adryansf/pokeidle-manager-online.git pokeidle
cd pokeidle
./iniciar.sh          # No Windows: dê dois cliques em iniciar.bat
```

O script cria o ambiente virtual Python (3.12+), instala as dependências, compila o dashboard React e inicia o servidor em `http://localhost:8080`.

---

## Configurando Notificações (Discord e/ou Telegram)

No painel, acesse **Configurações → Geral**:

- **Gateway: Discord**
  - Cole a URL do Webhook do seu canal (`https://discord.com/api/webhooks/...`) e clique em **Salvar**.
  - Use a caixa de seleção para ativar/pausar os envios e o botão **Enviar teste** para validar.
- **Gateway: Telegram**
  - Crie um bot no Telegram conversando com o [`@BotFather`](https://t.me/BotFather) (`/newbot`) e copie o **Token do Bot** (`123456789:ABCdef...`).
  - Obtenha o **Chat ID** da sua conta pessoal, grupo ou canal (ex.: `123456789`, `-1001234567890` ou `@meucanal`).
  - Salve no painel e clique em **Enviar teste**.
- Você pode deixar **apenas o Discord**, **apenas o Telegram** ou **os dois ativos ao mesmo tempo**.

---

## Segurança e Arquitetura

- **Autenticação e Sessão:** Senha com hash `scrypt` + sal aleatório; sessões armazenadas apenas como hash `SHA-256` no banco e entregues em cookie `HttpOnly`, `SameSite=Strict` e `Secure` (automático sob HTTPS / `X-Forwarded-Proto: https`).
- **Secret de Proteção (`TELEMETRY_TOKEN`):** Elimina a janela de setup inicial em deploys públicos e permite autenticação via header `Authorization: Bearer` com comparação em tempo constante (`hmac.compare_digest`).
- **Rate-Limit Consciente de Proxy (`TRUST_PROXY=1`):** Limite de 10 falhas por minuto por IP real do cliente (lendo `X-Forwarded-For` apenas quando a conexão vem de loopback ou da rede privada do proxy Docker/Traefik).
- **Proteção contra Vazamento de Tokens:**
  - Tokens de contas, senhas de proxy e token do bot do Telegram jamais retornam pela API (apenas dicas mascaradas como `…3456`).
  - A URL do servidor WebSocket (`ws_url`) é validada contra uma *allowlist* oficial (`wss://pokeidle.io`), impedindo que alterações pela API redirecionem o handshake `hello` para servidores externos.
- **Proteção CSRF, CSWSH e Isolamento de Worker:**
  - Validação estrita do cabeçalho `Origin` (compatível com `X-Forwarded-Host`) em todas as rotas HTTP mutáveis (`POST`, `PUT`, `PATCH`, `DELETE`) e conexões WebSocket (`/ws/telemetry`, `/ws/chat`).
  - O Web Worker da calculadora de hunt (`hunt-worker.js`) roda sob Content-Security-Policy restrita com `sandbox allow-scripts` e sem acesso a `caches` ou `indexedDB`.

---

## Licença

Distribuído sob a licença [GNU AGPL-3.0](LICENSE).
