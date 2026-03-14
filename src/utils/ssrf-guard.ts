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

// Private/internal IP patterns
const BLOCKED_HOST_PATTERNS = [
  // Exact matches
  /^localhost$/i,
  /^127\.[0-9]+\.[0-9]+\.[0-9]+$/, // Loopback
  /^10\.[0-9]+\.[0-9]+\.[0-9]+$/, // Class A private
  /^172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]+\.[0-9]+$/, // Class B private
  /^192\.168\.[0-9]+\.[0-9]+$/, // Class C private
  /^169\.254\.[0-9]+\.[0-9]+$/, // Link-local
  /^(0|22[4-9]|23[0-9])\.[0-9]+\.[0-9]+\.[0-9]+$/, // Multicast, reserved
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fc00:/i, // IPv6 unique local
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?::ffff:/i, // IPv6-mapped IPv4 (all private ranges accessible via this prefix)
  /^\[?0{0,4}:{0,2}ffff:/i, // IPv6-mapped IPv4 expanded forms
];

// Blocked URL schemes
const ALLOWED_SCHEMES = ['https:', 'http:'];

/**
 * Validate a URL to prevent SSRF attacks
 * @param urlString The URL to validate
 * @returns SSRFValidationResult indicating if URL is safe
 */
export function validateUrlForSSRF(urlString: string): SSRFValidationResult {
  if (!urlString || typeof urlString !== 'string') {
    return { allowed: false, reason: 'URL is empty or invalid' };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Invalid URL format' };
  }

  // Only allow http/https
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { allowed: false, reason: `Protocol '${parsed.protocol}' is not allowed` };
  }

  // Get hostname (remove port if present)
  const hostname = parsed.hostname.toLowerCase();

  // Check against blocked patterns
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        allowed: false,
        reason: `Hostname '${hostname}' resolves to a blocked internal/private address`,
      };
    }
  }

  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like a hex-encoded IP address`,
    };
  }

  // Block pure decimal IP notation (e.g., 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname) && hostname.length > 3) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like a decimal-encoded IP address`,
    };
  }

  // Block octal IP notation (segments starting with 0, e.g., 0177.0.0.1 = 127.0.0.1)
  if (/^0\d+\./.test(hostname)) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like an octal-encoded IP address`,
    };
  }

  // Block URLs with credentials (user:pass@host)
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  // Block specific dangerous paths that could access cloud metadata
  const dangerousPaths = [
    '/metadata',
    '/meta-data',
    '/latest/meta-data',
    '/computeMetadata',
  ];
  const pathLower = parsed.pathname.toLowerCase();
  for (const dangerous of dangerousPaths) {
    if (pathLower.startsWith(dangerous)) {
      return {
        allowed: false,
        reason: `Path '${parsed.pathname}' is blocked (cloud metadata access)`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validate ANTHROPIC_BASE_URL for safe usage
 * This is a convenience function that also enforces HTTPS preference
 */
export function validateAnthropicBaseUrl(urlString: string): SSRFValidationResult {
  const result = validateUrlForSSRF(urlString);
  if (!result.allowed) {
    return result;
  }

  // Prefer HTTPS but don't block HTTP for local development
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  // Log warning for HTTP (non-HTTPS) in production contexts
  if (parsed.protocol === 'http:') {
    console.warn('[SSRF Guard] Warning: Using HTTP instead of HTTPS for ANTHROPIC_BASE_URL');
  }

  return { allowed: true };
}
