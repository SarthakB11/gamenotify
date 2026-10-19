import { buildCore, type CoreConfigOverrides } from '../src/index.ts';
import { FakeClock, ManualScheduler, MemoryLogger, MemoryMetrics, RecordingSender, seqIds } from '../src/testing/index.ts';

/** A fully wired core with deterministic time, ids and a recording "game client". */
export const makeCore = (overrides: CoreConfigOverrides = {}) => {
  const clock = new FakeClock();
  const scheduler = new ManualScheduler(clock);
  const sender = new RecordingSender();
  const metrics = new MemoryMetrics();
  const logger = new MemoryLogger();
  const core = buildCore(
    { sender, clock, scheduler, ids: seqIds(), metrics, logger, inboxEpoch: 'test', sleep: async () => {} },
    overrides,
  );
  const suppressed: { recipientId: number; type: string; reason: string }[] = [];
  core.dispatcher.observe({
    onSuppressed: (i) => suppressed.push({ recipientId: i.recipientId, type: i.type, reason: i.reason }),
  });
  return { core, clock, scheduler, sender, metrics, logger, suppressed };
};
