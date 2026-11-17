import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';
import type { Option } from '@clack/prompts';
import type { InitWizardUi } from './init-wizard.js';

export function createClackInitUi(): InitWizardUi {
  return {
    intro,
    note,
    warn: log.warn,
    cancel,
    outro,
    async text(options) {
      const result = await text({
        message: options.message,
        ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
        ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options.validate === undefined ? {} : { validate: (value) => options.validate?.(value ?? '') }),
      });
      return isCancel(result) ? undefined : result;
    },
    async select<T extends string>(options: { readonly message: string; readonly options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[]; readonly initialValue?: T }) {
      const result = await select<T>({
        message: options.message,
        options: options.options.map((option) => ({ value: option.value, label: option.label, ...(option.hint === undefined ? {} : { hint: option.hint }) })) as Option<T>[],
        ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      });
      return isCancel(result) ? undefined : result;
    },
    async multiselect(options) {
      const result = await multiselect<string>({ ...options, options: [...options.options] });
      return isCancel(result) ? undefined : result;
    },
    async confirm(options) {
      const result = await confirm(options);
      return isCancel(result) ? undefined : result;
    },
    activity() {
      const activity = spinner({ indicator: 'timer' });
      return {
        start: (message) => activity.start(message),
        update: (message) => activity.message(message),
        stop: (message) => activity.stop(message),
        error: (message) => activity.error(message),
      };
    },
  };
}
