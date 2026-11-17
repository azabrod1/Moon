/**
 * Vitest setup (vite.config.ts `test.setupFiles`): every suite runs on the
 * shipped ephemeris, as the app does once it has booted, rather than on the
 * analytic fallback. A suite that wants the fallback uninstalls it with
 * `setFittedEphemeris(null)` and puts it back after.
 */
import { installFittedEphemerisFromDisk } from './fittedEphemerisTestFile';

installFittedEphemerisFromDisk();
