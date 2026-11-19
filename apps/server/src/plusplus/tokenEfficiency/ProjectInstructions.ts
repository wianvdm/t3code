import type { ProjectId } from "@t3tools/contracts";
import { readProjectTokenEfficiency } from "@t3tools/plusplus/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../serverSettings.ts";
import * as TokenEfficiencySnapshotService from "./TokenEfficiencySnapshotService.ts";

export class ProjectInstructionsResolver extends Context.Reference<{
  readonly forProject: (
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly projectInstructions?: ProjectInstructions }>;
}>("t3/plusplus/ProjectInstructionsResolver", {
  defaultValue: () => ({ forProject: () => Effect.succeed({}) }),
}) {}

/** Reads settings (in memory) and the active snapshot Ref. No disk, network or refresh work. */
export const layer = Layer.effect(
  ProjectInstructionsResolver,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;

    const forProject = Effect.fn("ProjectInstructionsResolver.forProject")(function* (
      projectId: ProjectId,
    ) {
      const current = yield* settings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("token-efficiency.settings-read-failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (current === null || !readProjectTokenEfficiency(current, projectId)) return {};
      return { projectInstructions: (yield* snapshots.active).instructions };
    });

    return { forProject };
  }),
);
