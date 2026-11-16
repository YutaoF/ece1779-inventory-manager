const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal structured logger: one JSON object per line on stdout, which
 * `docker service logs` and the DigitalOcean log tooling can read directly.
 */
export function createLogger({ level = 'info', stream = process.stdout, base = {} } = {}) {
  const threshold = LEVEL_RANK[level] ?? LEVEL_RANK.info;

  function write(entryLevel, msg, fields) {
    if (LEVEL_RANK[entryLevel] < threshold) return;
    const entry = { time: new Date().toISOString(), level: entryLevel, msg, ...base, ...fields };
    if (fields?.err instanceof Error) {
      entry.err = { message: fields.err.message, code: fields.err.code, stack: fields.err.stack };
    }
    stream.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ level, stream, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything; used by tests. */
export const silentLogger = createLogger({ stream: { write() {} } });
