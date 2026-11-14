export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogComponent = 'daemon' | 'distill' | 'recall' | 'audit';

export interface LogFields {
  readonly requestId?: string;
  readonly jobId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly eventType: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly resultCount?: number;
  readonly degraded?: boolean;
}

export interface LogRecord extends LogFields {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: LogComponent;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export class JsonLogger implements Logger {
  constructor(
    private readonly component: LogComponent,
    private readonly sink: LogSink = (record) => {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  log(level: LogLevel, fields: LogFields): void {
    this.sink({
      timestamp: this.clock().toISOString(),
      level,
      component: this.component,
      ...fields,
    });
  }

  debug(fields: LogFields): void {
    this.log('debug', fields);
  }

  info(fields: LogFields): void {
    this.log('info', fields);
  }

  warn(fields: LogFields): void {
    this.log('warn', fields);
  }

  error(fields: LogFields): void {
    this.log('error', fields);
  }
}
