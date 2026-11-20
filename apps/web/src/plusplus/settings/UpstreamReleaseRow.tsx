import { T, useGT } from "gt-react";
import { useState } from "react";

import { APP_VERSION } from "../../branding";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  runManualUpstreamCheck,
  startUpstreamMerge,
  useUpstreamMergeEligible,
  useUpstreamRelease,
} from "../state/upstreamRelease";
import { Button } from "~/components/ui/button";
import {
  isUpstreamReleaseNotificationBuild,
  shouldDeferUpstreamMerge,
  upstreamBaseTagForVersion,
} from "../upstreamRelease.logic";
import { SettingsRow } from "~/components/settings/settingsLayout";

function UpstreamReleaseRowContent() {
  const gt = useGT();
  const eligible = useUpstreamMergeEligible();
  const newThread = useNewThreadHandler();
  const updateState = useDesktopUpdateState();
  const result = useUpstreamRelease();
  const [isChecking, setIsChecking] = useState(false);

  if (!eligible || !result || result.kind === "merged") {
    return null;
  }

  if (result.kind === "unknown") {
    const handleRetry = () => {
      setIsChecking(true);
      void runManualUpstreamCheck().finally(() => setIsChecking(false));
    };
    return (
      <SettingsRow
        title={gt("Upstream release")}
        description={gt("Upstream release status is unavailable.")}
        status={gt("The release check failed. Retry to check again.")}
        control={
          <Button size="sm" variant="outline" disabled={isChecking} onClick={handleRetry}>
            {isChecking ? gt("Checking…") : gt("Check again")}
          </Button>
        }
      />
    );
  }

  const deferMerge = shouldDeferUpstreamMerge(updateState);
  const handleStartMerge = () => {
    void startUpstreamMerge(result.tag, { newThread });
  };

  return (
    <SettingsRow
      title={gt("Upstream release")}
      description={gt("{tag} is ready to merge", { tag: result.tag })}
      status={
        deferMerge
          ? gt("Update the fork app first, then create the merge draft.")
          : gt("Creates a local merge draft thread in your fork checkout. Nothing is pushed.")
      }
      control={
        <Button size="sm" variant="outline" disabled={deferMerge} onClick={handleStartMerge}>
          <T>Create local upstream merge draft</T>
        </Button>
      }
    />
  );
}

export function UpstreamReleaseRow() {
  const gt = useGT();
  if (!isUpstreamReleaseNotificationBuild) {
    return null;
  }

  const upstreamBaseTag = upstreamBaseTagForVersion(APP_VERSION);

  return (
    <>
      <SettingsRow title={gt("Upstream base")} description={upstreamBaseTag} />
      <UpstreamReleaseRowContent />
    </>
  );
}
