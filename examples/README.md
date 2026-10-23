# Mallar

Kopiera en fil till `integrations/`, justera och fyll i hemligheterna (miljövariabler, `.secrets.json` eller UI:t).
Eller skriv in en URL/anslutningssträng under "Koppla in vad som helst" så tas manifestet fram åt dig.

| Fil | Typ | Visar |
|---|---|---|
| microsoft-graph.yaml | http + OAuth (inloggning per användare) | Outlook, Teams, OneDrive |
| google-sheets.yaml | http + servicekonto (JWT) | Google API:er utan inloggning |
| stripe.yaml | openapi (stor spec → verktygssökning) | SaaS med hundratals operationer |
| github-graphql.yaml | graphql | GraphQL-API:er |
| s3.yaml | http + AWS SigV4 | Alla AWS-tjänster |
| bank-mtls.yaml | http + klientcertifikat | Bank/myndighet med mTLS |
| erp-soap.yaml | soap + WS-Security | Äldre affärssystem |
| inventory-grpc.yaml | grpc | Interna mikrotjänster |
| postgres.yaml | sql | Databaser (läsning som standard) |
| rabbitmq.yaml / kafka.yaml | queue | Händelser och meddelanden |
| github-webhook.yaml | webhook + automation | Agera när något händer |
| legacy-portal.yaml | browser | System som bara har ett webbgränssnitt |
| sap-cli.yaml | cli | Leverantörs-CLI:er och skript |
| onprem.yaml | connector | Allt bakom kundens brandvägg |
| linear-mcp.yaml | mcp (fjärr) | Färdiga MCP-servrar |
