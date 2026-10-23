---
name: vaderrapport
description: Skriver en kort väderrapport för en plats de närmaste dagarna
integrations: [weather]
---
1. Ta reda på platsens koordinater (använd din kunskap för kända orter; fråga om det är oklart).
2. Anropa `weather__forecast` med `daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max`, `timezone=auto`, `forecast_days=5`.
3. Svara med en tabell: dag, max/min °C, nederbörd (mm), vind (m/s – API:t ger km/h, dela med 3,6).
4. Avsluta med en mening om vad man bör tänka på (paraply, kyla, blåst).
