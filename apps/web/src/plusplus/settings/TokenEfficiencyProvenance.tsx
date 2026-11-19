import type { EnvironmentId } from "@t3tools/contracts";
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
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { refreshTokenEfficiency, tokenEfficiencyView } from "../state/tokenEfficiency";

interface ProvenanceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

function isTokenEfficiencyUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bUnknown request tag:/.test(message);
}

function LastSuccessfulCheck(props: {
  readonly value: TokenEfficiencyStatus["lastSuccessfulCheckAt"];
}) {
  const iso = props.value === null ? null : DateTime.formatIso(props.value);
  const relative = useRelativeTimeState(iso);
  if (iso === null) return "Never";
  if (relative.status !== "relative") return iso;
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function InstructionsDialog(props: { readonly instructions: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="xs" />}>
        View instructions
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Token-efficiency instructions</DialogTitle>
          <DialogDescription>{ATTRIBUTION_TEXT}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
            {props.instructions}
          </pre>
          <nav
            aria-label="Token-efficiency attribution"
            className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
          >
            <a
              href={TOKEN_EFFICIENCY_LINKS.core}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Upstream CORE
            </a>
            <a
              href={TOKEN_EFFICIENCY_LINKS.repository}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Repository
            </a>
            <a
              href={TOKEN_EFFICIENCY_LINKS.fullPlaybook}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Full playbook
            </a>
            <a
              href={TOKEN_EFFICIENCY_LINKS.license}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              MIT license
            </a>
          </nav>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentProvenance(props: {
  readonly environment: ProvenanceEnvironment;
  readonly showEnvironmentLabel: boolean;
}) {
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
      const detail = error instanceof Error ? ` ${error.message}.` : "";
      setRequestFailure(
        `Refresh failed.${detail} ${sourceLabel(view.status.active.source)} revision ${shortRevision(view.status.active.blobSha)} stays active.`,
      );
    }
    setRefreshing(false);
  };

  if (view === null) {
    let message = `Loading token-efficiency provenance on ${label}…`;
    if (result._tag === "Failure") {
      message = isTokenEfficiencyUnsupportedError(Cause.squash(result.cause))
        ? `Not supported on ${label}`
        : `Unavailable on ${label}`;
    }
    return <p className="text-muted-foreground text-sm">{message}</p>;
  }

  const active = view.status.active;
  const failureMessage =
    view.status.lastFailure === null ? null : refreshOutcomeMessage({ outcome: "failed", view });
  const outcomeMessage =
    outcome === null || outcome.outcome === "failed" ? null : refreshOutcomeMessage(outcome);
  const failedOutcomeMessage =
    outcome?.outcome === "failed" ? refreshOutcomeMessage(outcome) : null;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3 text-sm">
      {props.showEnvironmentLabel ? <h3 className="font-medium">{label}</h3> : null}
      <p>
        {sourceLabel(active.source)} · Revision {shortRevision(active.blobSha)}
        {active.source === "bundled" && active.upstreamCommit !== undefined
          ? ` · Pinned ${shortRevision(active.upstreamCommit)}`
          : ""}
      </p>
      <p className="text-muted-foreground">
        Last successful check: <LastSuccessfulCheck value={view.status.lastSuccessfulCheckAt} />
      </p>
      {(failedOutcomeMessage ?? failureMessage) ? (
        <p className="text-destructive">{failedOutcomeMessage ?? failureMessage}</p>
      ) : null}
      {outcomeMessage ? <p role="status">{outcomeMessage}</p> : null}
      {requestFailure ? <p className="text-destructive">{requestFailure}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={!canRefresh || refreshing}
          onClick={() => void refreshNow()}
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </Button>
        <InstructionsDialog instructions={view.instructions} />
      </div>
    </div>
  );
}

export function TokenEfficiencyProvenance(props: {
  readonly environments: readonly ProvenanceEnvironment[];
}) {
  const environments = [
    ...new Map(
      props.environments.map((environment) => [environment.environmentId, environment]),
    ).values(),
  ];
  return (
    <div className="space-y-3 px-4 pb-4 sm:px-5">
      {environments.map((environment) => (
        <EnvironmentProvenance
          key={environment.environmentId}
          environment={environment}
          showEnvironmentLabel={environments.length > 1}
        />
      ))}
    </div>
  );
}
