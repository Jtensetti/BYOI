---
name: skapa-integration
description: Hjälper användaren att skriva ett BYOI-manifest för ett nytt system (REST, OpenAPI eller MCP)
---
Målet är ett giltigt YAML-manifest som användaren klistrar in under "Lägg till integration".

Fråga först (bara det som saknas): vilket system, bas-URL eller OpenAPI-spec, hur man autentiserar, och vilka operationer som behövs.

Välj `kind`:
- `openapi` om systemet har en OpenAPI/Swagger-spec – enklast: `spec: <url>`, ev. `include: [operationId, ...]`.
- `mcp` med `transport: { type: http, url: ... }` om det finns en fjärr-MCP-server.
- `http` annars: lista `operations` med `name`, `description`, `method`, `path`, `params` (`in: query|path|header|body`).

Auth (hemligheten anges med namn, aldrig värde):
- `{ type: bearer, secret: NAMN }`
- `{ type: api_key, secret: NAMN, in: header|query, name: X-API-Key }`
- `{ type: basic, username: ..., secret: NAMN }`
- `{ type: oauth2_client_credentials, tokenUrl, clientId, clientSecret: NAMN, scope }`

Operationer som ändrar data ska ha `confirm: true` (standard för icke-GET). `id` får bara innehålla a-z, 0-9, _ och -.

Visa manifestet i ett kodblock och säg vilka hemligheter användaren behöver fylla i.
