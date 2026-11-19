// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { withProjectTokenEfficiency } from "@t3tools/plusplus/contracts";
import { BUNDLED_CORE } from "@t3tools/plusplus/tokenEfficiency/bundledCore";
import { gitBlobSha, tokenEfficiencyInstructionsId } from "@t3tools/plusplus/tokenEfficiency/core";
import { MAX_CORE_BYTES } from "@t3tools/plusplus/tokenEfficiency/source";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TokenEfficiencySnapshotService from "./TokenEfficiencySnapshotService.ts";

const join = NodePath.join;

const PROJECT_ID = "project-token-efficiency" as ProjectId;
const EPOCH = "1970-01-01T00:00:00.000Z";
const REFERRAL = "For the full playbook, invoke the `token-efficiency` skill.";
const UPSTREAM_RAW = BUNDLED_CORE.raw.replace("Minimize total cost", "Minimize upstream cost");
const UPSTREAM_SHA = gitBlobSha(new TextEncoder().encode(UPSTREAM_RAW));

const ENABLED_OVERRIDE = withProjectTokenEfficiency({}, true);
if (ENABLED_OVERRIDE === null) throw new Error("Enabling must retain the test override entry.");

const enabledSettings = (enabled: boolean): ServerSettingsValue => ({
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: enabled ? { [PROJECT_ID]: ENABLED_OVERRIDE } : {},
});

const cacheFile = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    raw: BUNDLED_CORE.raw,
    blobSha: BUNDLED_CORE.blobSha,
    etag: '"cached-etag"',
    adaptationVersion: 1,
    fetchedAt: EPOCH,
    lastSuccessfulCheckAt: EPOCH,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    lastFailure: null,
    ...overrides,
  });

type ResponseOptions = {
  readonly status?: number;
  readonly body?: string | Uint8Array | null;
  readonly headers?: Record<string, string>;
};

const response = (request: HttpClientRequest.HttpClientRequest, options: ResponseOptions = {}) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      new Response(options.body === undefined ? UPSTREAM_RAW : options.body, {
        status: options.status ?? 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          etag: '"new-etag"',
          ...options.headers,
        },
      }),
    ),
  );

type Handler = (
  request: HttpClientRequest.HttpClientRequest,
  fiber: Fiber.Fiber<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const settingsLayer = (
  initial: ServerSettingsValue,
  beforeGetSettings: Effect.Effect<void> = Effect.void,
) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      const changes = yield* Queue.unbounded<ServerSettingsValue>();
      const updateSettings: ServerSettings.ServerSettingsService["Service"]["updateSettings"] = (
        patch,
      ) =>
        Ref.updateAndGet(ref, (current) => {
          const next = applyServerSettingsPatch(current, patch);
          const entry = patch.projectSettingsOverrides?.[PROJECT_ID];
          if (entry === null || entry === undefined) return next;
          // The mock models storage of a ++ sidecar, not upstream's new-unknown-key client guard.
          return {
            ...next,
            projectSettingsOverrides: { ...next.projectSettingsOverrides, [PROJECT_ID]: entry },
          };
        }).pipe(Effect.tap((next) => Queue.offer(changes, next)));
      return {
        start: Effect.void,
        ready: Effect.void,
        getSettings: beforeGetSettings.pipe(Effect.andThen(Ref.get(ref))),
        updateSettings,
        updateProviderInstance: () => Effect.die(new Error("Not used by this test")),
        withSettingsSnapshot: (use) => Ref.get(ref).pipe(Effect.flatMap(use)),
        streamChanges: Stream.fromQueue(changes),
        subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      };
    }),
  );

const testLayer = (options: {
  readonly handler: Handler;
  readonly enabled?: boolean;
  readonly seed?: string;
  readonly blockCacheDirectory?: boolean;
  readonly beforeGetSettings?: Effect.Effect<void>;
}) => {
  const client = HttpClient.make((request, _url, _signal, fiber) =>
    options.handler(request, fiber),
  );
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "token-efficiency-snapshot-",
  }).pipe(Layer.provide(NodeServices.layer));
  const serviceLayer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = join(config.stateDir, "plusplus", "token-efficiency");
      if (options.seed !== undefined) {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(join(directory, "core-cache.json"), options.seed);
      }
      if (options.blockCacheDirectory === true) {
        yield* fileSystem.makeDirectory(join(directory, `core-cache-${process.pid}.tmp`), {
          recursive: true,
        });
      }
      return TokenEfficiencySnapshotService.layer;
    }),
  );
  return serviceLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        configLayer,
        Layer.succeed(HttpClient.HttpClient, client),
        settingsLayer(enabledSettings(options.enabled ?? false), options.beforeGetSettings),
      ),
    ),
    Layer.provideMerge(TestClock.layer()),
  );
};

describe("snapshot hydration", () => {
  it.effect("uses the bundled snapshot when the cache is missing, with all projects disabled", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const view = yield* snapshots.view;
      expect(view.status.active.source).toBe("bundled");
      expect(view.status.active.blobSha).toBe(BUNDLED_CORE.blobSha);
      expect(view.status.lastFailure).toBeNull();
      expect(view.status.automaticRefresh).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer({ handler: () => Effect.die(new Error("Hydration must not fetch")) }),
      ),
    ),
  );

  it.effect("hydrates valid upstream content with all projects disabled", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const view = yield* snapshots.view;
      expect(view.status.active.source).toBe("upstream");
      expect(view.status.active.blobSha).toBe(BUNDLED_CORE.blobSha);
      expect(view.status.lastFailure).toBeNull();
    }).pipe(
      Effect.provide(
        testLayer({
          seed: cacheFile(),
          handler: () => Effect.die(new Error("Hydration must not fetch")),
        }),
      ),
    ),
  );

  it.effect.each([
    { name: "corrupt JSON", seed: "{" },
    { name: "a blob mismatch", seed: cacheFile({ blobSha: "0".repeat(40) }) },
    { name: "a NUL byte", seed: cacheFile({ raw: `before\0after\n\n${REFERRAL}` }) },
    {
      name: "an over-limit body",
      seed: cacheFile({ raw: "a".repeat(MAX_CORE_BYTES + 1) }),
    },
    { name: "an old adaptation", seed: cacheFile({ adaptationVersion: 0 }) },
  ])("falls back for $name", ({ seed }) =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const view = yield* snapshots.view;
      expect(view.status.active.source).toBe("bundled");
      expect(view.status.lastFailure?.reason).toBe("cache-invalid");
    }).pipe(
      Effect.provide(
        testLayer({ seed, handler: () => Effect.die(new Error("Hydration must not fetch")) }),
      ),
    ),
  );
});

describe("successful refreshes", () => {
  it.effect("persists a valid 200 before exposing its active snapshot", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const handler: Handler = (request) => {
      requests.push(request);
      return response(request);
    };
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const result = yield* snapshots.refresh;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const cache = yield* fileSystem.readFileString(
        join(config.stateDir, "plusplus", "token-efficiency", "core-cache.json"),
      );
      const active = yield* snapshots.active;
      expect(result.outcome).toBe("updated");
      expect(JSON.parse(cache).raw).toBe(UPSTREAM_RAW);
      expect(JSON.parse(cache).etag).toBe('"new-etag"');
      expect(result.view.status.active.fetchedAt).not.toBeUndefined();
      expect(result.view.status.lastSuccessfulCheckAt).not.toBeNull();
      expect(result.view.status.lastAttemptAt).not.toBeNull();
      expect(active.instructions.id).toBe(tokenEfficiencyInstructionsId(UPSTREAM_SHA));
      expect(active.instructions.text).toContain("Minimize upstream cost");
      expect(requests[0]?.headers.authorization).toBeUndefined();
      expect(requests[0]?.headers.traceparent).toBeUndefined();
    }).pipe(Effect.provide(testLayer({ handler })));
  });

  it.effect("uses manual redirect mode and no credential headers", () => {
    let redirect: RequestInit["redirect"] | undefined;
    const base = testLayer({
      handler: (request, fiber) => {
        redirect = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect;
        return response(request);
      },
    });
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      yield* snapshots.refresh;
      expect(redirect).toBe("manual");
    }).pipe(Effect.provide(base));
  });

  it.effect("sends a current upstream ETag and commits a 304", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      yield* TestClock.adjust("1 minute");
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("unchanged");
      expect(result.view.status.active.source).toBe("upstream");
      expect(result.view.status.active.fetchedAt).toEqual(DateTime.makeUnsafe(EPOCH));
      expect(result.view.status.lastSuccessfulCheckAt).not.toBeNull();
      expect(result.view.status.lastAttemptAt).not.toBeNull();
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const cache = JSON.parse(
        yield* fileSystem.readFileString(
          join(config.stateDir, "plusplus", "token-efficiency", "core-cache.json"),
        ),
      );
      expect(cache.raw).toBe(BUNDLED_CORE.raw);
      expect(cache.fetchedAt).toBe(EPOCH);
      expect(cache.lastSuccessfulCheckAt).toBe("1970-01-01T00:01:00.000Z");
    }).pipe(
      Effect.provide(
        testLayer({
          seed: cacheFile(),
          handler: (request) => {
            expect(request.headers["if-none-match"]).toBe('"cached-etag"');
            return response(request, { status: 304, body: null });
          },
        }),
      ),
    ),
  );

  it.effect("keeps the active snapshot when a 304 cache write fails", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const before = yield* snapshots.active;
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe("cache-write");
      expect(before.provenance.source).toBe("upstream");
      expect(yield* snapshots.active).toEqual(before);
    }).pipe(
      Effect.provide(
        testLayer({
          seed: cacheFile(),
          blockCacheDirectory: true,
          handler: (request) => response(request, { status: 304, body: null }),
        }),
      ),
    ),
  );

  it.effect("never sends the bundled or differently adapted snapshot for a 304", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe("unexpected-not-modified");
      expect(result.view.status.active.source).toBe("bundled");
    }).pipe(
      Effect.provide(
        testLayer({
          seed: cacheFile({ adaptationVersion: 0 }),
          handler: (request) => {
            expect(request.headers["if-none-match"]).toBeUndefined();
            return response(request, { status: 304, body: null });
          },
        }),
      ),
    ),
  );

  it.effect("keeps an identical 200 body unchanged while refreshing provenance", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("unchanged");
      expect(result.view.status.active.source).toBe("upstream");
      expect(result.view.status.active.blobSha).toBe(BUNDLED_CORE.blobSha);
    }).pipe(
      Effect.provide(
        testLayer({
          seed: cacheFile(),
          handler: (request) => response(request, { body: BUNDLED_CORE.raw }),
        }),
      ),
    ),
  );
});

describe("rejected refreshes", () => {
  it.effect.each([
    { name: "a redirect", responseOptions: { status: 302 }, reason: "redirect" },
    { name: "a 404", responseOptions: { status: 404 }, reason: "http-status" },
    { name: "a 500", responseOptions: { status: 500 }, reason: "http-status" },
    { name: "a 429", responseOptions: { status: 429 }, reason: "rate-limited" },
    {
      name: "a rate-limited 403",
      responseOptions: { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      reason: "rate-limited",
    },
    {
      name: "a bad content type",
      responseOptions: { headers: { "content-type": "application/json" } },
      reason: "content-type",
    },
    {
      name: "a non-UTF-8 charset",
      responseOptions: { headers: { "content-type": "text/plain; charset=utf-16" } },
      reason: "content-type",
    },
    {
      name: "a large Content-Length",
      responseOptions: { headers: { "content-length": String(MAX_CORE_BYTES + 1) } },
      reason: "too-large",
    },
    {
      name: "a large streamed body",
      responseOptions: { body: "a".repeat(MAX_CORE_BYTES + 1) },
      reason: "too-large",
    },
    {
      name: "invalid UTF-8",
      responseOptions: { body: new Uint8Array([0xff]) },
      reason: "encoding",
    },
    { name: "an empty body", responseOptions: { body: " \n" }, reason: "empty" },
    {
      name: "a NUL byte",
      responseOptions: { body: `before\0after\n\n${REFERRAL}` },
      reason: "nul-byte",
    },
    {
      name: "a missing referral",
      responseOptions: { body: "Rules only." },
      reason: "adaptation",
    },
    {
      name: "an ambiguous referral",
      responseOptions: { body: `Use the full playbook.\n\nRules.\n\n${REFERRAL}` },
      reason: "adaptation",
    },
  ] as const)("preserves the active snapshot for $name", ({ responseOptions, reason }) =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const before = yield* snapshots.active;
      const result = yield* snapshots.refresh;
      const after = yield* snapshots.active;
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe(reason);
      expect(after).toEqual(before);
    }).pipe(
      Effect.provide(testLayer({ handler: (request) => response(request, responseOptions) })),
    ),
  );

  it.effect("preserves the active snapshot on a transport failure", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const before = yield* snapshots.active;
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe("network");
      expect(yield* snapshots.active).toEqual(before);
    }).pipe(
      Effect.provide(
        testLayer({
          handler: (request) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("offline"),
              }),
            }),
        }),
      ),
    ),
  );

  it.effect("times out after ten seconds under TestClock", () => {
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const fiber = yield* Effect.forkChild(snapshots.refresh);
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe("timeout");
    }).pipe(
      Effect.provide(
        testLayer({
          handler: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
  });

  it.effect("preserves the snapshot when the cache cannot be written", () =>
    Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const before = yield* snapshots.active;
      const result = yield* snapshots.refresh;
      expect(result.outcome).toBe("failed");
      expect(result.view.status.lastFailure?.reason).toBe("cache-write");
      expect(yield* snapshots.active).toEqual(before);
    }).pipe(
      Effect.provide(
        testLayer({ handler: (request) => response(request), blockCacheDirectory: true }),
      ),
    ),
  );
});

describe("automatic scheduling", () => {
  it.effect("makes no requests at startup or ticks while every project is disabled", () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      yield* TestClock.adjust("1 hour");
      expect(calls).toBe(0);
    }).pipe(
      Effect.provide(
        testLayer({
          handler: (request) =>
            Effect.sync(() => {
              calls += 1;
            }).pipe(Effect.andThen(response(request))),
        }),
      ),
    );
  });

  it.effect("fetches on enabled startup, then only when stale at a 15-minute tick", () => {
    const firstStarted = Deferred.makeUnsafe<void>();
    const secondStarted = Deferred.makeUnsafe<void>();
    const firstRelease = Deferred.makeUnsafe<void>();
    const secondRelease = Deferred.makeUnsafe<void>();
    let calls = 0;
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      yield* Deferred.await(firstStarted);
      const startup = yield* Effect.forkChild(snapshots.refresh);
      yield* TestClock.adjust("0 millis");
      yield* Deferred.succeed(firstRelease, undefined);
      yield* Fiber.join(startup);
      yield* TestClock.adjust("15 minutes");
      expect(calls).toBe(1);
      yield* TestClock.adjust("6 hours");
      yield* Deferred.await(secondStarted);
      const tick = yield* Effect.forkChild(snapshots.refresh);
      yield* TestClock.adjust("0 millis");
      yield* Deferred.succeed(secondRelease, undefined);
      yield* Fiber.join(tick);
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        testLayer({
          enabled: true,
          handler: (request) =>
            Effect.sync(() => {
              calls += 1;
              return calls;
            }).pipe(
              Effect.flatMap((call) =>
                Deferred.succeed(call === 1 ? firstStarted : secondStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(call === 1 ? firstRelease : secondRelease)),
                ),
              ),
              Effect.andThen(response(request)),
            ),
        }),
      ),
    );
  });

  it.effect("honours automatic backoff while manual refresh bypasses it and enablement", () => {
    const thirdStarted = Deferred.makeUnsafe<void>();
    const thirdRelease = Deferred.makeUnsafe<void>();
    let calls = 0;
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* snapshots.refresh;
      yield* snapshots.refresh;
      expect(calls).toBe(2);
      yield* settings.updateSettings({
        projectSettingsOverrides: { [PROJECT_ID]: ENABLED_OVERRIDE },
      });
      yield* TestClock.adjust("29 minutes");
      expect(calls).toBe(2);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(thirdStarted);
      yield* Deferred.succeed(thirdRelease, undefined);
      expect(calls).toBe(3);
    }).pipe(
      Effect.provide(
        testLayer({
          handler: (request) =>
            Effect.sync(() => {
              calls += 1;
              return calls;
            }).pipe(
              Effect.flatMap((call) =>
                call === 3
                  ? Deferred.succeed(thirdStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(thirdRelease)),
                    )
                  : Effect.void,
              ),
              Effect.andThen(response(request, { status: 500 })),
            ),
        }),
      ),
    );
  });

  it.effect("refreshes on a disabled-to-enabled transition only when stale", () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let calls = 0;
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [PROJECT_ID]: ENABLED_OVERRIDE },
      });
      yield* TestClock.adjust("0 millis");
      expect((yield* snapshots.view).status.automaticRefresh).toBe(true);
      yield* Deferred.await(started);
      const joined = yield* Effect.forkChild(snapshots.refresh);
      yield* TestClock.adjust("0 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(joined);
      yield* settings.updateSettings({ projectSettingsOverrides: { [PROJECT_ID]: null } });
      yield* settings.updateSettings({
        projectSettingsOverrides: { [PROJECT_ID]: ENABLED_OVERRIDE },
      });
      yield* TestClock.adjust("0 millis");
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        testLayer({
          handler: (request) =>
            Effect.sync(() => {
              calls += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(response(request)),
            ),
        }),
      ),
    );
  });
});

describe("refresh coalescing", () => {
  it.effect("completes current waiters when the post-refresh settings read defects", () => {
    const failSettingsReads = Ref.makeUnsafe(false);
    const settingsReadAttempted = Deferred.makeUnsafe<void>();
    let armSettingsDefect = true;
    const beforeGetSettings = Ref.get(failSettingsReads).pipe(
      Effect.flatMap((fail) =>
        fail
          ? Deferred.succeed(settingsReadAttempted, undefined).pipe(
              Effect.andThen(Effect.die(new Error("settings read defect"))),
            )
          : Effect.void,
      ),
    );
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const first = yield* Effect.forkChild(snapshots.refresh);
      yield* Deferred.await(settingsReadAttempted);
      yield* TestClock.adjust("0 millis");
      const firstExit = first.pollUnsafe();
      expect(firstExit).toBeDefined();
      expect(firstExit !== undefined && Exit.isFailure(firstExit)).toBe(true);
      armSettingsDefect = false;
      yield* Ref.set(failSettingsReads, false);
      const second = yield* snapshots.refresh;
      expect(second.outcome).toBe("unchanged");
    }).pipe(
      Effect.provide(
        testLayer({
          beforeGetSettings,
          handler: (request) =>
            (armSettingsDefect ? Ref.set(failSettingsReads, true) : Effect.void).pipe(
              Effect.andThen(response(request)),
            ),
        }),
      ),
    );
  });

  it.effect("releases the single-flight slot when a refresh defects", () => {
    const started = Deferred.makeUnsafe<void>();
    let calls = 0;
    const handler: Handler = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return calls === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.die(new Error("refresh defect"))),
            )
          : response(request);
      });
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const first = yield* Effect.forkChild(snapshots.refresh);
      yield* Deferred.await(started);
      yield* TestClock.adjust("0 millis");
      expect((yield* snapshots.view).status.refreshing).toBe(false);
      expect(Exit.isFailure(yield* Effect.exit(Fiber.join(first)))).toBe(true);
      const second = yield* snapshots.refresh;
      expect(second.outcome).toBe("updated");
      expect(second.view.status.refreshing).toBe(false);
      expect(calls).toBe(2);
    }).pipe(Effect.provide(testLayer({ handler })));
  });

  it.effect("shares automatic and manual calls and survives caller interruption", () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let calls = 0;
    return Effect.gen(function* () {
      const snapshots = yield* TokenEfficiencySnapshotService.TokenEfficiencySnapshotService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [PROJECT_ID]: ENABLED_OVERRIDE },
      });
      yield* TestClock.adjust("0 millis");
      yield* Deferred.await(started);
      yield* settings.updateSettings({ projectSettingsOverrides: { [PROJECT_ID]: null } });
      yield* settings.updateSettings({
        projectSettingsOverrides: { [PROJECT_ID]: ENABLED_OVERRIDE },
      });
      const interrupted = yield* Effect.forkChild(snapshots.refresh);
      const joined = yield* Effect.forkChild(snapshots.refresh);
      yield* TestClock.adjust("0 millis");
      expect(calls).toBe(1);
      expect((yield* snapshots.view).status.refreshing).toBe(true);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(joined);
      expect(result.outcome).toBe("updated");
      expect(result.view.status.refreshing).toBe(false);
      expect(calls).toBe(1);
      expect((yield* snapshots.active).instructions.id).toBe(
        tokenEfficiencyInstructionsId(UPSTREAM_SHA),
      );
    }).pipe(
      Effect.provide(
        testLayer({
          handler: (request) =>
            Effect.sync(() => {
              calls += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(response(request)),
            ),
        }),
      ),
    );
  });
});
