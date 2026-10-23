// Browser adapter (RPA): for systems that only have a web UI. The model sees the
// page as an accessibility snapshot and acts through a few safe, generic tools.
// Navigation is locked to allowed domains; clicks and typing need approval.
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ManifestOf } from "../manifest.ts";
import { clip } from "./http.ts";
import type { Adapter, AdapterContext, JsonSchema, ToolDef, ToolOutput } from "./types.ts";

const target: JsonSchema = {
  type: "object",
  properties: {
    selector: { type: "string", description: "CSS- eller Playwright-selektor, t.ex. text=Spara" },
    role: { type: "string", description: "ARIA-roll, t.ex. button, link, textbox" },
    name: { type: "string", description: "Tillgängligt namn för rollen (synlig text/etikett)" },
  },
};

export class BrowserAdapter implements Adapter {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private allowed: string[];

  constructor(private manifest: ManifestOf<"browser">, private ctx: AdapterContext) {
    this.allowed = manifest.allowedDomains.length ? manifest.allowedDomains : [new URL(manifest.startUrl).hostname];
  }

  private isAllowed(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return this.allowed.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }

  async connect(): Promise<void> {} // the browser starts lazily on first use

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import("playwright-core");
    this.browser = await chromium.launch({
      headless: this.manifest.headless,
      executablePath: process.env.BYOI_CHROMIUM_PATH || undefined,
    });
    this.context = await this.browser.newContext();
    // Block navigation and requests to hosts outside the allow-list.
    await this.context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !this.isAllowed(req.url())) return route.abort("blockedbyclient");
      return route.continue();
    });
    this.page = await this.context.newPage();
    if (this.manifest.login) {
      await this.page.goto(this.manifest.login.url ?? this.manifest.startUrl);
      for (const step of this.manifest.login.steps) {
        if (step.fill) await this.page.fill(step.fill, step.value ?? "");
        if (step.click) await this.page.click(step.click);
        if (step.waitFor) await this.page.waitForSelector(step.waitFor);
      }
    }
    await this.page.goto(this.manifest.startUrl);
    return this.page;
  }

  private locate(page: Page, input: Record<string, unknown>) {
    if (input.role) return page.getByRole(input.role as any, input.name ? { name: String(input.name) } : undefined).first();
    if (input.selector) return page.locator(String(input.selector)).first();
    throw new Error("Ange selector eller role (+ name)");
  }

  private async snapshot(page: Page): Promise<string> {
    const aria = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
    return clip(`URL: ${page.url()}\nTitel: ${await page.title()}\n\n${aria}`);
  }

  listTools(): ToolDef[] {
    const act = this.manifest.allowActions;
    const tools: ToolDef[] = [
      { name: "open", description: `Öppnar en sida (tillåtna domäner: ${this.allowed.join(", ")}) och visar dess innehåll.`, inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      { name: "snapshot", description: "Visar aktuell sida som en tillgänglighetsträd-text (roller, namn, länkar, fält).", inputSchema: { type: "object", properties: {} } },
      { name: "read_text", description: "Läser texten i ett element.", inputSchema: target },
      { name: "screenshot", description: "Tar en skärmbild av sidan.", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } } },
    ];
    if (act) {
      tools.push(
        { name: "click", description: "Klickar på ett element.", inputSchema: target, confirm: true },
        {
          name: "fill",
          description: "Skriver text i ett fält.",
          inputSchema: { ...target, properties: { ...target.properties, value: { type: "string" } }, required: ["value"] } as any,
          confirm: true,
        },
        {
          name: "press",
          description: "Trycker en tangent (t.ex. Enter) i ett element eller på sidan.",
          inputSchema: { ...target, properties: { ...target.properties, key: { type: "string" } }, required: ["key"] } as any,
          confirm: true,
        },
      );
    }
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    try {
      const page = await this.ensurePage();
      switch (name) {
        case "open": {
          const url = new URL(String(input.url), page.url()).toString();
          if (!this.isAllowed(url)) return { text: `Domänen är inte tillåten: ${url}`, isError: true };
          await page.goto(url, { waitUntil: "domcontentloaded" });
          return { text: await this.snapshot(page) };
        }
        case "snapshot":
          return { text: await this.snapshot(page) };
        case "read_text":
          return { text: clip((await this.locate(page, input).innerText({ timeout: 10_000 })) ?? "") };
        case "screenshot": {
          const data = (await page.screenshot({ fullPage: Boolean(input.fullPage), type: "png" })).toString("base64");
          return { text: `Skärmbild av ${page.url()}`, images: [{ mediaType: "image/png", data }] };
        }
        case "click":
        case "fill":
        case "press": {
          if (!this.manifest.allowActions) return { text: "Åtgärder är avstängda för den här integrationen", isError: true };
          const el = input.selector || input.role ? this.locate(page, input) : null;
          if (name === "click") await el!.click({ timeout: 10_000 });
          if (name === "fill") await el!.fill(String(input.value), { timeout: 10_000 });
          if (name === "press") await (el ? el.press(String(input.key)) : page.keyboard.press(String(input.key)));
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          return { text: await this.snapshot(page) };
        }
      }
      return { text: `Okänt verktyg: ${name}`, isError: true };
    } catch (err) {
      return { text: `Webbläsarfel: ${(err as Error).message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}
