// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runMigrations } from "./Migrations.ts";
import { OldForkImportError, mergeOldForkDatabase } from "./importOldFork.ts";

const makeHome = (root: string, name: string) => {
  const home = NodePath.join(root, name);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  return { home, dbPath: NodePath.join(home, "userdata", "statev2.sqlite") };
};

const isOldForkMergeError = Schema.is(
  Schema.TaggedStruct("OldForkMergeError", {
    terminal: Schema.Boolean,
    reason: Schema.String,
  }),
);

it.effect(
  "reports a WAL destination held inside BEGIN EXCLUSIVE as a non-terminal open error",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-wal-busy-"));
    return Effect.gen(function* () {
      const source = makeHome(directory, "source");
      const destination = makeHome(directory, "destination");
      const markerPath = NodePath.join(directory, "old-fork-merge.marker");

      new NodeSqlite.DatabaseSync(source.dbPath).close();
      yield* runMigrations().pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: destination.dbPath })),
      );
      yield* Effect.sync(() => {
        const database = new NodeSqlite.DatabaseSync(destination.dbPath);
        try {
          database.exec(
            `PRAGMA journal_mode = WAL;
             INSERT INTO orchestration_events (
               event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
               command_id, causation_event_id, correlation_id, actor_kind, payload_json,
               metadata_json, application_event_version
             ) VALUES ('p1-created', 'project', 'p1', 0, 'project.created',
               '2026-01-01T00:00:00.000Z', 'cmd:p1', NULL, 'cmd:p1', 'client', '{}', '{}', 2);`,
          );
        } finally {
          database.close();
        }
      });

      const error = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const holder = new NodeSqlite.DatabaseSync(destination.dbPath);
          holder.exec("BEGIN EXCLUSIVE;");
          return holder;
        }),
        () =>
          mergeOldForkDatabase({
            sourceHome: source.home,
            destinationHome: destination.home,
            markerPath,
          }).pipe(Effect.flip),
        (holder) => Effect.sync(() => holder.close()),
      );

      assert.instanceOf(error, OldForkImportError);
      if (!isOldForkMergeError(error.cause)) {
        assert.fail("Expected OldForkMergeError cause");
      }
      assert.isFalse(error.cause.terminal);
      assert.include(error.cause.reason, `Another process has ${destination.dbPath} open`);
      assert.isFalse(NodeFS.existsSync(`${markerPath}.state`));
      assert.isFalse(NodeFS.existsSync(markerPath));
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
