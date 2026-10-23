---
name: skapa-integration
description: Kopplar in ett nytt system åt användaren – vilket som helst (API, databas, kö, webhook, webbsida, CLI eller system bakom brandvägg)
---
1. Har användaren en URL, anslutningssträng, curl-exempel eller dokumentation: anropa `propose_integration` med den. Den känner själv igen OpenAPI/Swagger, GraphQL, MCP, WSDL och anslutningssträngar, och skriver annars ett manifest från dokumentationen.
2. Visa utkastet och säg vilka hemligheter som behövs (bara namnen – be aldrig användaren klistra in hemligheter i chatten; de fylls i i sidopanelen).
3. När användaren godkänner: `install_integration`. Kräver den inloggning (OAuth) – be användaren trycka "Logga in" i sidopanelen.

Välj `kind` efter hur systemet pratar:
- `openapi` (spec finns) · `http` (REST utan spec) · `graphql` · `grpc` (.proto-filer) · `soap` (WSDL) · `mcp` (MCP-server)
- `sql` (postgres/mysql/mssql/sqlite – läsning som standard) · `queue` (mqtt/amqp/kafka) · `webhook` (systemet skickar till oss: POST /hooks/<id>)
- `browser` när systemet bara har ett webbgränssnitt · `cli` för kommandoradsverktyg · `module` för egen kod
- `connector` när systemet står i kundens interna nät – connectorn körs hos kunden och ansluter utåt.

Auth (hemligheter anges med namn, aldrig värde): `bearer`, `api_key` (header/query, prefix), `basic`,
`oauth2_client_credentials`, `oauth2_authorization_code` (inloggning per användare), `oauth2_jwt_bearer` (servicekonton),
`aws_sigv4`, samt `tls: { cert, key, ca }` för klientcertifikat och `${secret:NAMN}` var som helst i manifestet.

Operationer som ändrar data ska kräva godkännande (`confirm: true`; standard för icke-GET). `id`: a-z, 0-9, _ och -.
