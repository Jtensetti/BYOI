# BYOI – Bring Your Own Integration

Koppla in valfritt system och prata med det via chatt. Produkten har tre lager:

```
 1. INPUT – universalport            2. KÄRNA                               3. OUTPUT
 ─────────────────────────           ───────────────────────────            ──────────────────
 integrations/*.yaml                 Registry  (alla verktyg, namnrymd)     Chatt-UI  (/)
   kind: http     → REST      ─┐     Auth      (hemligheter, OAuth2,  ┌──►  Chatt-API (/api/chat, SSE)
   kind: openapi  → OpenAPI    ├──►             inkommande token)     │
   kind: mcp      → MCP-server │     Skills    (skills/*/SKILL.md)    ├──►  MCP-gateway (/mcp)
   kind: module   → egen kod  ─┘     LLM       (Claude, verktygsloop, │     – samma integrationer i
                                               godkännanden)          │       Claude Desktop, IDE:er …
                                     Validering (JSON Schema)        ─┘
```

Allt som kopplas in blir **verktyg** med namnet `<integration>__<verktyg>`. Samma verktygslista används både av chatten och av MCP-gatewayen.

## Kom igång

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # krävs för chatten
npm start                                # http://localhost:3000
npm test                                 # 7 tester, ingen API-nyckel behövs
```

Valfria miljövariabler:

| Variabel | Vad |
|---|---|
| `PORT` | Port (standard 3000) |
| `BYOI_API_TOKEN` | Kräver `Authorization: Bearer <token>` på `/api/*` och `/mcp`. Utan den är API:t öppet – bara för lokal utveckling. |
| `BYOI_MODEL` | Claude-modell (standard `claude-opus-5-5`) |
| `BYOI_ALLOW_CODE_INTEGRATIONS=1` | Tillåt `module` och `mcp/stdio` via API:t (kör kod på servern – se Säkerhet) |

## Lägga till en integration

Antingen lägger du en YAML-fil i `integrations/`, eller så klistrar du in manifestet under "Lägg till integration" i UI:t (eller `POST /api/integrations`). Skillen `skapa-integration` låter chatten hjälpa dig skriva manifestet.

**REST** (`kind: http`):
```yaml
id: crm
name: Vårt CRM
kind: http
baseUrl: https://crm.example.com/api
auth: { type: bearer, secret: CRM_TOKEN }
operations:
  - name: find_customer
    description: Sök kund på namn eller org.nr
    path: /customers
    params:
      - { name: q, required: true }
  - name: add_note
    description: Lägg en anteckning på en kund
    method: POST            # icke-GET kräver godkännande i chatten
    path: /customers/{id}/notes
    params:
      - { name: id, in: path }
      - { name: text, in: body, required: true }
```

**OpenAPI** – varje operation blir ett verktyg:
```yaml
id: billing
name: Fakturering
kind: openapi
spec: https://billing.example.com/openapi.json
include: [listInvoices, getInvoice]      # valfritt
auth: { type: api_key, secret: BILLING_KEY, in: header, name: X-API-Key }
```

**MCP** – vilken MCP-server som helst (databaser, SaaS, filer …):
```yaml
id: linear
name: Linear
kind: mcp
transport: { type: http, url: https://mcp.example.com/mcp, headers: { Authorization: "Bearer ${secret:LINEAR_TOKEN}" } }
```

**Egen kod** (`kind: module`) – se `integrations/src/notes.ts`.

### Auth

Manifest innehåller bara *namn* på hemligheter. Värdena läses från miljövariabler eller `.secrets.json` (gitignorerad), och kan fyllas i från UI:t när en integration står som `needs_auth`. Stöd: `bearer`, `api_key` (header/query), `basic`, `oauth2_client_credentials` (med token-cache), samt `${secret:NAMN}` / `${env:NAMN}` var som helst i manifestet.

## Skills

`skills/<namn>/SKILL.md` med frontmatter (`name`, `description`, valfritt `integrations: [id]`). Bara en rad per skill hamnar i systemprompten; modellen läser in hela texten med verktyget `load_skill` när den behövs. En skill visas bara om integrationerna den kräver är anslutna.

## Struktur

```
src/
  input/                 Lager 1 – universalport
    manifest.ts          manifestformatet (Zod)
    loader.ts            läser integrations/, kopplar upp, ger status
    adapters/            http · openapi · mcp · module
  core/                  Lager 2
    registry.ts          verktygsregister + schemavalidering
    auth.ts              hemligheter, utgående auth, inkommande token
    skills.ts            skills + load_skill
    agent.ts             Claude-loop (streaming, parallella verktyg, godkännanden)
    mcp-gateway.ts       exponerar registret som MCP-server
  output/                Lager 3
    server.ts            HTTP-API + SSE
    public/index.html    chatt-UI
integrations/            exempel: weather, github, petstore, notes, clock, filesystem
skills/                  vaderrapport, skapa-integration
```

## Säkerhet

- `module` och `mcp/stdio` kör kod på servern och kan därför bara läggas till som filer, inte via API:t (om du inte uttryckligen slår på `BYOI_ALLOW_CODE_INTEGRATIONS`).
- Verktyg som ändrar data (icke-GET, `confirm: true`, eller MCP-verktyg med `destructiveHint`) pausar chatten tills användaren godkänner.
- Svar från integrationer kortas vid 60 000 tecken.

## Begränsningar i prototypen / nästa steg

- Konversationer och godkännanden lever i minnet – byt till en databas (t.ex. Postgres/Redis) för drift.
- En enda användare: inga tenants eller per-användar-hemligheter än. Nästa steg är OAuth2 *authorization code* per användare och en krypterad hemlighetsbutik (KMS/Vault).
- Fler input-typer: GraphQL, inkommande webhooks/händelser, SQL direkt (finns idag via MCP-servrar).
- Inga observability-hooks än (loggning av verktygsanrop, kostnad per konversation).
