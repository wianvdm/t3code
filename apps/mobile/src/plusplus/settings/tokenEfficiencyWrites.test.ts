import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "../../features/settings/settings-environment-filter";
import { resolveMobileSettingsTargets } from "../../features/settings/settings-scoped-server";
import {
  planMobileTokenEfficiencyWrites,
  readMobileTokenEfficiencyState,
} from "./tokenEfficiencyWrites";

const firstEnvironmentId = EnvironmentId.make("first");
const secondEnvironmentId = EnvironmentId.make("second");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");

function settings(projectSettingsOverrides: ServerSettings["projectSettingsOverrides"] = {}) {
  return { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides };
}

function environment(environmentId: EnvironmentId, serverSettings: ServerSettings) {
  return {
    environmentId,
    label: environmentId,
    serverConfig: { settings: serverSettings },
  } as unknown as SettingsTarget;
}

describe("mobile token efficiency writes", () => {
  it("derives the switch state across selected targets", () => {
    const targets = (states: [EnvironmentId, ProjectId, boolean][]) =>
      resolveMobileSettingsTargets(
        states.map(([environmentId, projectId, tokenEfficiency]) =>
          environment(
            environmentId,
            settings({
              [projectId]: { plusplus: { tokenEfficiency } } as ProjectSettingsOverrides,
            }),
          ),
        ),
        [
          { environmentId: firstEnvironmentId, id: firstProjectId },
          { environmentId: secondEnvironmentId, id: secondProjectId },
        ],
      );
    const firstOn: [EnvironmentId, ProjectId, boolean] = [firstEnvironmentId, firstProjectId, true];
    const secondOn: [EnvironmentId, ProjectId, boolean] = [
      secondEnvironmentId,
      secondProjectId,
      true,
    ];
    const secondOff: [EnvironmentId, ProjectId, boolean] = [
      secondEnvironmentId,
      secondProjectId,
      false,
    ];

    expect(readMobileTokenEfficiencyState(targets([firstOn, secondOn]))).toBe(true);
    expect(readMobileTokenEfficiencyState(targets([secondOff, secondOff]))).toBe(false);
    expect(readMobileTokenEfficiencyState(targets([firstOn, secondOff]))).toBeNull();
    expect(readMobileTokenEfficiencyState(targets([]))).toBe(false);
  });

  it("writes each member and preserves existing override keys", () => {
    const targets = resolveMobileSettingsTargets(
      [
        environment(firstEnvironmentId, settings({ [firstProjectId]: { defaultAutoPull: true } })),
        environment(secondEnvironmentId, settings()),
      ],
      [
        { environmentId: firstEnvironmentId, id: firstProjectId },
        { environmentId: secondEnvironmentId, id: secondProjectId },
      ],
    );

    expect(planMobileTokenEfficiencyWrites(targets, true)).toEqual([
      {
        environmentId: firstEnvironmentId,
        patch: {
          projectSettingsOverrides: {
            [firstProjectId]: {
              defaultAutoPull: true,
              plusplus: { tokenEfficiency: true },
            },
          },
        },
      },
      {
        environmentId: secondEnvironmentId,
        patch: {
          projectSettingsOverrides: {
            [secondProjectId]: { plusplus: { tokenEfficiency: true } },
          },
        },
      },
    ]);
  });

  it("skips members without a connected selected environment", () => {
    const targets = resolveMobileSettingsTargets(
      [environment(firstEnvironmentId, settings())],
      [
        { environmentId: firstEnvironmentId, id: firstProjectId },
        { environmentId: secondEnvironmentId, id: secondProjectId },
      ],
    );
    expect(targets.map((target) => target.projectId)).toEqual([firstProjectId]);
    expect(planMobileTokenEfficiencyWrites(targets, true)).toEqual([
      {
        environmentId: firstEnvironmentId,
        patch: {
          projectSettingsOverrides: {
            [firstProjectId]: { plusplus: { tokenEfficiency: true } },
          },
        },
      },
    ]);
  });

  it("preserves other sidecar areas and removes an otherwise empty entry on disable", () => {
    const targets = resolveMobileSettingsTargets(
      [
        environment(
          firstEnvironmentId,
          settings({
            [firstProjectId]: {
              defaultAutoPull: true,
              plusplus: { tokenEfficiency: true, futureArea: { retained: true } },
            } as ProjectSettingsOverrides,
          }),
        ),
        environment(
          secondEnvironmentId,
          settings({
            [secondProjectId]: { plusplus: { tokenEfficiency: true } } as ProjectSettingsOverrides,
          }),
        ),
      ],
      [
        { environmentId: firstEnvironmentId, id: firstProjectId },
        { environmentId: secondEnvironmentId, id: secondProjectId },
      ],
    );

    expect(
      planMobileTokenEfficiencyWrites(targets, false).map(
        (write) => write.patch.projectSettingsOverrides,
      ),
    ).toEqual([
      {
        [firstProjectId]: {
          defaultAutoPull: true,
          plusplus: { futureArea: { retained: true } },
        },
      },
      { [secondProjectId]: null },
    ]);
  });
});
