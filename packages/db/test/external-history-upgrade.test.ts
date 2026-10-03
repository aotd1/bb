import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
  externalThreadBindings,
  externalThreadMessages,
} from "../src/index.js";
import { dropPluginEnabledFollowsDefaultColumn } from "./helpers/rewind.js";

function legacyDatabase(handles: boolean, upstreamAlreadyApplied = false) {
  const db = createConnection(":memory:");
  migrate(db);
  db.$client.exec(
    "DROP TABLE external_thread_messages; DROP TABLE external_thread_bindings",
  );
  db.$client
    .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(1790837064310);
  if (!upstreamAlreadyApplied) {
    dropPluginEnabledFollowsDefaultColumn(db);
    db.$client.exec("DROP INDEX prompt_history_entries_created_idx");
  } else {
    for (const [file, timestamp] of [
      ["0136_plugin_enabled_follows_default", 1790889888606],
      ["0137_stiff_prism", 1790900209592],
    ] as const) {
      const sql = readFileSync(
        new URL(`../drizzle/${file}.sql`, import.meta.url),
        "utf8",
      );
      db.$client
        .prepare(
          "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)",
        )
        .run(createHash("sha256").update(sql).digest("hex"), timestamp);
    }
  }
  for (const [file, timestamp] of [
    ["0136_external_history", 1790837064310],
    ...(handles
      ? [["0137_external_session_handles", 1790941244761] as const]
      : []),
  ] as const) {
    const sql = readFileSync(
      new URL(
        `./fixtures/external-history-before-0.45/${file}.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    db.$client.exec(sql.replaceAll("--> statement-breakpoint", ""));
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)",
      )
      .run(createHash("sha256").update(sql).digest("hex"), timestamp);
  }
  const host = upsertHost(db, noopNotifier, { name: "test" });
  const { project } = createProject(db, noopNotifier, {
    name: "History",
    source: { type: "local_path", hostId: host.id, path: "/tmp/history" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "external-history",
    title: "Source",
  });
  db.$client
    .prepare(`INSERT INTO external_thread_bindings
    (thread_id,project_id,plugin_id,source_id,conversation_id,provider_id,session_id,generation,last_order)
    VALUES (?,?,'plugin','source','conversation','codex','session',4,20)`)
    .run(thread.id, project.id);
  if (handles)
    db.$client
      .prepare(
        "UPDATE external_thread_bindings SET runtime_provider_id = 'codex', runtime_session_id = 'original-handle'",
      )
      .run();
  db.$client
    .prepare(`INSERT INTO external_thread_messages
    (thread_id,generation,external_id,source_order,digest,session_id,source_sequence)
    VALUES (?,4,'original-message',20,'fingerprint','session',12)`)
    .run(thread.id);
  return db;
}

function ledger(db: ReturnType<typeof createConnection>) {
  return db.$client
    .prepare(
      "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
    )
    .all();
}

function hasDefaultColumn(db: ReturnType<typeof createConnection>) {
  return db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugins)")
    .all()
    .some((column) => column.name === "enabled_follows_default");
}

describe("external history upgrade onto 0.45.0", () => {
  it.each([false, true])(
    "preserves old history, handles and dedupe and applies skipped upstream migrations (handles=%s)",
    (handles) => {
      const db = legacyDatabase(handles);
      try {
        const messages = db.select().from(externalThreadMessages).all();
        migrate(db);
        expect(db.select().from(externalThreadMessages).all()).toEqual(
          messages,
        );
        expect(db.select().from(externalThreadBindings).all()).toMatchObject([
          {
            sessionId: "session",
            generation: 4,
            lastOrder: 20,
            runtimeProviderId: handles ? "codex" : null,
            runtimeSessionId: handles ? "original-handle" : null,
          },
        ]);
        expect(hasDefaultColumn(db)).toBe(true);
        expect(
          db.$client
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'prompt_history_entries_created_idx'",
            )
            .get(),
        ).toBeDefined();
        const migrated = ledger(db);
        migrate(db);
        expect(ledger(db)).toEqual(migrated);
        const reopened = createConnection(db.$client.serialize());
        try {
          migrate(reopened);
          expect(ledger(reopened)).toEqual(migrated);
        } finally {
          reopened.$client.close();
        }
      } finally {
        db.$client.close();
      }
    },
  );

  it("accepts an already-updated vanilla 0.45 schema with old PR history", () => {
    const db = legacyDatabase(true, true);
    try {
      migrate(db);
      expect(db.select().from(externalThreadMessages).all()).toHaveLength(1);
    } finally {
      db.$client.close();
    }
  });

  it.each(["hash", "schema", "interrupted", "upstream-hash", "external-hash"])(
    "rejects %s conflicts without partially upgrading",
    (conflict) => {
      const db = legacyDatabase(false);
      try {
        if (conflict === "hash")
          db.$client
            .prepare(
              "UPDATE __drizzle_migrations SET hash = 'unknown' WHERE created_at = 1790837064310",
            )
            .run();
        if (conflict === "schema")
          db.$client.exec("DROP INDEX external_thread_messages_order_idx");
        if (conflict === "interrupted")
          db.$client
            .exec(`CREATE TRIGGER reject_external_upgrade BEFORE INSERT ON __drizzle_migrations
        WHEN NEW.created_at = 1790889888606 BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
        if (conflict === "upstream-hash")
          db.$client
            .prepare(
              "INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('unknown', 1790889888606)",
            )
            .run();
        if (conflict === "external-hash") {
          const journal = JSON.parse(
            readFileSync(
              new URL("../drizzle/meta/_journal.json", import.meta.url),
              "utf8",
            ),
          ) as { entries: { tag: string; when: number }[] };
          const entry = journal.entries.find(
            (row) => row.tag === "0138_external_history",
          )!;
          db.$client
            .prepare(
              "INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('unknown', ?)",
            )
            .run(entry.when);
        }
        const before = ledger(db);
        const columns = db.$client
          .prepare("PRAGMA table_info(external_thread_bindings)")
          .all();
        expect(() => migrate(db)).toThrow();
        expect(ledger(db)).toEqual(before);
        expect(
          db.$client
            .prepare("PRAGMA table_info(external_thread_bindings)")
            .all(),
        ).toEqual(columns);
        expect(hasDefaultColumn(db)).toBe(false);
        if (conflict === "interrupted") {
          db.$client.exec("DROP TRIGGER reject_external_upgrade");
          migrate(db);
          expect(hasDefaultColumn(db)).toBe(true);
        }
      } finally {
        db.$client.close();
      }
    },
  );
});
