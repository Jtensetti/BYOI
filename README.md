# BYOI – Bring Your Own Integration

Koppla in **vilket system som helst** och arbeta med det via chatt.

```
 1. INPUT – universalport                    2. KÄRNA                            3. OUTPUT
 ──────────────────────────────────          ─────────────────────────           ─────────────────────
 Begäran/svar  http · openapi · graphql       Register (alla verktyg,            Chatt-UI  (/)
               grpc · soap                      validering, verktygssökning)     Chatt-API (/api/chat, SSE)
 Agentnativt   mcp                     ───►   Auth (OAuth2 · JWT · SigV4 ·  ───► MCP-gateway (/mcp)
 Data          sql                              mTLS · hemligheter)                – samma integrationer i
 Händelser     webhook · queue                 Skills                               Claude Desktop, IDE:er …
 Utan API      browser (RPA) · cli             LLM (Claude, godkännanden,        Webhooks in (/hooks/<id>)
 Egen kod      module                            automationer)                   Connectorer in (/connect)
 Bakom brandvägg  connector                    Generator (vad som helst → manifest)
```

## Hur vi klarar "alla" integrationer

Ingen produkt kan ha färdiga kopplingar till alla system. Men det finns ett begränsat antal sätt som system
kommunicerar på, och BYOI täcker alla:

1. **Varje protokollfamilj har en adapter.** REST, OpenAPI/Swagger, GraphQL, gRPC, SOAP, MCP, SQL-databaser,
   meddelandeköer (MQTT, AMQP/RabbitMQ, Kafka) och inkommande webhooks. Ett nytt system som använder ett
   av dessa protokoll kräver ingen kod, bara ett manifest.
2. **Reservvägar för system utan API.** `browser` styr ett webbgränssnitt (låst till tillåtna domäner, klick
   kräver godkännande), `cli` kör kommandoradsverktyg utan skal (ingen kommandoinjektion) och `module` är
   egen TypeScript för allt annat. MCP-ekosystemet täcker dessutom tusentals färdiga servrar.
3. **Alla vanliga sätt att logga in.** API-nyckel, Bearer, Basic, OAuth2 (client credentials, inloggning
   per användare med PKCE och automatisk förnyelse, servicekonton med JWT), AWS SigV4, klientcertifikat (mTLS)
   och WS-Security för SOAP.
4. **System bakom brandväggar.** En connector körs hos kunden, laddar lokala manifest av vilken typ som helst
   och ansluter *utåt* till BYOI över WebSocket. Inga inkommande portar behövs, och hemligheterna stannar hos kunden.
5. **Integrationen skapas åt användaren.** Klistra in en URL, en anslutningssträng eller dokumentation.
   Generatorn känner själv igen MCP, OpenAPI (letar även på vanliga sökvägar), GraphQL, WSDL och anslutningssträngar.
   I övriga fall skriver Claude manifestet, som valideras och skickas tillbaka för rättning tills det är giltigt.
   I chatten: *"koppla in https://…"*.
6. **Skalar till stora API:er.** Över 30 verktyg laddas integrationernas verktyg först när de behövs, via
   Claudes verktygssökning. Ett API med 500 operationer fungerar därför lika bra som ett med 5.

## Publicera live (Render, gratisnivå)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Jtensetti/BYOI)

1. Tryck på knappen och logga in på Render med GitHub.
2. Fyll i `ANTHROPIC_API_KEY` när du blir tillfrågad och tryck **Deploy**. Bygget tar några minuter.
3. Hämta lösenordet: tjänsten **byoi** → **Environment** → `BYOI_API_TOKEN`.
4. Dela länken med lösenordet inbakat: `https://<din-tjänst>.onrender.com/?token=<BYOI_API_TOKEN>`.
   Den som öppnar länken kommer direkt in. Utan lösenordet fungerar varken chatten, API:t eller `/mcp`.

Bra att veta om gratisnivån: tjänsten somnar efter en stunds inaktivitet (första besöket tar då cirka en minut),
och integrationer eller hemligheter som läggs till via gränssnittet försvinner vid omstart. Det som ligger i
`integrations/` i repot finns alltid kvar. Alla med länken använder din Claude-nyckel, så dela den bara med
dem du vill ska kunna använda den. Byt `BYOI_API_TOKEN` i Render för att stänga gamla länkar.

## Kom igång

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # krävs för chatten och för generatorns Claude-steg
npm start                                # http://localhost:3000
npm test                                 # 26 tester mot riktiga lokala servrar, ingen API-nyckel behövs
```

| Variabel | Vad |
|---|---|
| `PORT` | Port (standard 3000) |
| `BYOI_API_TOKEN` | Kräver `Authorization: Bearer <token>` på `/api/*` och `/mcp`. Utan den är API:t öppet (endast lokalt). |
| `BYOI_PUBLIC_URL` | Publik adress, används för OAuth-redirect (`<url>/oauth/callback`) |
| `BYOI_MODEL` | Claude-modell (standard `claude-opus-5-5`) |
| `BYOI_ALLOW_CODE_INTEGRATIONS=1` | Tillåt typer som kör kod på servern (`module`, `cli`, `browser`, `sql`, `mcp/stdio`) via API:t |
| `BYOI_ALLOW_PRIVATE_NETWORK=1` | Låt generatorn anropa interna adresser (annars blockeras de mot SSRF; använd en connector) |
| `BYOI_CHROMIUM_PATH` | Sökväg till Chromium för `browser` |

Databas- och ködrivrutiner som inte ingår som standard: `npm install mssql`, `amqplib` eller `kafkajs` vid behov.

## Lägga till en integration

Tre sätt:
- **Koppla in vad som helst** i sidopanelen: URL, anslutningssträng eller beskrivning → utkast → granska → Koppla in.
- **I chatten:** "koppla in vårt lager-API, docs finns på https://…". Assistenten tar fram och installerar integrationen efter ditt godkännande.
- **Som fil** i `integrations/`. Se [`examples/`](examples/) för mallar för Microsoft 365, Google, Stripe, S3, SOAP-ERP,
  gRPC, Postgres, RabbitMQ, Kafka, GitHub-webhooks, webbportaler, CLI och on-prem.

Hemligheter anges bara med namn i manifesten. Värdena läses från miljövariabler eller `.secrets.json`
(gitignorerad) och kan fyllas i i sidopanelen. OAuth-integrationer får en "Logga in"-knapp.

## Händelser och automationer

`webhook` (POST `/hooks/<id>`, verifieras med HMAC eller token) och `queue` sparar inkommande händelser,
som modellen kan läsa med `recent_events`. Med `trigger:` startar varje händelse en automatisk agentkörning.
Verktyg som kräver godkännande nekas då, om de inte uttryckligen listas i `autoApprove`.

## On-prem-connector

```bash
# Hos BYOI: integrations/kund.yaml  (kind: connector, connectorId: acme-dc1, token: ACME_CONNECTOR_TOKEN)
# Hos kunden:
BYOI_HUB_URL=wss://byoi.example.com/connect BYOI_CONNECTOR_ID=acme-dc1 \
BYOI_CONNECTOR_TOKEN=... BYOI_INTEGRATIONS_DIR=./integrations npm run connector
```

Kundens verktyg dyker upp som `<connector>__<integration>__<verktyg>` och försvinner när connectorn kopplar ner.
Godkännanden hanteras av BYOI, och connectorn validerar indata lokalt.

## Struktur

```
src/
  input/                Lager 1 – universalport
    manifest.ts         manifestformatet (alla typer + auth)
    loader.ts           läser integrations/, kopplar upp, ger status
    adapters/           http · openapi · graphql · grpc · soap · mcp · sql · webhook · queue
                        browser · cli · module · connector
  core/                 Lager 2
    registry.ts         verktygsregister + schemavalidering
    auth.ts             hemligheter, OAuth2/JWT/SigV4/mTLS, inkommande token
    generator.ts        URL/anslutningssträng/text → manifest
    agent.ts            Claude-loop: streaming, parallella verktyg, godkännanden,
                        verktygssökning, verktyg som tillkommer mitt i en konversation
    events.ts           händelser + automationer
    connector-hub.ts    tar emot on-prem-connectorer
    skills.ts, mcp-gateway.ts
  output/               Lager 3 – server.ts (HTTP, SSE, /hooks, /connect, /oauth) + chatt-UI
  connector/            on-prem-connectorn
examples/               mallar
integrations/           aktiva integrationer (demo: väder, GitHub, Petstore, anteckningar, klocka)
skills/                 vaderrapport, skapa-integration
```

## Säkerhet

- Typer som kör kod eller öppnar resurser på servern kan bara läggas till som fil, om det inte uttryckligen tillåts.
- Verktyg som ändrar data pausar chatten tills användaren godkänner. I automatiska körningar nekas de.
- Generatorn vägrar interna adresser (SSRF-skydd). Interna system nås via connector.
- Webhooks verifieras med jämförelser i konstant tid. Connector-tokens likaså.
- `browser` är låst till tillåtna domäner. `cli` kör aldrig via ett skal.
- Svar från integrationer kortas vid 60 000 tecken.

## Kvar att göra

- Konversationer, händelser och väntande godkännanden lever i minnet. De behöver en databas för drift.
- En användare: inga tenants eller hemligheter per användare än. OAuth-tokens sparas per integration.
  Nästa steg är per användare och tenant, med krypterad hemlighetsbutik (KMS/Vault).
- gRPC kräver .proto-filer (server reflection saknas). SOAP-scheman blir förenklade JSON-scheman.
- mTLS är implementerat men inte testat mot en riktig server än.
- Fler event-källor (e-post/IMAP, SFTP-kataloger, CDC från databaser) går idag via `module` eller MCP.
