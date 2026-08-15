import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

/**
 * Real-SQLite D1 adapter for tests.
 *
 * Implements the subset of the D1 API that src/db.ts uses, backed by an
 * in-memory better-sqlite3 database with the ACTUAL migrations applied —
 * so SQL syntax errors, ambiguous columns, constraint issues and JOIN
 * mistakes fail loudly instead of being emulated away by a stub.
 *
 * Also records every executed statement (executed[]), batch count and
 * batch sizes so tests can still assert chunking behavior.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);
const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_article_images.sql",
  "0003_cluster_sig_lock.sql",
  "0004_meta.sql",
  "0005_pipeline_runs.sql",
];

export class SqliteD1 {
  /** Statements executed since construction (for chunking assertions). */
  executed: string[] = [];
  batchCalls = 0;
  batchSizes: number[] = [];

  private db: Database.Database;

  constructor(applyMigrations = true) {
    this.db = new Database(":memory:");
    // D1 is a superset of SQLite; keep the pragmas close to D1 defaults.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    if (applyMigrations) this.applyMigrations();
  }

  /** Apply migrations in order, exactly like `wrangler d1 migrations apply`. */
  applyMigrations(): void {
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      this.db.exec(sql);
    }
  }

  close(): void {
    this.db.close();
  }

  prepare(sql: string): D1PreparedStatement {
    this.executed.push(sql);
    const stmt = this.db.prepare(sql);
    const state: BoundStmt = { sql, params: [] };

    const run = (): D1Result => {
      const res = stmt.run(...state.params);
      return {
        success: true,
        results: [],
        meta: {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid),
          duration: 0,
          rows_read: 0,
          rows_written: 0,
          size_after: 0,
          changed_db: false,
        },
      };
    };
    const all = (): D1Result => {
      const rows = stmt.all(...state.params) as Record<string, unknown>[];
      return {
        success: true,
        results: rows,
        meta: {
          changes: 0,
          last_row_id: 0,
          duration: 0,
          rows_read: rows.length,
          rows_written: 0,
          size_after: 0,
          changed_db: false,
        },
      };
    };
    const first = async (): Promise<Record<string, unknown> | null> => {
      const rows = (await all()).results as Record<string, unknown>[];
      return rows.length > 0 ? rows[0] : null;
    };

    const boundStmt = {
      bind: () => boundStmt,
      run,
      all,
      first,
      /** Internal hook so batch() can execute bound statements in a tx. */
      _run: run,
    };

    return {
      bind: (...params: unknown[]) => {
        state.params = params;
        return boundStmt;
      },
      run,
      all,
      first,
    } as unknown as D1PreparedStatement;
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    this.batchCalls++;
    this.batchSizes.push(stmts.length);
    const runners = stmts.map(
      (s) => (s as unknown as { _run: () => D1Result })._run
    );
    return this.db.transaction(() => runners.map((r) => r()))();
  }
}

interface BoundStmt {
  sql: string;
  params: unknown[];
}