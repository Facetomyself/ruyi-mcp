/**
 * Anti-detection & fingerprint tools:
 *   set_fingerprint, emulate_geolocation, emulate_timezone,
 *   emulate_locale, emulate_useragent
 *
 * Note: proxy must be set at browser.launch time (ruyi_new_page params).
 */
import { RuyiContext } from '../ruyi-context.js';
import { ToolRegistrar } from './types.js';
export declare function registerAntiDetectTools(register: ToolRegistrar, ctx: RuyiContext): void;
