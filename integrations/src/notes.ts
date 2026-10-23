import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineIntegration } from "../../src/input/adapters/module.ts";

type Note = { id: number; title: string; text: string; created: string };
const here = path.dirname(fileURLToPath(import.meta.url));
let file = "";

const read = (): Note[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
const write = (notes: Note[]) => fs.writeFileSync(file, JSON.stringify(notes, null, 2));

export default defineIntegration({
  connect(config) {
    file = path.resolve(here, "..", String(config.file ?? ".notes.json"));
  },
  tools: [
    {
      name: "list",
      description: "Listar alla anteckningar (id, titel, datum).",
      inputSchema: { type: "object", properties: {} },
      run: () => read().map(({ id, title, created }) => ({ id, title, created })),
    },
    {
      name: "get",
      description: "Hämtar en anteckning med id.",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      run: ({ id }) => read().find((n) => n.id === id) ?? `Ingen anteckning med id ${id}`,
    },
    {
      name: "create",
      description: "Skapar en ny anteckning.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, text: { type: "string" } },
        required: ["title", "text"],
      },
      confirm: true,
      run: ({ title, text }) => {
        const notes = read();
        const note = { id: (notes.at(-1)?.id ?? 0) + 1, title: String(title), text: String(text), created: new Date().toISOString() };
        write([...notes, note]);
        return note;
      },
    },
  ],
});
