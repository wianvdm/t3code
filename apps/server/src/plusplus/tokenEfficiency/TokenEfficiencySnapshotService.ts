// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  TokenEfficiencyFailureReason,
  type TokenEfficiencyActiveSnapshot,
  type TokenEfficiencyRefreshResult,
  type TokenEfficiencyView,
} from "@t3tools/contracts/plusplus/tokenEfficiency";
import {
  anyProjectTokenEfficiencyEnabled,
  newlyEnabledTokenEfficiencyProjects,
} from "@t3tools/plusplus/contracts";
import type { ProjectInstructions } from "@t3tools/plusplus/projectInstructions";
import { BUNDLED_CORE } from "@t3tools/plusplus/tokenEfficiency/bundledCore";
import {
  adaptCore,
  formatTokenEfficiencyInstructions,
  tokenEfficiencyInstructionsId,
  validateCoreBytes,
} from "@t3tools/plusplus/tokenEfficiency/core";
import { automaticRefreshAllowed } from "@t3tools/plusplus/tokenEfficiency/policy";
import {
  ADAPTATION_VERSION,
  FETCH_TIMEOUT,
  MAX_CORE_BYTES,
  STALENESS_TICK,
  TOKEN_EFFICIENCY_CORE_URL,
} from "@t3tools/plusplus/tokenEfficiency/source";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";

const join = NodePath.join;

export interface ActiveTokenEfficiencySnapshot {
  readonly instructions: ProjectInstructions;
  readonly provenance: TokenEfficiencyActiveSnapshot;
}

export class TokenEfficiencySnapshotService extends Context.Service<
  TokenEfficiencySnapshotService,
  {
    /** Turn path: reads the in-memory Ref, never the disk or network. */
    readonly active: Effect.Effect<ActiveTokenEfficiencySnapshot>;
    readonly view: Effect.Effect<TokenEfficiencyView>;
    /** Manual refresh bypasses scheduling and joins the service-scoped in-flight operation. */
    readonly refresh: Effect.Effect<TokenEfficiencyRefreshResult>;
  }
>()("t3/plusplus/tokenEfficiency/TokenEfficiencySnapshotService") {}

const CoreCacheFile = Schema.Struct({
  version: Schema.Literal(1),
  raw: Schema.String,
  blobSha: Schema.String,
  etag: Schema.NullOr(Schema.String),
  adaptationVersion: Schema.Number,
  fetchedAt: Schema.DateTimeUtcFromString,
  lastSuccessfulCheckAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastAttemptAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  consecutiveFailures: Schema.Number,
  lastFailure: Schema.NullOr(
    Schema.Struct({
      at: Schema.DateTimeUtcFromString,
      reason: TokenEfficiencyFailureReason,
    }),
  ),
});
type CoreCacheFile = typeof CoreCacheFile.Type;
const CoreCacheFileJson = Schema.fromJsonString(CoreCacheFile);
const encodeCoreCache = Schema.encodeEffect(CoreCacheFileJson);
const decodeCoreCache = Schema.decodeOption(CoreCacheFileJson);

class RefreshFailure extends Schema.TaggedError<RefreshFailure>()("RefreshFailure", {
  reason: TokenEfficiencyFailureReason,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {}
const isRefreshFailure = Schema.is(RefreshFailure);

interface SnapshotState {
  readonly active: ActiveTokenEfficiencySnapshot;
  readonly cache: CoreCacheFile | null;
  readonly lastSuccessfulCheckAt: DateTime.Utc | null;
  readonly lastAttemptAt: DateTime.Utc | null;
  readonly consecutiveFailures: number;
  readonly lastFailure: TokenEfficiencyView["status"]["lastFailure"];
  readonly retryAfter?: Duration.Duration | undefined;
}

const activeSnapshot = (
  raw: string,
  provenance: TokenEfficiencyActiveSnapshot,
): ActiveTokenEfficiencySnapshot | null => {
  const adapted = adaptCore(raw);
  if (adapted._tag !== "Adapted") return null;
  const text = formatTokenEfficiencyInstructions(adapted.text);
  return {
    instructions: { id: tokenEfficiencyInstructionsId(provenance.blobSha), text },
    provenance,
  };
};

const bundledSnapshot = (): ActiveTokenEfficiencySnapshot => {
  const snapshot = activeSnapshot(BUNDLED_CORE.raw, {
    source: "bundled",
    blobSha: BUNDLED_CORE.blobSha,
    adaptationVersion: ADAPTATION_VERSION,
    upstreamCommit: BUNDLED_CORE.upstreamCommit,
  });
  if (snapshot === null) throw new Error("The pinned bundled CORE must adapt successfully.");
  return snapshot;
};

const initialBundledState = (
  lastFailure: TokenEfficiencyView["status"]["lastFailure"] = null,
): SnapshotState => ({
  active: bundledSnapshot(),
  cache: null,
  lastSuccessfulCheckAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  lastFailure,
});

const contentTypeValid = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const [mediaType, ...parameters] = value.split(";");
  const normalized = mediaType?.trim().toLowerCase();
  if (normalized !== "text/plain" && normalized !== "text/markdown") return false;
  return parameters.every((parameter) => {
    if (!/^\s*charset\s*=/i.test(parameter)) return true;
    const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(parameter);
    return match !== null && match[1]?.trim().toLowerCase() === "utf-8";
  });
};

const retryAfterSeconds = (value: string | undefined, now: DateTime.Utc): number | undefined => {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, (date - DateTime.toEpochMillis(now)) / 1000);
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const serviceScope = yield* Effect.scope;
  const cacheDirectory = join(serverConfig.stateDir, "plusplus", "token-efficiency");
  const cachePath = join(cacheDirectory, "core-cache.json");

  const writeCache = Effect.fn("TokenEfficiencySnapshotService.writeCache")(function* (
    cache: CoreCacheFile,
  ) {
    const temporaryPath = join(cacheDirectory, `core-cache-${process.pid}.tmp`);
    const contents = yield* encodeCoreCache(cache);
    yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
    yield* fileSystem
      .writeFileString(temporaryPath, contents)
      .pipe(
        Effect.andThen(fileSystem.rename(temporaryPath, cachePath)),
        Effect.ensuring(fileSystem.remove(temporaryPath).pipe(Effect.ignore)),
      );
  });

  const hydrate = Effect.fn("TokenEfficiencySnapshotService.hydrate")(function* () {
    const exists = yield* fileSystem.exists(cachePath).pipe(Effect.option);
    if (Option.isNone(exists)) {
      const at = yield* DateTime.now;
      return initialBundledState({ at, reason: "cache-invalid" });
    }
    if (!exists.value) return initialBundledState();
    const decoded = yield* fileSystem.readFileString(cachePath).pipe(
      Effect.map((contents) => decodeCoreCache(contents)),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(decoded)) {
      const at = yield* DateTime.now;
      return initialBundledState({ at, reason: "cache-invalid" });
    }
    const cache = decoded.value;
    const validation = validateCoreBytes(new TextEncoder().encode(cache.raw));
    if (
      validation._tag === "Invalid" ||
      validation.blobSha !== cache.blobSha ||
      cache.adaptationVersion !== ADAPTATION_VERSION
    ) {
      const at = yield* DateTime.now;
      return initialBundledState({ at, reason: "cache-invalid" });
    }
    const active = activeSnapshot(validation.raw, {
      source: "upstream",
      blobSha: validation.blobSha,
      adaptationVersion: cache.adaptationVersion,
      fetchedAt: cache.fetchedAt,
    });
    if (active === null) {
      const at = yield* DateTime.now;
      return initialBundledState({ at, reason: "cache-invalid" });
    }
    return {
      active,
      cache: { ...cache, blobSha: validation.blobSha },
      lastSuccessfulCheckAt: cache.lastSuccessfulCheckAt,
      lastAttemptAt: cache.lastAttemptAt,
      consecutiveFailures: cache.consecutiveFailures,
      lastFailure: cache.lastFailure,
    } satisfies SnapshotState;
  });

  const stateRef = yield* Ref.make<SnapshotState>(yield* hydrate());
  const inFlight = yield* SynchronizedRef.make<
    Option.Option<Deferred.Deferred<TokenEfficiencyRefreshResult>>
  >(Option.none());

  const view = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const refreshing = Option.isSome(yield* SynchronizedRef.get(inFlight));
    const currentSettings = yield* settings.getSettings.pipe(Effect.option);
    return {
      status: {
        active: state.active.provenance,
        lastSuccessfulCheckAt: state.lastSuccessfulCheckAt,
        lastAttemptAt: state.lastAttemptAt,
        lastFailure: state.lastFailure,
        refreshing,
        automaticRefresh: Option.isSome(currentSettings)
          ? anyProjectTokenEfficiencyEnabled(currentSettings.value)
          : false,
      },
      instructions: state.active.instructions.text,
    } satisfies TokenEfficiencyView;
  });

  const readCoreBytes = Effect.fn("TokenEfficiencySnapshotService.readCoreBytes")(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.suspend(() => {
        size += chunk.byteLength;
        if (size > MAX_CORE_BYTES) {
          return new RefreshFailure({ reason: "too-large" });
        }
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });

  const recordFailure = Effect.fn("TokenEfficiencySnapshotService.recordFailure")(function* (
    reason: TokenEfficiencyFailureReason,
    attemptAt: DateTime.Utc,
    retryAfter?: Duration.Duration,
  ): Effect.fn.Return<void> {
    const at = yield* DateTime.now;
    const next = yield* Ref.updateAndGet(stateRef, (state) => ({
      ...state,
      lastAttemptAt: attemptAt,
      consecutiveFailures: state.consecutiveFailures + 1,
      lastFailure: { at, reason },
      retryAfter,
    }));
    if (next.cache !== null) {
      const cache = {
        ...next.cache,
        lastAttemptAt: next.lastAttemptAt,
        consecutiveFailures: next.consecutiveFailures,
        lastFailure: next.lastFailure,
      };
      yield* writeCache(cache).pipe(Effect.ignore);
    }
  });

  const performRefresh = Effect.fn("TokenEfficiencySnapshotService.performRefresh")(function* () {
    const before = yield* Ref.get(stateRef);
    const attemptAt = yield* DateTime.now;
    const etag =
      before.active.provenance.source === "upstream" &&
      before.active.provenance.adaptationVersion === ADAPTATION_VERSION
        ? before.cache?.etag
        : null;
    const request = HttpClientRequest.get(TOKEN_EFFICIENCY_CORE_URL).pipe(
      etag == null ? (value) => value : HttpClientRequest.setHeader("If-None-Match", etag),
    );

    const operation = Effect.gen(function* () {
      const response = yield* httpClient.execute(request);
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        return yield* new RefreshFailure({ reason: "redirect" });
      }
      const retry = retryAfterSeconds(response.headers["retry-after"], attemptAt);
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers["x-ratelimit-remaining"]?.trim() === "0")
      ) {
        return yield* new RefreshFailure({
          reason: "rate-limited",
          ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
        });
      }
      if (response.status === 304) {
        if (etag == null) {
          return yield* new RefreshFailure({ reason: "unexpected-not-modified" });
        }
        const checkedAt = yield* DateTime.now;
        const cache = before.cache;
        if (cache === null) {
          return yield* new RefreshFailure({ reason: "unexpected-not-modified" });
        }
        const nextCache: CoreCacheFile = {
          ...cache,
          lastSuccessfulCheckAt: checkedAt,
          lastAttemptAt: attemptAt,
          consecutiveFailures: 0,
          lastFailure: null,
        };
        yield* writeCache(nextCache).pipe(
          Effect.mapError(() => new RefreshFailure({ reason: "cache-write" })),
        );
        yield* Ref.set(stateRef, {
          ...before,
          cache: nextCache,
          lastSuccessfulCheckAt: checkedAt,
          lastAttemptAt: attemptAt,
          consecutiveFailures: 0,
          lastFailure: null,
          retryAfter: undefined,
        });
        return "unchanged" as const;
      }
      if (response.status !== 200) {
        return yield* new RefreshFailure({
          reason: "http-status",
          ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
        });
      }
      if (!contentTypeValid(response.headers["content-type"])) {
        return yield* new RefreshFailure({ reason: "content-type" });
      }
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > MAX_CORE_BYTES) {
        return yield* new RefreshFailure({ reason: "too-large" });
      }
      const bytes = yield* readCoreBytes(response);
      const validation = validateCoreBytes(bytes);
      if (validation._tag === "Invalid") {
        return yield* new RefreshFailure({ reason: validation.reason });
      }
      const adapted = adaptCore(validation.raw);
      if (adapted._tag !== "Adapted") {
        return yield* new RefreshFailure({ reason: "adaptation" });
      }
      const fetchedAt = yield* DateTime.now;
      const nextCache: CoreCacheFile = {
        version: 1,
        raw: validation.raw,
        blobSha: validation.blobSha,
        etag: response.headers.etag ?? null,
        adaptationVersion: ADAPTATION_VERSION,
        fetchedAt,
        lastSuccessfulCheckAt: fetchedAt,
        lastAttemptAt: attemptAt,
        consecutiveFailures: 0,
        lastFailure: null,
      };
      yield* writeCache(nextCache).pipe(
        Effect.mapError(() => new RefreshFailure({ reason: "cache-write" })),
      );
      const nextActive = activeSnapshot(validation.raw, {
        source: "upstream",
        blobSha: validation.blobSha,
        adaptationVersion: ADAPTATION_VERSION,
        fetchedAt,
      });
      if (nextActive === null) {
        return yield* new RefreshFailure({ reason: "adaptation" });
      }
      yield* Ref.set(stateRef, {
        active: nextActive,
        cache: nextCache,
        lastSuccessfulCheckAt: fetchedAt,
        lastAttemptAt: attemptAt,
        consecutiveFailures: 0,
        lastFailure: null,
      });
      return before.active.provenance.source === "upstream" &&
        before.active.provenance.blobSha === validation.blobSha
        ? ("unchanged" as const)
        : ("updated" as const);
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError((error) =>
        isRefreshFailure(error) ? error : new RefreshFailure({ reason: "network" }),
      ),
      Effect.timeoutOption(FETCH_TIMEOUT),
    );

    return yield* operation.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => recordFailure("timeout", attemptAt).pipe(Effect.as("failed" as const)),
          onSome: (outcome) => Effect.succeed(outcome),
        }),
      ),
      Effect.catchTags({
        RefreshFailure: (failure) =>
          recordFailure(
            failure.reason,
            attemptAt,
            failure.retryAfterSeconds === undefined
              ? undefined
              : Duration.seconds(failure.retryAfterSeconds),
          ).pipe(Effect.as("failed" as const)),
      }),
    );
  });

  const refresh = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const [start, awaitResult] = yield* SynchronizedRef.modifyEffect(inFlight, (current) => {
        if (Option.isSome(current)) {
          return Effect.succeed([
            [Effect.void, restore(Deferred.await(current.value))] as const,
            current,
          ] as const);
        }
        const deferred = Deferred.makeUnsafe<TokenEfficiencyRefreshResult>();
        const run = performRefresh().pipe(
          Effect.onExit((exit) =>
            SynchronizedRef.set(inFlight, Option.none()).pipe(
              Effect.andThen(
                Exit.isSuccess(exit)
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(deferred, {
                        outcome: exit.value,
                        view: yield* view,
                      });
                    })
                  : Deferred.failCause(deferred, exit.cause),
              ),
            ),
          ),
          Effect.forkIn(serviceScope, { startImmediately: true }),
          Effect.asVoid,
        );
        return Effect.succeed([
          [run, restore(Deferred.await(deferred))] as const,
          Option.some(deferred),
        ] as const);
      });
      yield* start;
      return yield* awaitResult;
    }),
  );

  const automaticEvaluation = Effect.fn("TokenEfficiencySnapshotService.automaticEvaluation")(
    function* () {
      const currentSettings = yield* settings.getSettings.pipe(Effect.option);
      if (Option.isNone(currentSettings)) return;
      const state = yield* Ref.get(stateRef);
      const now = yield* DateTime.now;
      if (
        !automaticRefreshAllowed({
          status: state,
          anyEnabled: anyProjectTokenEfficiencyEnabled(currentSettings.value),
          now,
        })
      ) {
        return;
      }
      yield* refresh;
    },
  );

  const changes = yield* settings.subscribeChanges;
  const initialSettings = yield* settings.getSettings.pipe(Effect.option);
  let previousSettings = initialSettings;
  yield* Stream.runForEach(changes, (next) =>
    Effect.gen(function* () {
      const previous = Option.isSome(previousSettings) ? previousSettings.value : null;
      previousSettings = Option.some(next);
      if (previous !== null && newlyEnabledTokenEfficiencyProjects(previous, next).length > 0) {
        yield* automaticEvaluation();
      }
    }),
  ).pipe(Effect.forkIn(serviceScope));
  yield* Effect.sleep(STALENESS_TICK).pipe(
    Effect.andThen(automaticEvaluation()),
    Effect.forever,
    Effect.forkIn(serviceScope),
  );
  yield* automaticEvaluation().pipe(Effect.forkIn(serviceScope));

  return TokenEfficiencySnapshotService.of({
    active: Ref.get(stateRef).pipe(Effect.map((state) => state.active)),
    view,
    refresh,
  });
});

export const layer: Layer.Layer<
  TokenEfficiencySnapshotService,
  never,
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
> = Layer.effect(TokenEfficiencySnapshotService, make);

export const layerLive: Layer.Layer<
  TokenEfficiencySnapshotService,
  never,
  FileSystem.FileSystem | ServerConfig.ServerConfig | ServerSettings.ServerSettingsService
> = layer.pipe(Layer.provide(FetchHttpClient.layer));
