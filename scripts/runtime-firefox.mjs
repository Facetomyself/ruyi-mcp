import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function resolveGateFirefox(configured = process.env.RUYI_FIREFOX_PATH) {
  const firefox = configured?.trim();
  if (!firefox || !isAbsolute(firefox)) {
    throw new Error('Set RUYI_FIREFOX_PATH to an absolute path to a native Firefox executable for this host.');
  }
  try {
    if (!(await stat(firefox)).isFile()) throw new Error('not a regular file');
    await access(firefox, constants.X_OK);
  } catch (error) {
    throw new Error(`RUYI_FIREFOX_PATH must point to an executable file: ${firefox} (${error.code ?? error.message})`, { cause: error });
  }
  return firefox;
}

export async function requireGateFirefox() {
  try {
    return await resolveGateFirefox();
  } catch (error) {
    console.error(`[ruyi-mcp] ${error.message}`);
    process.exit(2);
  }
}
