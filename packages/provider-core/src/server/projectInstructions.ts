import type {
  ProjectInstructions,
  ProjectInstructionsChange,
} from "@t3tools/plusplus/projectInstructions";
import { planProjectInstructionsChange } from "@t3tools/plusplus/projectInstructions";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export {
  chunkProjectInstructions,
  planProjectInstructionsChange,
} from "@t3tools/plusplus/projectInstructions";
export type {
  ProjectInstructions,
  ProjectInstructionsChange,
} from "@t3tools/plusplus/projectInstructions";
export { BUNDLED_CORE } from "@t3tools/plusplus/tokenEfficiency/bundledCore";
export {
  adaptCore,
  formatTokenEfficiencyInstructions,
  tokenEfficiencyInstructionsId,
} from "@t3tools/plusplus/tokenEfficiency/core";

export interface ProjectInstructionsDeliveryPlan {
  readonly change: ProjectInstructionsChange;
  readonly text: string | undefined;
  readonly commit: Effect.Effect<void>;
}

export interface ProjectInstructionsDeliveryTracker {
  readonly plan: (
    sessionKey: string,
    current: ProjectInstructions | undefined,
  ) => Effect.Effect<ProjectInstructionsDeliveryPlan>;
  readonly forget: (sessionKey: string) => Effect.Effect<void>;
}

interface DeliveryState {
  readonly deliveredId: string | null;
  readonly generation: number;
}

export const makeProjectInstructionsDeliveryTracker: Effect.Effect<ProjectInstructionsDeliveryTracker> =
  Effect.gen(function* () {
    const states = yield* Ref.make(new Map<string, DeliveryState>());

    const plan = Effect.fn("ProjectInstructionsDeliveryTracker.plan")(function* (
      sessionKey: string,
      current: ProjectInstructions | undefined,
    ) {
      const state = (yield* Ref.get(states)).get(sessionKey);
      const generation = state?.generation ?? 0;
      const change = planProjectInstructionsChange(state?.deliveredId ?? null, current);
      const commit = Ref.update(states, (states) => {
        const latest = states.get(sessionKey);
        if ((latest?.generation ?? 0) !== generation || change._tag === "Unchanged") return states;
        const next = new Map(states);
        next.set(sessionKey, {
          deliveredId: change._tag === "Deliver" ? change.instructions.id : null,
          generation,
        });
        return next;
      });
      return {
        change,
        text: change._tag === "Deliver" ? change.instructions.text : undefined,
        commit,
      };
    });

    const forget = (sessionKey: string) =>
      Ref.update(states, (states) => {
        const next = new Map(states);
        next.set(sessionKey, {
          deliveredId: null,
          generation: (states.get(sessionKey)?.generation ?? 0) + 1,
        });
        return next;
      });

    return { plan, forget };
  });
