import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import {
  PROJECT_INSTRUCTIONS_DELIVERY,
  PROJECT_INSTRUCTIONS_PENDING,
  type ProjectInstructionsDeliveryByVersion,
  type ProjectInstructionsDeliveryRow,
} from "./deliveryMatrix.ts";

const isVersioned = (
  row: ProjectInstructionsDeliveryRow,
): row is ProjectInstructionsDeliveryByVersion => "versions" in row;

const registryKinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const opencode = ProviderDriverKind.make("opencode");

describe("PROJECT_INSTRUCTIONS_DELIVERY", () => {
  it("keys the matrix to exactly the registry kinds", () => {
    expect(
      [...Object.keys(PROJECT_INSTRUCTIONS_DELIVERY), ...PROJECT_INSTRUCTIONS_PENDING].sort(),
    ).toEqual([...registryKinds].sort());
  });

  it("gives every built-in driver kind a row or an explicit pending decision", () => {
    for (const kind of registryKinds) {
      const hasRow = PROJECT_INSTRUCTIONS_DELIVERY[kind] !== undefined;
      const isPending = PROJECT_INSTRUCTIONS_PENDING.includes(kind);
      expect(
        hasRow !== isPending,
        `${kind} must have exactly one of a delivery row and a pending entry`,
      ).toBe(true);
    }
    for (const kind of PROJECT_INSTRUCTIONS_PENDING) {
      expect(
        registryKinds.includes(kind),
        `${kind} is pending but is not a built-in driver kind`,
      ).toBe(true);
    }
  });

  it("claims native-subagent coverage on no row", () => {
    for (const delivery of Object.values(PROJECT_INSTRUCTIONS_DELIVERY)) {
      expect(delivery?.nativeSubagents).toBe("not-covered");
    }
  });

  it("gives every versioned row at least one version", () => {
    for (const delivery of Object.values(PROJECT_INSTRUCTIONS_DELIVERY)) {
      if (delivery !== undefined && isVersioned(delivery)) {
        expect(Object.keys(delivery.versions).length).toBeGreaterThan(0);
      }
    }
  });

  it("covers Claude, Codex, and OpenCode", () => {
    expect(PROJECT_INSTRUCTIONS_DELIVERY[claudeAgent]).toBeDefined();
    expect(PROJECT_INSTRUCTIONS_DELIVERY[codex]).toBeDefined();
    expect(PROJECT_INSTRUCTIONS_DELIVERY[opencode]).toBeDefined();
  });
});
