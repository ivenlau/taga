import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCandidate, parseMemory } from '../packages/domain/src/index.js';
import { MetricsService } from '../packages/metrics/src/index.js';
import { FtsRetrievalProvider } from '../packages/retrieval/src/index.js';
import { BrainLayout, DatabaseStore, writeMarkdownDocument } from '../packages/storage/src/index.js';

const brainPath = resolve(process.argv[2] ?? '.tmp-m3-release');
const now = new Date().toISOString();
await mkdir(brainPath, { recursive: true });
const database = new DatabaseStore(`${brainPath}/taga.db`, { now: () => new Date(now) });
const layout = new BrainLayout(brainPath);
const lesson = parseMemory({
  schemaVersion: 1,
  id: 'm3-release-lesson',
  type: 'lessons',
  scope: { kind: 'global' },
  status: 'active',
  title: 'M3 proactive release lesson',
  summary: 'Use bounded context and verify proactive suggestions.',
  confidence: 0.9,
  sourceTrust: 'observed',
  visibility: 'private',
  created: now,
  updated: now,
  contentHash: 'sha256:m3-release-lesson',
  sources: [{ kind: 'test', locator: 'scripts/prepare-m3-release-fixture.ts' }],
  anchors: [],
});
await writeMarkdownDocument(layout.memoryFilePath(lesson.type, lesson.scope, lesson.id), lesson, lesson.summary);
new FtsRetrievalProvider(database).upsert(lesson, lesson.summary);
database.saveCandidate(parseCandidate({
  id: 'm3-release-candidate',
  observationId: 'm3-release-observation',
  memoryType: 'lessons',
  title: 'M3 release candidate',
  summary: 'M3 release candidate',
  body: 'M3 release candidate',
  scopeSuggestion: { kind: 'global' },
  worthLearning: true,
  evidenceIds: ['m3-release-evidence'],
  confidence: 0.9,
  createdAt: now,
  decidedAt: now,
  decision: 'accepted',
}));
const metrics = new MetricsService(database, () => new Date(now));
metrics.record({ kind: 'cite', subjectType: 'memory', subjectId: lesson.id, occurredAt: now });
metrics.record({ kind: 'reminder_delivered', subjectType: 'notification', subjectId: 'm3-release-reminder', occurredAt: now });
metrics.record({ kind: 'open', subjectType: 'notification', subjectId: 'm3-release-reminder', occurredAt: now });
metrics.recordTokenComparison({ baselineTokens: 1000, contextTokens: 600, source: 'm3-release-fixture', occurredAt: now });
const report = await metrics.stats();
database.close();
process.stdout.write(`${JSON.stringify({ ok: true, brainPath, metrics: report.metrics.map((metric) => ({ id: metric.id, rate: metric.rate })) })}\n`);
