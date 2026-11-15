import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { expect } from "vite-plus/test";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";

// Trimmed copies of the Manager.test.ts fixtures: importing that file would run its whole suite.
class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(): void {}

  resize(): void {}

  kill(): void {}

  onData(): () => void {
    return () => {};
  }

  onExit(): () => void {
    return () => {};
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    return Effect.succeed(new FakePtyProcess(this.nextPid++));
  }
}

// Holds the next spawn, and with it the thread lock, until `release` succeeds.
class GatedPtyAdapter extends FakePtyAdapter {
  gate: {
    readonly spawning: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;

  override spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const gate = this.gate;
    this.gate = null;
    if (!gate) return super.spawn(input);
    return Deferred.succeed(gate.spawning, undefined).pipe(
      Effect.andThen(Deferred.await(gate.release)),
      Effect.andThen(super.spawn(input)),
    );
  }
}

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

// The current summary for the default terminal, read through a fresh metadata subscription.
const currentDefaultTerminalSummary = (manager: TerminalManager.TerminalManager["Service"]) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
    const unsubscribe = yield* manager.subscribeMetadata((event) =>
      Ref.update(events, (received) => [...received, event]),
    );
    const snapshot = (yield* Ref.get(events)).find((event) => event.type === "snapshot");
    unsubscribe();
    return snapshot?.type === "snapshot"
      ? snapshot.terminals.find((terminal) => terminal.terminalId === DEFAULT_TERMINAL_ID)
      : undefined;
  });

// A Clock whose wall time the test moves by hand, so "start began" and "spawn succeeded"
// can be told apart. Sleep delegates to the ambient clock.
const mutableClock = (base: Clock.Clock, now: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  sleep: base.sleep,
});

// Runs a callback on each spawn attempt, so a test can move the clock between the start of
// startSession and the spawn that actually succeeds.
class TimedSpawnPtyAdapter extends FakePtyAdapter {
  private readonly onSpawnAttempt: () => void;

  constructor(onSpawnAttempt: () => void) {
    super();
    this.onSpawnAttempt = onSpawnAttempt;
  }

  override spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.onSpawnAttempt();
    return super.spawn(input);
  }
}

const createManager = (historyLineLimit = 5, options: { ptyAdapter?: FakePtyAdapter } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
    const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: join(baseDir, "userdata", "logs", "terminals"),
      historyLineLimit,
      ptyAdapter,
      processKillGraceMs: 1,
    });
    return { manager, ptyAdapter };
  });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("TerminalManager ++", (it) => {
  it.effect(
    "stamps the PTY start once, keeps it across activity and attach, and resets it on restart",
    () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        const clock = yield* Clock.Clock;
        const atTime = (millis: number): Clock.Clock => ({
          currentTimeMillisUnsafe: () => millis,
          currentTimeMillis: Effect.succeed(millis),
          monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
          monotonicTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
          currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
          currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
          sleep: clock.sleep,
        });

        const currentSummary = () => currentDefaultTerminalSummary(manager);

        yield* manager.open(openInput()).pipe(Effect.provideService(Clock.Clock, atTime(1_000)));
        const startedAt = (yield* currentSummary())?.startedAt;
        expect(startedAt).toBe("1970-01-01T00:00:01.000Z");

        // Input, resize and attach repaint updatedAt; none of them is a new PTY start.
        yield* manager
          .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "ls\n" })
          .pipe(Effect.provideService(Clock.Clock, atTime(2_000)));
        yield* manager
          .resize({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 90, rows: 30 })
          .pipe(Effect.provideService(Clock.Clock, atTime(3_000)));
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const detach = yield* manager
          .attachStream(
            { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 90, rows: 30 },
            (event) => Ref.update(attachEvents, (events) => [...events, event]),
          )
          .pipe(Effect.provideService(Clock.Clock, atTime(4_000)));
        detach();
        expect((yield* currentSummary())?.startedAt).toBe(startedAt);

        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
        yield* manager.open(openInput()).pipe(Effect.provideService(Clock.Clock, atTime(5_000)));
        expect((yield* currentSummary())?.startedAt).toBe("1970-01-01T00:00:05.000Z");
      }),
  );

  it.effect("stamps the PTY start when the spawn succeeds, not when the start began", () =>
    Effect.gen(function* () {
      let now = 1_000;
      const clock = yield* Clock.Clock;
      // Every spawn attempt costs 2s: shell resolution and retries separate the moment
      // startSession began from the moment a PTY actually existed.
      const ptyAdapter = new TimedSpawnPtyAdapter(() => {
        now += 2_000;
      });
      // The first candidate fails retryably, so only the second attempt spawns.
      ptyAdapter.spawnFailures.push(new Error("spawn ENOENT"));
      const { manager } = yield* createManager(5, { ptyAdapter });

      yield* manager.open(openInput()).pipe(
        Effect.provideService(
          Clock.Clock,
          mutableClock(clock, () => now),
        ),
      );

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      // The start began at 1s, the winning spawn happened at 5s, and only the latter is a
      // truthful process start.
      expect((yield* currentDefaultTerminalSummary(manager))?.startedAt).toBe(
        "1970-01-01T00:00:05.000Z",
      );
    }),
  );

  it.effect(
    "clears the PTY start while a restart is still spawning and keeps it cleared when the spawn fails",
    () =>
      Effect.gen(function* () {
        const ptyAdapter = new GatedPtyAdapter();
        const { manager } = yield* createManager(5, { ptyAdapter });
        yield* manager.open(openInput());
        expect((yield* currentDefaultTerminalSummary(manager))?.startedAt).toBeDefined();

        ptyAdapter.spawnFailures.push(new Error("spawn refused"));
        const gate = {
          spawning: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        ptyAdapter.gate = gate;
        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
        const restarting = yield* manager
          .open(openInput())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(gate.spawning);

        // The restart owns no PTY yet: reporting the previous process's start would lie.
        const starting = yield* currentDefaultTerminalSummary(manager);
        expect(starting?.status).toBe("starting");
        expect(starting?.startedAt).toBeUndefined();

        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(restarting);
        // A failed spawn never started a process, so no start time survives the failure.
        const failed = yield* currentDefaultTerminalSummary(manager);
        expect(failed?.status).toBe("error");
        expect(failed?.startedAt).toBeUndefined();
      }).pipe(Effect.scoped),
  );
});
