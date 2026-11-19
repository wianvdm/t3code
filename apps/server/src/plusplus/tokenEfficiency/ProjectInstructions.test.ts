import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectInstructions from "./ProjectInstructions.ts";
import * as TokenEfficiencySnapshotService from "./TokenEfficiencySnapshotService.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const instructions = { id: "snapshot-1", text: "<token_efficiency>rules</token_efficiency>" };
const enabledSettings: ServerSettingsValue = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: {
    [projectId]: { plusplus: { tokenEfficiency: true } },
  } as unknown as ServerSettingsValue["projectSettingsOverrides"],
};

const snapshotLayer = (reads: Ref.Ref<number>) =>
  Layer.succeed(TokenEfficiencySnapshotService.TokenEfficiencySnapshotService, {
    active: Ref.updateAndGet(reads, (count) => count + 1).pipe(
      Effect.as({
        instructions,
        provenance: { source: "bundled" as const, blobSha: "blob", adaptationVersion: 1 },
      }),
    ),
    view: Effect.die("view must not be read by the turn resolver"),
    refresh: Effect.die("refresh must not run on the turn path"),
  });

const resolverLayer = (settings: ServerSettingsValue, reads: Ref.Ref<number>) =>
  ProjectInstructions.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(settings),
      }),
    ),
    Layer.provide(snapshotLayer(reads)),
  );

describe("ProjectInstructionsResolver", () => {
  it.effect("defaults to disabled without production wiring", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectInstructions.ProjectInstructionsResolver;
      assert.deepEqual(yield* resolver.forProject(projectId), {});
    }),
  );

  it.effect("reads one active snapshot for an enabled project and none otherwise", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const resolver = yield* ProjectInstructions.ProjectInstructionsResolver.pipe(
        Effect.provide(resolverLayer(enabledSettings, reads)),
      );

      assert.deepEqual(yield* resolver.forProject(otherProjectId), {});
      assert.deepEqual(yield* resolver.forProject(projectId), {
        projectInstructions: instructions,
      });
      assert.equal(yield* Ref.get(reads), 1);
    }),
  );

  it.effect("keeps a settings read failure from failing the turn", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const settingsLayer = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.die("settings unavailable"),
      });
      const resolver = yield* ProjectInstructions.ProjectInstructionsResolver.pipe(
        Effect.provide(
          ProjectInstructions.layer.pipe(
            Layer.provide(settingsLayer),
            Layer.provide(snapshotLayer(reads)),
          ),
        ),
      );

      assert.deepEqual(yield* resolver.forProject(projectId), {});
      assert.equal(yield* Ref.get(reads), 0);
    }),
  );
});
