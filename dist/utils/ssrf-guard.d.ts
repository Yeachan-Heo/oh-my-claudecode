/**
 * SSRF Guard - URL validation to prevent Server-Side Request Forgery
 *
 * Validates URLs to ensure they don't point to:
 * - Private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
 * - Loopback (127.x.x.x, localhost)
 * - Link-local (169.254.x.x)
 * - Multicast (224-239.x.x.x)
 * - Reserved/documentations ranges
 */
export interface SSRFValidationResult {
    allowed: boolean;
    reason?: string;
}
/**
 * Validate a URL to prevent SSRF attacks
 * @param urlString The URL to validate
 * @returns SSRFValidationResult indicating if URL is safe
 */
export declare function validateUrlForSSRF(urlString: string): SSRFValidationResult;
/**
 * Validate ANTHROPIC_BASE_URL for safe usage
 * This is a convenience function that also enforces HTTPS preference
 */
export declare function validateAnthropicBaseUrl(urlString: string): SSRFValidationResult;
//# sourceMappingURL=ssrf-guard.d.ts.map