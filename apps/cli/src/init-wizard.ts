import { resolve } from 'node:path';
import type { FeatureMode } from '../../../packages/config/src/index.js';
import {
  BGE_M3_DOWNLOAD_BYTES,
  defaultBgeM3ModelPath,
  inspectBgeM3Model,
} from '../../../packages/embedding/src/index.js';

export interface InitWizardAgentOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface InitWizardDefaults {
  readonly cwd: string;
  readonly brainPath: string;
  readonly agents: readonly InitWizardAgentOption[];
  readonly enabledAgents: readonly string[];
  readonly semanticMode: FeatureMode;
  readonly semanticModelPath: string;
  readonly llmMode: FeatureMode;
  readonly llmEndpoint: string;
  readonly llmModel: string;
  readonly llmDailyCap?: number;
  readonly consolidationEnabled: boolean;
  readonly reflectionEnabled: boolean;
  readonly learnAllowNetwork: boolean;
  readonly configPathForBrain: (brainPath: string) => string;
}

export interface InitWizardResult {
  readonly brainPath: string;
  readonly agentIds: readonly string[];
  readonly semanticMode: FeatureMode;
  readonly semanticModelPath: string;
  readonly downloadSemanticModel: boolean;
  readonly llmMode: FeatureMode;
  readonly llmEndpoint?: string;
  readonly llmModel?: string;
  readonly llmDailyCap?: number;
  readonly consolidationEnabled: boolean;
  readonly reflectionEnabled: boolean;
  readonly learnAllowNetwork: boolean;
}

export interface InitWizardActivity {
  start(message: string): void;
  update(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface InitWizardUi {
  intro(title: string): void;
  note(message: string, title?: string): void;
  warn(message: string): void;
  cancel(message: string): void;
  outro(message: string): void;
  text(options: { readonly message: string; readonly initialValue?: string; readonly placeholder?: string; readonly validate?: (value: string) => string | undefined }): Promise<string | undefined>;
  select<T extends string>(options: { readonly message: string; readonly options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[]; readonly initialValue?: T }): Promise<T | undefined>;
  multiselect(options: { readonly message: string; readonly options: readonly InitWizardAgentOption[]; readonly initialValues: readonly string[]; readonly required: boolean }): Promise<readonly string[] | undefined>;
  confirm(options: { readonly message: string; readonly initialValue: boolean; readonly active?: string; readonly inactive?: string }): Promise<boolean | undefined>;
  activity(): InitWizardActivity;
}

class WizardCancelled extends Error {}

export async function runInitWizard(defaults: InitWizardDefaults, ui: InitWizardUi): Promise<InitWizardResult | undefined> {
  try {
    ui.intro('Taga setup');
    const brainPath = resolve(defaults.cwd, await required(ui.text({
      message: 'Where should Taga store its Brain data?',
      initialValue: defaults.brainPath,
      validate: nonEmpty('Brain directory is required.'),
    })));
    const agentIds = await required(ui.multiselect({
      message: 'Which AI agents should Taga integrate with?',
      options: defaults.agents,
      initialValues: defaults.enabledAgents,
      required: true,
    }));
    let semanticMode = await required(ui.select<FeatureMode>({
      message: 'Semantic retrieval mode',
      options: [
        { value: 'off', label: 'Off', hint: 'Use fast SQLite FTS5 retrieval only' },
        { value: 'shadow', label: 'Shadow', hint: 'Evaluate semantic retrieval without changing returned results' },
        { value: 'on', label: 'On', hint: 'Use hybrid lexical and BGE-M3 retrieval' },
      ],
      initialValue: defaults.semanticMode,
    }));
    let semanticModelPath = '';
    let downloadSemanticModel = false;
    if (semanticMode !== 'off') {
      const model = await chooseSemanticModel(defaults.semanticModelPath, brainPath, defaults.cwd, ui);
      if (model === undefined) {
        semanticMode = 'off';
      } else {
        semanticModelPath = model.path;
        downloadSemanticModel = model.download;
      }
    }

    const llmMode = await required(ui.select<FeatureMode>({
      message: 'LLM-assisted distillation and reflection',
      options: [
        { value: 'off', label: 'Off', hint: 'Keep all processing deterministic and local' },
        { value: 'shadow', label: 'Shadow', hint: 'Run the LLM path for evaluation only' },
        { value: 'on', label: 'On', hint: 'Use the configured OpenAI-compatible endpoint' },
      ],
      initialValue: defaults.llmMode,
    }));
    let llmEndpoint: string | undefined;
    let llmModel: string | undefined;
    let llmDailyCap: number | undefined;
    if (llmMode !== 'off') {
      ui.note('Set TAGA_LLM_API_KEY in the environment when the endpoint requires authentication. Taga never writes API keys to config.yaml.', 'Credentials');
      llmEndpoint = await required(ui.text({
        message: 'OpenAI-compatible Chat Completions endpoint',
        initialValue: defaults.llmEndpoint || 'http://127.0.0.1:11434/v1/chat/completions',
        validate: nonEmpty('LLM endpoint is required.'),
      }));
      llmModel = await required(ui.text({
        message: 'LLM model name',
        initialValue: defaults.llmModel || 'MiniMax-M3',
        validate: nonEmpty('LLM model name is required.'),
      }));
      const cap = await required(ui.text({
        message: 'Daily LLM call limit',
        initialValue: defaults.llmDailyCap?.toString() ?? '',
        placeholder: 'Unlimited',
        validate: positiveIntegerOrEmpty,
      }));
      if (cap.length > 0) llmDailyCap = Number(cap);
    }

    const consolidationEnabled = await required(ui.confirm({
      message: 'Enable background consolidation and automatic promotion?',
      initialValue: defaults.consolidationEnabled,
    }));
    const reflectionEnabled = await required(ui.confirm({
      message: 'Enable scheduled weekly reflection?',
      initialValue: defaults.reflectionEnabled,
    }));
    const learnAllowNetwork = await required(ui.confirm({
      message: 'Allow `taga learn --url` to fetch web content?',
      initialValue: defaults.learnAllowNetwork,
    }));

    ui.note([
      `Config: ${defaults.configPathForBrain(brainPath)}`,
      `Brain: ${brainPath}`,
      `Agents: ${agentIds.join(', ')}`,
      `Semantic retrieval: ${semanticMode}`,
      ...(semanticMode === 'off' ? [] : [`BGE-M3: ${downloadSemanticModel ? `download ${formatBytes(BGE_M3_DOWNLOAD_BYTES)} to ` : ''}${semanticModelPath}`]),
      `LLM: ${llmMode}`,
      `Consolidation: ${consolidationEnabled ? 'on' : 'off'}`,
      `Reflection: ${reflectionEnabled ? 'on' : 'off'}`,
      `Web learning: ${learnAllowNetwork ? 'allowed' : 'disabled'}`,
    ].join('\n'), 'Review');
    const confirmed = await required(ui.confirm({
      message: 'Apply this configuration now?',
      initialValue: true,
      active: 'Apply',
      inactive: 'Cancel',
    }));
    if (!confirmed) throw new WizardCancelled();

    return {
      brainPath,
      agentIds,
      semanticMode,
      semanticModelPath,
      downloadSemanticModel,
      llmMode,
      ...(llmEndpoint === undefined ? {} : { llmEndpoint }),
      ...(llmModel === undefined ? {} : { llmModel }),
      ...(llmDailyCap === undefined ? {} : { llmDailyCap }),
      consolidationEnabled,
      reflectionEnabled,
      learnAllowNetwork,
    };
  } catch (error) {
    if (!(error instanceof WizardCancelled)) throw error;
    ui.cancel('Initialization cancelled. No configuration was written.');
    return undefined;
  }
}

async function chooseSemanticModel(currentPath: string, brainPath: string, cwd: string, ui: InitWizardUi): Promise<{ readonly path: string; readonly download: boolean } | undefined> {
  const defaultPath = defaultBgeM3ModelPath(brainPath);
  const current = currentPath.length === 0 ? undefined : await inspectBgeM3Model(currentPath);
  const downloaded = currentPath === defaultPath && current !== undefined ? current : await inspectBgeM3Model(defaultPath);
  const options: { value: 'current' | 'downloaded' | 'download' | 'local' | 'disable'; label: string; hint?: string }[] = [];
  if (current?.valid === true) options.push({ value: 'current', label: 'Use configured local model', hint: current.path });
  if (downloaded.valid && downloaded.path !== current?.path) options.push({ value: 'downloaded', label: 'Use model already stored in this Brain', hint: downloaded.path });
  options.push(
    { value: 'download', label: `Download supported BGE-M3 (${formatBytes(BGE_M3_DOWNLOAD_BYTES)})`, hint: defaultPath },
    { value: 'local', label: 'Use another local model directory' },
    { value: 'disable', label: 'Disable semantic retrieval' },
  );
  if (current !== undefined && !current.valid) ui.warn(`Configured BGE-M3 directory is incomplete: ${current.path}`);
  const choice = await required(ui.select({
    message: 'BGE-M3 model source',
    options,
    initialValue: current?.valid === true ? 'current' : downloaded.valid ? 'downloaded' : 'download',
  }));
  if (choice === 'disable') return undefined;
  if (choice === 'current' && current?.valid === true) return { path: current.path, download: false };
  if (choice === 'downloaded' && downloaded.valid) return { path: downloaded.path, download: false };
  if (choice === 'download') return { path: defaultPath, download: true };

  while (true) {
    const path = resolve(cwd, await required(ui.text({
      message: 'Local Transformers.js BGE-M3 directory',
      initialValue: currentPath || defaultPath,
      validate: nonEmpty('Model directory is required.'),
    })));
    const inspection = await inspectBgeM3Model(path);
    if (inspection.valid) return { path, download: false };
    ui.warn(`This directory is not a complete BGE-M3 model. Missing: ${inspection.missingFiles.join(', ')}`);
  }
}

async function required<T>(value: Promise<T | undefined>): Promise<T> {
  const resolved = await value;
  if (resolved === undefined) throw new WizardCancelled();
  return resolved;
}

function nonEmpty(message: string): (value: string) => string | undefined {
  return (value) => value.trim().length === 0 ? message : undefined;
}

function positiveIntegerOrEmpty(value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Enter a positive integer or leave this empty.';
}

function formatBytes(value: number): string {
  return `${(value / (1024 ** 3)).toFixed(1)} GiB`;
}
