// @effect-diagnostics nodeBuiltinImport:off - Fixture setup exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { runMigrations } from "./Migrations.ts";
import { OldForkImportError, mergeOldForkDatabase } from "./importOldFork.ts";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
}));

const SQLITE_BUSY = 5;

const makeHome = (root: string, name: string) => {
  const home = NodePath.join(root, name);
  const userdata = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  return { home, userdata, dbPath: NodePath.join(userdata, "statev2.sqlite") };
};

const seedDatabase = (
  dbPath: string,
  input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly wal?: boolean;
  },
) =>
  Effect.gen(function* () {
    yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    yield* Effect.sync(() => {
      const database = new NodeSqlite.DatabaseSync(dbPath);
      try {
        if (input.wal) {
          database.exec("PRAGMA journal_mode = WAL;");
        }
        const insertEvent = database.prepare(`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json,
            metadata_json, application_event_version
          ) VALUES (?, ?, ?, 0, ?, '2026-01-01T00:00:00.000Z', ?, NULL, ?, 'client', ?, '{}', 2)
        `);
        const projectEventId = `${input.projectId}-created`;
        insertEvent.run(
          projectEventId,
          "project",
          input.projectId,
          "project.created",
          `command:${projectEventId}`,
          `command:${projectEventId}`,
          JSON.stringify({
            projectId: input.projectId,
            title: input.projectId,
            workspaceRoot: `/workspace/${input.projectId}`,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
        );
        const threadEventId = `${input.threadId}-created`;
        insertEvent.run(
          threadEventId,
          "thread",
          input.threadId,
          "thread.created",
          `command:${threadEventId}`,
          `command:${threadEventId}`,
          JSON.stringify({
            createdBy: "user",
            creationSource: "web",
            id: input.threadId,
            projectId: input.projectId,
            title: input.threadId,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: input.threadId,
            },
            forkedFrom: null,
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          }),
        );
      } finally {
        database.close();
      }
    });
  });

const assertNonTerminalBusyError = (
  error: OldForkImportError,
  destinationPath: string,
  markerPath: string,
) => {
  expect(error).toBeInstanceOf(OldForkImportError);
  assert.isTrue(Predicate.isTagged(error.cause, "OldForkMergeError"));
  const mergeError = error.cause as unknown as {
    readonly terminal: boolean;
    readonly reason: string;
  };
  assert.equal(mergeError.terminal, false);
  expect(mergeError.reason).toContain(`Another process has ${destinationPath} open`);
  assert.isFalse(NodeFS.existsSync(`${markerPath}.state`));
  assert.isFalse(NodeFS.existsSync(markerPath));
};

describe("mergeOldForkDatabase busy destination handling", () => {
  it.effect(
    "reports a WAL destination held inside BEGIN EXCLUSIVE as a non-terminal open error",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-wal-busy-"));
      return Effect.gen(function* () {
        const source = makeHome(directory, "source");
        const destination = makeHome(directory, "destination");
        const markerPath = NodePath.join(directory, "old-fork-merge.marker");
        yield* seedDatabase(source.dbPath, {
          projectId: "source-project",
          threadId: "source-thread",
        });
        yield* seedDatabase(destination.dbPath, {
          projectId: "destination-project",
          threadId: "destination-thread",
          wal: true,
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
          (holder) =>
            Effect.sync(() => {
              try {
                holder.exec("ROLLBACK;");
              } finally {
                holder.close();
              }
            }),
        );

        assertNonTerminalBusyError(error, destination.dbPath, markerPath);

        const retryOutcome = yield* mergeOldForkDatabase({
          sourceHome: source.home,
          destinationHome: destination.home,
          markerPath,
        });
        assert.deepEqual(retryOutcome, { status: "done" });
        assert.isTrue(NodeFS.existsSync(markerPath));
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect(
    "reports a busy destination during candidate backup as a non-terminal open error",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-merge-backup-busy-"));
      return Effect.gen(function* () {
        const source = makeHome(directory, "source");
        const destination = makeHome(directory, "destination");
        const markerPath = NodePath.join(directory, "old-fork-merge.marker");
        yield* seedDatabase(source.dbPath, {
          projectId: "source-project",
          threadId: "source-thread",
        });
        yield* seedDatabase(destination.dbPath, {
          projectId: "destination-project",
          threadId: "destination-thread",
        });

        const originalBackup = NodeSqlite.backup;
        const error = yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(NodeSqlite, "backup").mockImplementation((database, toPath, ...rest) => {
              if (String(toPath).endsWith("candidate.sqlite")) {
                return Promise.reject(
                  Object.assign(new Error("database is locked"), {
                    code: "ERR_SQLITE_ERROR",
                    errcode: SQLITE_BUSY,
                  }),
                );
              }
              return originalBackup(database, toPath, ...rest);
            }),
          ),
          () =>
            mergeOldForkDatabase({
              sourceHome: source.home,
              destinationHome: destination.home,
              markerPath,
            }).pipe(Effect.flip),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );

        assertNonTerminalBusyError(error, destination.dbPath, markerPath);

        const retryOutcome = yield* mergeOldForkDatabase({
          sourceHome: source.home,
          destinationHome: destination.home,
          markerPath,
        });
        assert.deepEqual(retryOutcome, { status: "done" });
        assert.isTrue(NodeFS.existsSync(markerPath));
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    },
  );
});
