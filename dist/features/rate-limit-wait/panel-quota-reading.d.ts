import type { PanelEnv, QuotaReading } from './panel-quota-wait.js';
/**
 * Real provider reading for the daemon: GET of OMC_PANEL_QUOTA_READ_URL with the key from OMC_PANEL_QUOTA_KEY_FILE.
 * Returns null (no wait) when the URL, the key file, the response, the HTTP status or the shape of its limits is
 * unusable (a limit field of the wrong type, see panel-quota-limits.ts). The key stays in the request header only;
 * errors are not logged here.
 */
export declare function readProviderQuota(env?: PanelEnv): Promise<QuotaReading | null>;
//# sourceMappingURL=panel-quota-reading.d.ts.map