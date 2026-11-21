# Deploy no Dokploy (HTTPS + Secret de Proteção)

Este projeto já está preparado para rodar no **Dokploy** atrás de um domínio **HTTPS** (Traefik + Let's Encrypt) e protegido desde o primeiro segundo por um **Secret (`TELEMETRY_TOKEN`)**.

---

## Como funciona a proteção por Secret (`TELEMETRY_TOKEN`) + HTTPS

1. **Bloqueio imediato contra acesso não autorizado:** Quando a variável `TELEMETRY_TOKEN` é definida no Dokploy, o painel **nunca** entra no modo de configuração inicial aberta (`setup`). Desde o primeiro boot, qualquer requisição exige autenticação.
2. **Login no painel:** Ao abrir `https://seu-dominio.com`, basta digitar o valor de `TELEMETRY_TOKEN` no campo **Senha** (ou definir uma senha própria depois em **Configurações → Segurança**, mantendo o `TELEMETRY_TOKEN` válido para scripts via `Authorization: Bearer`).
3. **Cookies seguros e Proxy Reverso:** Com `TRUST_PROXY=1` (já ativo no container), o backend reconhece automaticamente `X-Forwarded-Proto: https`, `X-Forwarded-Host` e `X-Forwarded-For` do Traefik do Dokploy:
   - O cookie de sessão (`pokeidle_session`) recebe automaticamente a flag `Secure`, além de `HttpOnly` e `SameSite=Strict`.
   - O limite de tentativas de login (rate-limit anti brute-force) é contabilizado pelo IP real de cada visitante externo, e não pelo IP interno do container do Traefik.
   - A validação de `Origin` (proteção contra CSRF e CSWSH nos WebSockets) valida o domínio público configurado.

---

## Opção 1: Deploy via Docker Compose no Dokploy (Recomendado)

1. No painel do **Dokploy**, crie um novo serviço do tipo **Compose**.
2. Conecte ao seu repositório Git e defina o **Compose Path** como:
   ```text
   docker-compose.dokploy.yml
   ```
3. Na aba **Environment** do serviço no Dokploy, adicione:
   ```env
   TELEMETRY_TOKEN=seu-secret-forte-de-32-caracteres-aqui
   PUBLIC_URL=https://pokeidle.seudominio.com
   REPORT_TZ=America/Sao_Paulo
   DAILY_REPORT_HOUR=0
   # Opcionais (também podem ser configurados depois pela interface web do painel):
   DISCORD_WEBHOOK_URL=
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   ```
   > **Nota:** `docker-compose.dokploy.yml` exige que `TELEMETRY_TOKEN` esteja preenchido (`${TELEMETRY_TOKEN:?...}`). Se estiver vazio, o deploy falha propositalmente para evitar que o painel suba sem senha na internet.
4. Na aba **Domains** do Dokploy:
   - **Service Name:** `pokeidle`
   - **Host:** `pokeidle.seudominio.com`
   - **Container Port:** `8080`
   - **HTTPS:** Ativado (`Let's Encrypt`)
5. Clique em **Deploy**.

---

## Opção 2: Deploy via Application (Dockerfile) no Dokploy

1. Crie uma **Application** no Dokploy apontando para o repositório (Build Type: `Dockerfile`, Dockerfile: `Dockerfile`).
2. Em **Environment**, configure:
   ```env
   TELEMETRY_TOKEN=seu-secret-forte-de-32-caracteres-aqui
   PUBLIC_URL=https://pokeidle.seudominio.com
   ```
3. Em **Mounts / Volumes**, adicione um Volume para persistir o banco SQLite (`app.db`) e as estatísticas das sessões:
   - **Type:** `Volume`
   - **Volume Name:** `pokeidle-data`
   - **Mount Path (Container):** `/data`
4. Em **Domains**, aponte seu domínio HTTPS para a porta `8080`.
5. Clique em **Deploy**.

---

## Opção 3: Template Automático do Dokploy (`dokploy/template.toml`)

Os arquivos [`dokploy/template.toml`](template.toml) e [`dokploy/docker-compose.yml`](docker-compose.yml) seguem a especificação de templates do Dokploy:
- Geram automaticamente `TELEMETRY_TOKEN` com `${password:32}`.
- Configuram `PUBLIC_URL=https://${main_domain}`.
- Provisionam o domínio com HTTPS (`certificateType = "letsencrypt"`) apontando para o serviço `pokeidle` na porta `8080`.
