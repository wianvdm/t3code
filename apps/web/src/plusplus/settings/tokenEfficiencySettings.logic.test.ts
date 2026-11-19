import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";
import {
  planTokenEfficiencyPatch,
  tokenEfficiencyEnabled,
  tokenEfficiencyMixed,
} from "./tokenEfficiencySettings.logic";

const firstEnvironmentId = EnvironmentId.make("first");
const secondEnvironmentId = EnvironmentId.make("second");
const offlineEnvironmentId = EnvironmentId.make("offline");
const firstProjectId = ProjectId.make("first-project");
const secondProjectId = ProjectId.make("second-project");
const offlineProjectId = ProjectId.make("offline-project");

type ProjectScope = Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>;

function settings(projectSettingsOverrides: ServerSettings["projectSettingsOverrides"] = {}) {
  return { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides };
}

function environment(
  environmentId: EnvironmentId,
  serverSettings: ServerSettings,
  connected = true,
) {
  return {
    environmentId,
    label: environmentId,
    connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
    serverConfig: { settings: serverSettings },
  };
}

function scope() {
  return {
    kind: "project",
    members: [
      { id: firstProjectId, environmentId: firstEnvironmentId },
      { id: secondProjectId, environmentId: secondEnvironmentId },
      { id: offlineProjectId, environmentId: offlineEnvironmentId },
    ],
  } as unknown as ProjectScope;
}

describe("token efficiency settings", () => {
  it("writes each connected member and preserves existing override keys", () => {
    const environments = [
      environment(firstEnvironmentId, settings({ [firstProjectId]: { defaultAutoPull: true } })),
      environment(secondEnvironmentId, settings()),
      environment(offlineEnvironmentId, settings(), false),
    ];

    expect(planTokenEfficiencyPatch(scope(), environments, true)).toMatchObject({
      hasClientWrite: false,
      serverWrites: [
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
      ],
      unavailableReason: null,
    });
  });

  it("reports unavailable when every member is offline", () => {
    const plan = planTokenEfficiencyPatch(
      {
        kind: "project",
        members: [{ id: offlineProjectId, environmentId: offlineEnvironmentId }],
      } as unknown as ProjectScope,
      [environment(offlineEnvironmentId, settings(), false)],
      true,
    );
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toBe(
      "Connect the selected checkouts, or update their environments, to save a project override.",
    );
  });

  it("detects mixed groups and requires every member to be enabled", () => {
    const enabled = settings({
      [firstProjectId]: { plusplus: { tokenEfficiency: true } } as ProjectSettingsOverrides,
    });
    const disabled = settings();
    const targets = [
      { projectId: firstProjectId, settings: enabled },
      { projectId: secondProjectId, settings: disabled },
    ];
    expect(tokenEfficiencyMixed(targets)).toBe(true);
    expect(tokenEfficiencyEnabled(targets)).toBe(false);
    expect(tokenEfficiencyMixed(targets.slice(0, 1))).toBe(false);
    expect(tokenEfficiencyEnabled(targets.slice(0, 1))).toBe(true);
    expect(tokenEfficiencyEnabled([])).toBe(false);
  });

  it("disables only the sidecar area and removes an otherwise empty entry", () => {
    const plan = planTokenEfficiencyPatch(
      scope(),
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
        environment(offlineEnvironmentId, settings(), false),
      ],
      false,
    );

    expect(plan.serverWrites.map((write) => write.patch.projectSettingsOverrides)).toEqual([
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
