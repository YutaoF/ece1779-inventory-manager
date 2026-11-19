import { readFileSync } from 'node:fs';

/**
 * Reads a setting from the environment.
 *
 * Every setting can be given directly (NAME=value) or as a path to a file that
 * holds the value (NAME_FILE=/run/secrets/name). The file form is how Docker
 * Swarm secrets reach the container, so production credentials never appear in
 * environment variables or the stack file.
 */
export function readSetting(env, name) {
  const fileVar = `${name}_FILE`;
  const direct = env[name];
  const filePath = env[fileVar];

  if (direct !== undefined && filePath !== undefined) {
    throw new Error(`Set either ${name} or ${fileVar}, not both`);
  }

  if (filePath !== undefined) {
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Could not read ${fileVar} (${filePath}): ${err.code ?? err.message}`);
    }
    // Secret files usually end with a newline; it is never part of the value.
    const value = contents.replace(/\r?\n$/, '');
    if (value === '') {
      throw new Error(`${fileVar} points to an empty file`);
    }
    return value;
  }

  return direct === '' ? undefined : direct;
}

function readInteger(env, name, defaultValue, { min, max }) {
  const raw = readSetting(env, name);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Builds the application configuration and fails fast on anything invalid, so a
 * misconfigured container exits at startup instead of failing on first request.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = readSetting(env, 'NODE_ENV') ?? 'development';

  const databaseUrl = readSetting(env, 'DATABASE_URL');
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL (or DATABASE_URL_FILE) is required');
  }

  const logLevel = readSetting(env, 'LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevel}"`);
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    host: readSetting(env, 'HOST') ?? '0.0.0.0',
    port: readInteger(env, 'PORT', 3000, { min: 1, max: 65535 }),
    logLevel,
    database: {
      url: databaseUrl,
      // Overrides any password in DATABASE_URL. Lets the app and the postgres
      // container share one Swarm secret (POSTGRES_PASSWORD_FILE on the db side).
      password: readSetting(env, 'DATABASE_PASSWORD'),
      poolMax: readInteger(env, 'DATABASE_POOL_MAX', 10, { min: 1, max: 100 }),
    },
    // Used by sessions from stage 2 onward; optional until then.
    sessionSecret: readSetting(env, 'SESSION_SECRET'),
    // Used by Socket.IO's Redis adapter once real-time updates land.
    redisUrl: readSetting(env, 'REDIS_URL'),
    // Directory holding the built React app. When unset, only the API is served.
    staticDir: readSetting(env, 'STATIC_DIR'),
    shutdownTimeoutMs: readInteger(env, 'SHUTDOWN_TIMEOUT_MS', 10000, { min: 0, max: 120000 }),
  };
}
