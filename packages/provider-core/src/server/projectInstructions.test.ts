import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeProjectInstructionsDeliveryTracker } from "./projectInstructions.ts";

const instructions = { id: "revision-1", text: "Instructions" };

describe("makeProjectInstructionsDeliveryTracker", () => {
  it.effect("delivers once, redelivers changes, and forgets delivered state", () =>
    Effect.gen(function* () {
      const tracker = yield* makeProjectInstructionsDeliveryTracker;

      const first = yield* tracker.plan("session", instructions);
      assert.equal(first.text, instructions.text);
      yield* first.commit;
      assert.equal((yield* tracker.plan("session", instructions)).text, undefined);

      const changed = yield* tracker.plan("session", { ...instructions, id: "revision-2" });
      assert.equal(changed.text, instructions.text);
      yield* changed.commit;
      yield* tracker.forget("session");
      assert.equal((yield* tracker.plan("session", instructions)).text, instructions.text);
    }),
  );

  it.effect("does not commit a plan superseded by forget", () =>
    Effect.gen(function* () {
      const tracker = yield* makeProjectInstructionsDeliveryTracker;
      const planned = yield* tracker.plan("session", instructions);

      yield* tracker.forget("session");
      yield* planned.commit;

      const next = yield* tracker.plan("session", instructions);
      assert.equal(next.change._tag, "Deliver");
      assert.equal(next.text, instructions.text);
    }),
  );

  it.effect("tracks sessions independently and records withdrawal", () =>
    Effect.gen(function* () {
      const tracker = yield* makeProjectInstructionsDeliveryTracker;
      const delivered = yield* tracker.plan("session-a", instructions);
      yield* delivered.commit;

      assert.equal((yield* tracker.plan("session-b", instructions)).change._tag, "Deliver");
      const withdrawn = yield* tracker.plan("session-a", undefined);
      assert.equal(withdrawn.change._tag, "Withdraw");
      assert.equal(withdrawn.text, undefined);
      yield* withdrawn.commit;
      assert.equal((yield* tracker.plan("session-a", undefined)).change._tag, "Unchanged");
    }),
  );
});
