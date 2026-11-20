import type {
  TokenEfficiencyRefreshResult,
  TokenEfficiencyStatus,
} from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  ATTRIBUTION_TEXT,
  refreshOutcomeMessage,
  shortRevision,
  sourceLabel,
  TOKEN_EFFICIENCY_LINKS,
} from "@t3tools/plusplus-extensions/tokenEfficiency";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useState } from "react";
import { Linking, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { SettingsTarget } from "../../features/settings/settings-environment-filter";
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshTokenEfficiency, tokenEfficiencyView } from "../state/tokenEfficiency";

const ATTRIBUTION_LINKS = [
  { label: msg("Upstream CORE"), url: TOKEN_EFFICIENCY_LINKS.core },
  { label: msg("Repository"), url: TOKEN_EFFICIENCY_LINKS.repository },
  { label: msg("Full playbook"), url: TOKEN_EFFICIENCY_LINKS.fullPlaybook },
  { label: msg("MIT license"), url: TOKEN_EFFICIENCY_LINKS.license },
] as const;

function isTokenEfficiencyUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bUnknown request tag:/.test(message);
}

function withTerminalPunctuation(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function LastSuccessfulCheck(props: {
  readonly value: TokenEfficiencyStatus["lastSuccessfulCheckAt"];
}) {
  const gt = useGT();
  if (props.value === null) return gt("Never", { $context: "last successful check time" });
  return (
    <T>
      <Var>
        <RelativeTime timestamp={DateTime.formatIso(props.value)} />
      </Var>{" "}
      ago
    </T>
  );
}

function openUrl(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

function EnvironmentProvenance(props: {
  readonly environment: SettingsTarget;
  readonly showEnvironmentLabel: boolean;
}) {
  const gt = useGT();
  const { environmentId, label } = props.environment;
  const result = useAtomValue(tokenEfficiencyView({ environmentId, input: {} }));
  const canRefresh = useAtomValue(refreshTokenEfficiency.permissionAtom(environmentId));
  const refresh = useAtomCommand(refreshTokenEfficiency, {
    label: "Refresh token-efficiency instructions",
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [outcome, setOutcome] = useState<TokenEfficiencyRefreshResult | null>(null);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const view = AsyncResult.getOrElse(result, () => null);

  const refreshNow = async () => {
    if (!canRefresh || refreshing || view === null) return;
    setRefreshing(true);
    setRequestFailure(null);
    const next = await refresh({ environmentId, input: {} });
    if (next._tag === "Success") {
      setOutcome(next.value);
    } else if (!isAtomCommandInterrupted(next)) {
      const error = squashAtomCommandFailure(next);
      const active = {
        source: sourceLabel(view.status.active.source),
        revision: shortRevision(view.status.active.blobSha),
      };
      setRequestFailure(
        error instanceof Error
          ? gt("Refresh failed. {detail} {source} revision {revision} stays active.", {
              ...active,
              detail: withTerminalPunctuation(error.message),
            })
          : gt("Refresh failed. {source} revision {revision} stays active.", active),
      );
    }
    setRefreshing(false);
  };

  if (view === null) {
    let message = gt("Loading token-efficiency provenance on {environment}…", {
      environment: label,
    });
    if (result._tag === "Failure") {
      message = isTokenEfficiencyUnsupportedError(Cause.squash(result.cause))
        ? gt("Not supported on {environment}", { environment: label })
        : gt("Unavailable on {environment}", { environment: label });
    }
    return (
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {message}
      </Text>
    );
  }

  const active = view.status.active;
  const failureMessage =
    view.status.lastFailure === null ? null : refreshOutcomeMessage({ outcome: "failed", view });
  const outcomeMessage =
    outcome === null || outcome.outcome === "failed" ? null : refreshOutcomeMessage(outcome);
  const failedOutcomeMessage =
    outcome?.outcome === "failed" ? refreshOutcomeMessage(outcome) : null;

  return (
    <View className="gap-3 px-2 py-3">
      {props.showEnvironmentLabel ? <Text className="font-t3-medium">{label}</Text> : null}
      <Text textRole="footnote">
        {active.source === "bundled" && active.upstreamCommit !== undefined
          ? gt("{source} · Revision {revision} · Pinned {pinned}", {
              source: sourceLabel(active.source),
              revision: shortRevision(active.blobSha),
              pinned: shortRevision(active.upstreamCommit),
            })
          : gt("{source} · Revision {revision}", {
              source: sourceLabel(active.source),
              revision: shortRevision(active.blobSha),
            })}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        <T>
          Last successful check:{" "}
          <Var>
            <LastSuccessfulCheck value={view.status.lastSuccessfulCheckAt} />
          </Var>
        </T>
      </Text>
      {(failedOutcomeMessage ?? failureMessage) ? (
        <Text textRole="footnote" className="text-danger">
          {failedOutcomeMessage ?? failureMessage}
        </Text>
      ) : null}
      {outcomeMessage ? <Text textRole="footnote">{outcomeMessage}</Text> : null}
      {requestFailure ? (
        <Text textRole="footnote" className="text-danger">
          {requestFailure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={refreshing ? gt("Refreshing…") : gt("Refresh now")}
          size="compact"
          disabled={!canRefresh || refreshing}
          loading={refreshing}
          onPress={() => void refreshNow()}
        />
        <Button
          label={gt("View instructions")}
          size="compact"
          onPress={() =>
            Dialog.alert(
              gt("Token-efficiency instructions"),
              `${view.instructions}\n\n${ATTRIBUTION_TEXT}`,
            )
          }
        />
      </View>
    </View>
  );
}

export function TokenEfficiencyProvenance(props: {
  readonly environments: readonly SettingsTarget[];
}) {
  const m = useMessages();
  const environments = [
    ...new Map(
      props.environments.map((environment) => [environment.environmentId, environment]),
    ).values(),
  ];
  return (
    <View>
      {environments.map((environment) => (
        <EnvironmentProvenance
          key={environment.environmentId}
          environment={environment}
          showEnvironmentLabel={environments.length > 1}
        />
      ))}
      <View className="gap-3 px-2 pb-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {ATTRIBUTION_TEXT}
        </Text>
        <View className="flex-row flex-wrap gap-x-4 gap-y-2">
          {ATTRIBUTION_LINKS.map((link) => (
            <Text
              key={link.url}
              accessibilityRole="link"
              className="text-foreground underline"
              onPress={() => openUrl(link.url)}
            >
              {m(link.label)}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}
