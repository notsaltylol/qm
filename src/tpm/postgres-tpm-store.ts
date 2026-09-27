import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import {
  canClassifierOverwrite,
  type TpmColumn,
  type TpmEdge,
  type TpmEdgeKind,
  type TpmEdgeOrigin,
  type TpmEdgeState,
  type TpmEvent,
  type TpmEventType,
  type TpmItem,
  type TpmKind,
  type TpmRubric,
  type TpmRubricQuestion,
  type TpmSignals,
  type TpmStore,
} from "./tpm-store.ts";
import { applyItemPatch, itemChangeEvents } from "./tpm-item-patch.ts";

const MIGRATIONS = [
  {
    id: "tpm/store/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS tpm_items(
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ticket', 'customer_issue', 'document', 'milestone')),
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        board_column TEXT NOT NULL CHECK (board_column IN ('backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done')),
        external_ref TEXT,
        assignee TEXT,
        source_updated_at BIGINT,
        signals JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        column_changed_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tpm_items_scope ON tpm_items(scope_id, created_at, id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tpm_items_scope_ref ON tpm_items(scope_id, external_ref) WHERE external_ref IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS tpm_edges(
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('blocks', 'addresses', 'documents')),
        from_id TEXT NOT NULL REFERENCES tpm_items(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES tpm_items(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('confirmed', 'proposed', 'rejected')),
        origin TEXT NOT NULL CHECK (origin IN ('classifier', 'agent', 'person')),
        confidence DOUBLE PRECISION,
        decided_by TEXT,
        decided_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE (scope_id, kind, from_id, to_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tpm_edges_scope ON tpm_edges(scope_id, created_at, id)`,
      `CREATE TABLE IF NOT EXISTS tpm_events(
        id BIGSERIAL PRIMARY KEY,
        scope_id TEXT NOT NULL,
        item_id TEXT,
        edge_id TEXT,
        type TEXT NOT NULL,
        from_value TEXT,
        to_value TEXT,
        actor_id TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tpm_events_scope ON tpm_events(scope_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_tpm_events_item ON tpm_events(item_id, id) WHERE item_id IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS tpm_rubrics(
        scope_id TEXT PRIMARY KEY,
        questions JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
    ],
  },
];

type Row = Record<string, unknown>;

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const optionalNumber = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

function rowToItem(row: Row): TpmItem {
  const externalRef = optionalString(row.external_ref);
  const assignee = optionalString(row.assignee);
  const sourceUpdatedAt = optionalNumber(row.source_updated_at);
  return {
    id: row.id as string,
    scopeId: row.scope_id as ScopeId,
    kind: row.kind as TpmKind,
    title: row.title as string,
    body: row.body as string,
    column: row.board_column as TpmColumn,
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
    signals: (row.signals ?? {}) as TpmSignals,
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    columnChangedAt: Number(row.column_changed_at),
  };
}

function rowToEdge(row: Row): TpmEdge {
  const confidence = optionalNumber(row.confidence);
  const decidedBy = optionalString(row.decided_by);
  const decidedAt = optionalNumber(row.decided_at);
  return {
    id: row.id as string,
    scopeId: row.scope_id as ScopeId,
    kind: row.kind as TpmEdgeKind,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    state: row.state as TpmEdgeState,
    origin: row.origin as TpmEdgeOrigin,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToEvent(row: Row): TpmEvent {
  const itemId = optionalString(row.item_id);
  const edgeId = optionalString(row.edge_id);
  const fromValue = optionalString(row.from_value);
  const toValue = optionalString(row.to_value);
  return {
    id: String(row.id),
    scopeId: row.scope_id as ScopeId,
    ...(itemId !== undefined ? { itemId } : {}),
    ...(edgeId !== undefined ? { edgeId } : {}),
    type: row.type as TpmEventType,
    ...(fromValue !== undefined ? { fromValue } : {}),
    ...(toValue !== undefined ? { toValue } : {}),
    actorId: row.actor_id as string,
    createdAt: Number(row.created_at),
  };
}

function rowToRubric(row: Row): TpmRubric {
  return {
    scopeId: row.scope_id as ScopeId,
    questions: row.questions as TpmRubricQuestion[],
    updatedBy: row.updated_by as string,
    updatedAt: Number(row.updated_at),
  };
}

async function insertEvent(client: PoolClient, event: Omit<TpmEvent, "id" | "createdAt">, at: number): Promise<void> {
  await client.query(
    `INSERT INTO tpm_events(scope_id, item_id, edge_id, type, from_value, to_value, actor_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.scopeId,
      event.itemId ?? null,
      event.edgeId ?? null,
      event.type,
      event.fromValue ?? null,
      event.toValue ?? null,
      event.actorId,
      at,
    ],
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export function createPostgresTpmStore(connectionString: string, opts: { now?: () => number } = {}): TpmStore {
  const now = opts.now ?? (() => Date.now());
  const pg = createPgPool(connectionString, MIGRATIONS);
  const q = pg.query;
  const tx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withPgTransaction(await pg.pool(), fn);
  const refConflict = (ref: string | undefined) => new Error(`tpm item with ref ${ref ?? ""} already exists`);

  return {
    async createItem(input) {
      const at = now();
      const id = randomUUID();
      try {
        return await tx(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO tpm_items(id, scope_id, kind, title, body, board_column, external_ref, assignee,
               source_updated_at, signals, created_by, created_at, updated_at, column_changed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
            [
              id,
              input.scopeId,
              input.kind,
              input.title,
              input.body ?? "",
              input.column,
              input.externalRef ?? null,
              input.assignee ?? null,
              input.sourceUpdatedAt ?? null,
              JSON.stringify(input.signals ?? {}),
              input.actorId,
              at,
            ],
          );
          await insertEvent(
            client,
            { scopeId: input.scopeId, itemId: id, type: "item_created", toValue: input.column, actorId: input.actorId },
            at,
          );
          return rowToItem(rows[0] as Row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw refConflict(input.externalRef);
        throw error;
      }
    },

    async getItem(id) {
      const { rows } = await q("SELECT * FROM tpm_items WHERE id = $1", [id]);
      return rows[0] ? rowToItem(rows[0]) : null;
    },

    async listItems(scopeId) {
      const { rows } = await q("SELECT * FROM tpm_items WHERE scope_id = $1 ORDER BY created_at, id", [scopeId]);
      return rows.map(rowToItem);
    },

    async updateItem(id, patch, actorId) {
      try {
        return await tx(async (client) => {
          const { rows } = await client.query("SELECT * FROM tpm_items WHERE id = $1 FOR UPDATE", [id]);
          if (!rows[0]) return null;
          const current = rowToItem(rows[0] as Row);
          const at = now();
          const next = applyItemPatch(current, patch, at);
          const updated = await client.query(
            `UPDATE tpm_items SET kind = $2, title = $3, body = $4, board_column = $5, external_ref = $6,
               assignee = $7, source_updated_at = $8, signals = $9, updated_at = $10, column_changed_at = $11
             WHERE id = $1 RETURNING *`,
            [
              id,
              next.kind,
              next.title,
              next.body,
              next.column,
              next.externalRef ?? null,
              next.assignee ?? null,
              next.sourceUpdatedAt ?? null,
              JSON.stringify(next.signals),
              at,
              next.columnChangedAt,
            ],
          );
          for (const event of itemChangeEvents(current, next, actorId, patch.placement === true))
            await insertEvent(client, event, at);
          return rowToItem(updated.rows[0] as Row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw refConflict(patch.externalRef ?? undefined);
        throw error;
      }
    },

    async deleteItem(id, actorId) {
      return tx(async (client) => {
        const { rows } = await client.query("DELETE FROM tpm_items WHERE id = $1 RETURNING scope_id, board_column", [
          id,
        ]);
        const row = rows[0] as Row | undefined;
        if (!row) return false;
        await insertEvent(
          client,
          {
            scopeId: row.scope_id as ScopeId,
            itemId: id,
            type: "item_deleted",
            fromValue: row.board_column as string,
            actorId,
          },
          now(),
        );
        return true;
      });
    },

    async upsertEdge(input) {
      const at = now();
      const decided = input.origin !== "classifier";
      return tx(async (client) => {
        const inserted = await client.query(
          `INSERT INTO tpm_edges(id, scope_id, kind, from_id, to_id, state, origin, confidence, decided_by, decided_at,
             created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
           ON CONFLICT (scope_id, kind, from_id, to_id) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            input.scopeId,
            input.kind,
            input.fromId,
            input.toId,
            input.state,
            input.origin,
            input.confidence ?? null,
            decided ? input.actorId : null,
            decided ? at : null,
            at,
          ],
        );
        if (inserted.rows[0]) {
          const edge = rowToEdge(inserted.rows[0] as Row);
          await insertEvent(
            client,
            { scopeId: edge.scopeId, edgeId: edge.id, type: "edge_added", toValue: edge.state, actorId: input.actorId },
            at,
          );
          return edge;
        }
        const { rows } = await client.query(
          `SELECT * FROM tpm_edges WHERE scope_id = $1 AND kind = $2 AND from_id = $3 AND to_id = $4 FOR UPDATE`,
          [input.scopeId, input.kind, input.fromId, input.toId],
        );
        const existing = rowToEdge(rows[0] as Row);
        if (!decided && !canClassifierOverwrite(existing)) return existing;
        const updated = await client.query(
          `UPDATE tpm_edges SET state = $2, origin = $3, confidence = COALESCE($4, confidence),
             decided_by = CASE WHEN $5::text IS NULL THEN decided_by ELSE $5 END,
             decided_at = CASE WHEN $5::text IS NULL THEN decided_at ELSE $6 END,
             updated_at = $6
           WHERE id = $1 RETURNING *`,
          [existing.id, input.state, input.origin, input.confidence ?? null, decided ? input.actorId : null, at],
        );
        const next = rowToEdge(updated.rows[0] as Row);
        if (next.state !== existing.state) {
          await insertEvent(
            client,
            {
              scopeId: next.scopeId,
              edgeId: next.id,
              type: "edge_decided",
              fromValue: existing.state,
              toValue: next.state,
              actorId: input.actorId,
            },
            at,
          );
        }
        return next;
      });
    },

    async decideEdge(id, state, actorId) {
      const at = now();
      return tx(async (client) => {
        const { rows } = await client.query("SELECT * FROM tpm_edges WHERE id = $1 FOR UPDATE", [id]);
        if (!rows[0]) return null;
        const existing = rowToEdge(rows[0] as Row);
        const updated = await client.query(
          `UPDATE tpm_edges SET state = $2, decided_by = $3, decided_at = $4, updated_at = $4 WHERE id = $1 RETURNING *`,
          [id, state, actorId, at],
        );
        await insertEvent(
          client,
          {
            scopeId: existing.scopeId,
            edgeId: id,
            type: "edge_decided",
            fromValue: existing.state,
            toValue: state,
            actorId,
          },
          at,
        );
        return rowToEdge(updated.rows[0] as Row);
      });
    },

    async listEdges(scopeId) {
      const { rows } = await q("SELECT * FROM tpm_edges WHERE scope_id = $1 ORDER BY created_at, id", [scopeId]);
      return rows.map(rowToEdge);
    },

    async listEvents(scopeId, filter = {}) {
      const params: unknown[] = [scopeId];
      let where = "scope_id = $1";
      if (filter.itemId !== undefined) {
        params.push(filter.itemId);
        where += ` AND item_id = $${params.length}`;
      }
      params.push(filter.limit ?? 10_000);
      const { rows } = await q(
        `SELECT * FROM (SELECT * FROM tpm_events WHERE ${where} ORDER BY id DESC LIMIT $${params.length}) recent ORDER BY id`,
        params,
      );
      return rows.map(rowToEvent);
    },

    async listScopes() {
      const { rows } = await q(
        "SELECT scope_id, COUNT(*)::int AS item_count FROM tpm_items GROUP BY scope_id ORDER BY scope_id",
      );
      return rows.map((row) => ({ scopeId: row.scope_id as ScopeId, itemCount: Number(row.item_count) }));
    },

    async getRubric(scopeId) {
      const { rows } = await q("SELECT * FROM tpm_rubrics WHERE scope_id = $1", [scopeId]);
      return rows[0] ? rowToRubric(rows[0]) : null;
    },

    async setRubric(scopeId, questions, actorId) {
      const at = now();
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tpm_rubrics(scope_id, questions, updated_by, updated_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (scope_id) DO UPDATE SET questions = EXCLUDED.questions, updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [scopeId, JSON.stringify(questions), actorId, at],
        );
        await insertEvent(client, { scopeId, type: "rubric_changed", toValue: String(questions.length), actorId }, at);
        return rowToRubric(rows[0] as Row);
      });
    },

    async close() {
      await pg.close();
    },
  };
}
