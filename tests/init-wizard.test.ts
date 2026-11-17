import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInitWizard, type InitWizardDefaults, type InitWizardUi } from '../apps/cli/src/init-wizard.js';
import { defaultBgeM3ModelPath } from '../packages/embedding/src/index.js';

interface Script {
  readonly texts: string[];
  readonly selects: string[];
  readonly multiselects: string[][];
  readonly confirms: boolean[];
}

function scriptedUi(script: Script): InitWizardUi & { readonly notes: string[]; readonly warnings: string[]; cancelled: boolean } {
  const notes: string[] = [];
  const warnings: string[] = [];
  return {
    notes,
    warnings,
    cancelled: false,
    intro(): void {},
    note(message, title): void { notes.push(`${title ?? ''}\n${message}`); },
    warn(message): void { warnings.push(message); },
    cancel(): void { this.cancelled = true; },
    outro(): void {},
    text: () => Promise.resolve(script.texts.shift()),
    select: <T extends string>() => Promise.resolve(script.selects.shift() as T | undefined),
    multiselect: () => Promise.resolve(script.multiselects.shift()),
    confirm: () => Promise.resolve(script.confirms.shift()),
    activity: () => ({ start(): void {}, update(): void {}, stop(): void {}, error(): void {} }),
  };
}

function defaults(root: string): InitWizardDefaults {
  return {
    cwd: root,
    brainPath: join(root, 'brain'),
    agents: [
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
    ],
    enabledAgents: ['codex'],
    semanticMode: 'off',
    semanticModelPath: '',
    llmMode: 'off',
    llmEndpoint: '',
    llmModel: '',
    consolidationEnabled: false,
    reflectionEnabled: false,
    learnAllowNetwork: false,
    configPathForBrain: (brainPath) => join(brainPath, 'config.yaml'),
  };
}

describe('interactive init wizard', () => {
  it('returns a complete configuration after the same-run confirmation', async () => {
    const root = 'D:/taga-test';
    const ui = scriptedUi({
      texts: [join(root, 'custom-brain')],
      selects: ['off', 'off'],
      multiselects: [['claude-code', 'codex']],
      confirms: [true, false, false, true],
    });

    const result = await runInitWizard(defaults(root), ui);

    expect(result).toMatchObject({
      brainPath: join(root, 'custom-brain'),
      agentIds: ['claude-code', 'codex'],
      semanticMode: 'off',
      llmMode: 'off',
      consolidationEnabled: true,
      reflectionEnabled: false,
      learnAllowNetwork: false,
    });
    expect(ui.notes.join('\n')).not.toContain('Project:');
    expect(ui.notes.join('\n')).toContain('Review');
    expect(ui.cancelled).toBe(false);
  });

  it('offers the pinned Brain-local BGE-M3 download when no model is available', async () => {
    const root = 'D:/taga-download-test';
    const brain = join(root, 'brain');
    const ui = scriptedUi({
      texts: [brain],
      selects: ['on', 'download', 'off'],
      multiselects: [['codex']],
      confirms: [false, false, false, true],
    });

    const result = await runInitWizard(defaults(root), ui);

    expect(result).toMatchObject({
      semanticMode: 'on',
      semanticModelPath: defaultBgeM3ModelPath(brain),
      downloadSemanticModel: true,
    });
  });

  it('returns no plan when the user declines final confirmation', async () => {
    const root = 'D:/taga-cancel-test';
    const ui = scriptedUi({
      texts: [join(root, 'brain')],
      selects: ['off', 'off'],
      multiselects: [['codex']],
      confirms: [false, false, false, false],
    });

    expect(await runInitWizard(defaults(root), ui)).toBeUndefined();
    expect(ui.cancelled).toBe(true);
  });
});
