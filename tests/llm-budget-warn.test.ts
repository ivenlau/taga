import { describe, expect, it } from 'vitest';
import { checkLlmBudgetWarning } from '../apps/daemon/src/index.js';
import { createDefaultConfig } from '../packages/config/src/index.js';
import { InMemoryAuditLog } from '../packages/application/src/index.js';
import { NotificationService } from '../packages/notifications/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

describe('llm budget warning', () => {
  it('warns once at 80% budget and stays silent afterwards', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(`${fixture.path}/taga.db`);
    const config = { ...createDefaultConfig(), llm: { ...createDefaultConfig().llm, dailyCap: 10, dailyTokens: 1000 } };
    const day = new Date().toISOString().slice(0, 10);

    database.upsertMetadata(`llm-budget:${day}`, JSON.stringify({ calls: 0, tokens: 700, consumers: {} }));
    expect(await checkLlmBudgetWarning(database, config)).toBe(false);

    database.upsertMetadata(`llm-budget:${day}`, JSON.stringify({ calls: 9, tokens: 700, consumers: {} }));
    expect(await checkLlmBudgetWarning(database, config)).toBe(true);
    const notifications = new NotificationService(database, new InMemoryAuditLog());
    expect(notifications.list().some((item) => item.kind === 'budget' && item.level === 'L1')).toBe(true);

    // warned flag keeps the alert at one per day
    expect(await checkLlmBudgetWarning(database, config)).toBe(false);
    database.close();
    await fixture.cleanup();
  });
});
