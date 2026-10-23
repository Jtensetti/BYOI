import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import YAML from "yaml";
import { ManifestSchema } from "../src/input/manifest.ts";

test("every template in examples/ and integrations/ is a valid manifest", () => {
  for (const dir of ["examples", "integrations"]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const r = ManifestSchema.safeParse(YAML.parse(fs.readFileSync(`${dir}/${f}`, "utf8")));
      assert.ok(r.success, `${dir}/${f}: ${r.success ? "" : r.error.message}`);
    }
  }
});
