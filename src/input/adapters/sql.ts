// SQL adapter: Postgres, MySQL/MariaDB, SQL Server and SQLite.
// Reads run inside READ ONLY transactions where the database supports it.
// Writes are off unless the manifest sets allowWrite, and then need approval.
import path from "node:path";
import type { ManifestOf } from "../manifest.ts";
import { clip } from "./http.ts";
import type { Adapter, AdapterContext, ToolDef, ToolOutput } from "./types.ts";

type Rows = Record<string, unknown>[];

interface Driver {
  query(sql: string, params: unknown[], readOnly: boolean): Promise<Rows>;
  close(): Promise<void>;
  placeholder: string;
  listTablesSql: string;
  describeSql(table: string, schema?: string): [string, unknown[]];
}

async function optionalImport(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`Drivrutinen "${name}" är inte installerad. Kör: npm install ${name}`);
  }
}

const READ_ONLY_SQL = /^\s*(select|with|show|describe|explain|values|pragma\s+table_info)\b/i;

async function createDriver(m: ManifestOf<"sql">, baseDir: string): Promise<Driver> {
  switch (m.driver) {
    case "postgres": {
      const pg = (await import("pg")).default;
      const pool = new pg.Pool({ connectionString: m.connection, max: 4 });
      return {
        placeholder: "$1, $2, …",
        async query(sql, params, readOnly) {
          const client = await pool.connect();
          try {
            await client.query(readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
            const res: any = await client.query(sql, params);
            await client.query(readOnly ? "ROLLBACK" : "COMMIT");
            const last = Array.isArray(res) ? res.at(-1) : res;
            return last?.fields?.length ? last.rows : [{ command: last?.command, rowCount: last?.rowCount }];
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        },
        close: () => pool.end(),
        listTablesSql: "select table_schema, table_name, table_type from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1,2",
        describeSql: (table, schema) => [
          "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = $1 and ($2::text is null or table_schema = $2) order by ordinal_position",
          [table, schema ?? null],
        ],
      };
    }
    case "mysql": {
      const mysql = await import("mysql2/promise");
      const pool = mysql.createPool({ uri: m.connection, connectionLimit: 4 });
      return {
        placeholder: "?",
        async query(sql, params, readOnly) {
          const conn = await pool.getConnection();
          try {
            await conn.query(readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
            const [rows] = await conn.query(sql, params);
            await conn.query(readOnly ? "ROLLBACK" : "COMMIT");
            return Array.isArray(rows) ? (rows as Rows) : [rows as unknown as Record<string, unknown>];
          } catch (err) {
            await conn.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            conn.release();
          }
        },
        close: () => pool.end(),
        listTablesSql: "select table_schema, table_name, table_type from information_schema.tables where table_schema = database() order by 2",
        describeSql: (table, schema) => [
          "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = ? and table_schema = coalesce(?, database()) order by ordinal_position",
          [table, schema ?? null],
        ],
      };
    }
    case "mssql": {
      const mssql = (await optionalImport("mssql")).default;
      const pool = await new mssql.ConnectionPool(m.connection).connect();
      return {
        placeholder: "@p1, @p2, …",
        async query(sql, params, readOnly) {
          // SQL Server has no read-only transactions: use a read-only login, plus this check.
          if (readOnly && (!READ_ONLY_SQL.test(sql) || /;\s*\S/.test(sql))) throw new Error("Endast en enskild SELECT tillåts");
          const req = pool.request();
          params.forEach((p, i) => req.input(`p${i + 1}`, p));
          const res = await req.query(sql);
          return res.recordset ?? [{ rowsAffected: res.rowsAffected }];
        },
        close: () => pool.close(),
        listTablesSql: "select TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE from INFORMATION_SCHEMA.TABLES order by 1,2",
        describeSql: (table, schema) => [
          "select COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT from INFORMATION_SCHEMA.COLUMNS where TABLE_NAME = @p1 and (@p2 is null or TABLE_SCHEMA = @p2) order by ORDINAL_POSITION",
          [table, schema ?? null],
        ],
      };
    }
    case "sqlite": {
      const { DatabaseSync } = await import("node:sqlite");
      const file = m.connection === ":memory:" ? m.connection : path.resolve(baseDir, m.connection.replace(/^sqlite:\/\//, ""));
      const db = new DatabaseSync(file, { readOnly: !m.allowWrite });
      return {
        placeholder: "?",
        async query(sql, params, readOnly) {
          const stmt = db.prepare(sql);
          const returnsRows = stmt.columns().length > 0;
          if (readOnly && (!returnsRows || !READ_ONLY_SQL.test(sql))) throw new Error("Endast läsfrågor (SELECT) – använd execute för ändringar");
          return returnsRows ? (stmt.all(...(params as any[])) as Rows) : [stmt.run(...(params as any[])) as unknown as Record<string, unknown>];
        },
        close: async () => db.close(),
        listTablesSql: "select name as table_name, type as table_type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by 1",
        describeSql: (table) => ["select name as column_name, type as data_type, \"notnull\" as not_null, dflt_value as column_default, pk from pragma_table_info(?)", [table]],
      };
    }
  }
}

export class SqlAdapter implements Adapter {
  private db!: Driver;

  constructor(private manifest: ManifestOf<"sql">, private ctx: AdapterContext) {}

  async connect(): Promise<void> {
    this.db = await createDriver(this.manifest, this.ctx.baseDir);
    await this.db.query("select 1", [], true);
  }

  listTools(): ToolDef[] {
    const params = { type: "array", items: {}, description: `Parametrar till platshållarna (${this.db.placeholder})` };
    const tools: ToolDef[] = [
      { name: "list_tables", description: `Listar tabeller och vyer (${this.manifest.driver}).`, inputSchema: { type: "object", properties: {} } },
      {
        name: "describe_table",
        description: "Visar kolumner och typer för en tabell. Ange gärna schema.tabell.",
        inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] },
      },
      {
        name: "query",
        description: `Kör en läsfråga (SELECT) mot ${this.manifest.driver}-databasen i en skrivskyddad transaktion. Max ${this.manifest.maxRows} rader returneras. Använd platshållare ${this.db.placeholder} och params för värden.`,
        inputSchema: { type: "object", properties: { sql: { type: "string" }, params }, required: ["sql"] },
      },
    ];
    if (this.manifest.allowWrite) {
      tools.push({
        name: "execute",
        description: `Kör en ändrande SQL-sats (INSERT/UPDATE/DELETE/DDL) i en transaktion. Platshållare ${this.db.placeholder}.`,
        inputSchema: { type: "object", properties: { sql: { type: "string" }, params }, required: ["sql"] },
        confirm: true,
      });
    }
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    try {
      let rows: Rows;
      if (name === "list_tables") {
        rows = await this.db.query(this.db.listTablesSql, [], true);
        if (this.manifest.schemas) rows = rows.filter((r) => this.manifest.schemas!.includes(String(r.table_schema ?? r.TABLE_SCHEMA ?? "")));
      } else if (name === "describe_table") {
        const [schema, table] = String(input.table).includes(".") ? String(input.table).split(".", 2) : [undefined, String(input.table)];
        const [sql, params] = this.db.describeSql(table, schema);
        rows = await this.db.query(sql, params, true);
      } else if (name === "query" || (name === "execute" && this.manifest.allowWrite)) {
        rows = await this.db.query(String(input.sql), (input.params as unknown[]) ?? [], name === "query");
      } else {
        return { text: `Okänt verktyg: ${name}`, isError: true };
      }
      const shown = rows.slice(0, this.manifest.maxRows);
      const note = rows.length > shown.length ? `\n(visar ${shown.length} av ${rows.length} rader)` : "";
      return { text: clip(JSON.stringify(shown, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1)) + note };
    } catch (err) {
      return { text: `SQL-fel: ${(err as Error).message}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
  }
}
