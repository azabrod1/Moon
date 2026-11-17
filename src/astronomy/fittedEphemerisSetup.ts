/**
 * Vitest setup (vite.config.ts `test.setupFiles`): every suite runs on the
 * shipped ephemeris and moon corrections, as the app does once it has
 * booted, rather than on the analytic fallback. A suite that wants the
 * fallback uninstalls them with `setFittedEphemeris(null)` or
 * `installMoonCorrections(null)` and puts them back after.
 */
import { installFittedEphemerisFromDisk, installMoonCorrectionsFromDisk } from './fittedEphemerisTestFile';

installFittedEphemerisFromDisk();
installMoonCorrectionsFromDisk();
