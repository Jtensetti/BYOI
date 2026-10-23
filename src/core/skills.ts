// Skills: packaged know-how (Markdown) the model loads when it needs it.
// skills/<name>/SKILL.md with YAML frontmatter: name, description, integrations?.
// Only the one-line index sits in the system prompt; the body loads on demand.
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { BuiltinTool } from "./registry.ts";

export interface Skill {
  name: string;
  description: string;
  integrations: string[];
  body: string;
}

export async function loadSkills(dir: string): Promise<Skill[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (!raw) continue;
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = match ? (YAML.parse(match[1]) ?? {}) : {};
    skills.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      integrations: meta.integrations ?? [],
      body: (match ? match[2] : raw).trim(),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillTool(getSkills: () => Skill[]): BuiltinTool {
  return {
    name: "load_skill",
    description:
      "Läser in en skills fullständiga instruktioner. Anropa när användarens fråga matchar en skill i listan i systemprompten.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skillens namn" } },
      required: ["name"],
      additionalProperties: false,
    },
    async run(input) {
      const skill = getSkills().find((s) => s.name === input.name);
      if (!skill) return { text: `Ingen skill heter "${input.name}"`, isError: true };
      return { text: skill.body };
    },
  };
}
