/**
 * OMC HUD - Terminal Capabilities Detection
 *
 * Detects terminal capabilities to enable/disable advanced rendering features.
 * Provides graceful degradation for terminals with limited support.
 */

import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

/**
 * Terminal type enumeration for capability-based rendering.
 */
export type TerminalType = 
  | 'windows-terminal'    // Modern Windows Terminal (full ANSI support)
  | 'powershell-7'        // PowerShell 7+ (good ANSI support)
  | 'powershell-5'        // PowerShell 5.1 (limited ANSI)
  | 'cmd'                 // Command Prompt (minimal support)
  | 'conemu'              // ConEmu terminal (partial support)
  | 'git-bash'            // Git Bash (good support)
  | 'wsl'                 // Windows Subsystem for Linux
  | 'macos-terminal'      // macOS Terminal.app
  | 'iterm2'              // iTerm2 on macOS
  | 'linux-terminal'      // Generic Linux terminal
  | 'vscode'              // VS Code integrated terminal
  | 'unknown';            // Unknown terminal

/**
 * Terminal capabilities for rendering decisions.
 */
export interface TerminalCapabilities {
  /** Terminal type identified */
  terminalType: TerminalType;

  /** Supports basic ANSI escape codes (colors, bold, dim) */
  supportsAnsi: boolean;

  /** Supports 256-color palette */
  supports256Color: boolean;

  /** Supports true color (24-bit RGB) */
  supportsTrueColor: boolean;

  /** Supports Unicode characters (box drawing, symbols) */
  supportsUnicode: boolean;

  /** Supports Unicode box drawing characters (├─└) */
  supportsBoxDrawing: boolean;

  /** Supports emoji */
  supportsEmoji: boolean;

  /** Terminal width in columns */
  terminalWidth: number;

  /** Is running on Windows platform */
  isWindows: boolean;

  /** Recommended progress bar style for this terminal */
  recommendedProgressBarStyle: ProgressBarStyle;
}

/**
 * Progress bar visual style options.
 */
export type ProgressBarStyle = 
  | 'solid'     // ████░░░░ (full blocks)
  | 'blocks'    // ▓▓▓▓░░░░ (dark shade)
  | 'dots'      // ●●●●○○○○ (circles)
  | 'minimal'   // ▸▸▸▸▹▹▹▹ (arrows)
  | 'ascii';    // [====....] (ASCII fallback)

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect the terminal type based on environment variables and platform.
 */
export function detectTerminalType(): TerminalType {
  const platform = os.platform();

  // Windows platform detection
  if (platform === 'win32') {
    // Windows Terminal - has WT_SESSION or WT_PROFILE_ID
    if (process.env.WT_SESSION || process.env.WT_PROFILE_ID) {
      return 'windows-terminal';
    }

    // VS Code integrated terminal
    if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode') {
      return 'vscode';
    }

    // ConEmu
    if (process.env.ConEmuPID || process.env.ConEmuANSI === 'ON') {
      return 'conemu';
    }

    // Git Bash
    if (process.env.MSYSTEM || process.env.TERM === 'xterm') {
      return 'git-bash';
    }

    // WSL - check for WSL_DISTRO_NAME
    if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
      return 'wsl';
    }

    // PowerShell version detection
    const psVersion = process.env.PSModulePath;
    if (psVersion) {
      // PowerShell 7+ has different module paths
      if (psVersion.includes('PowerShell\\7') || psVersion.includes('PowerShell/7')) {
        return 'powershell-7';
      }
      return 'powershell-5';
    }

    // Default to CMD for unknown Windows terminals
    return 'cmd';
  }

  // macOS detection
  if (platform === 'darwin') {
    const termProgram = process.env.TERM_PROGRAM;
    if (termProgram === 'iTerm.app') {
      return 'iterm2';
    }
    if (termProgram === 'Apple_Terminal') {
      return 'macos-terminal';
    }
    if (termProgram === 'vscode') {
      return 'vscode';
    }
    return 'macos-terminal';
  }

  // Linux detection
  if (platform === 'linux') {
    if (process.env.TERM_PROGRAM === 'vscode') {
      return 'vscode';
    }
    return 'linux-terminal';
  }

  return 'unknown';
}

/**
 * Check if the terminal supports ANSI escape codes.
 */
function checkAnsiSupport(terminalType: TerminalType): boolean {
  switch (terminalType) {
    case 'windows-terminal':
    case 'powershell-7':
    case 'git-bash':
    case 'wsl':
    case 'iterm2':
    case 'macos-terminal':
    case 'linux-terminal':
    case 'vscode':
      return true;

    case 'conemu':
      // ConEmu needs explicit ANSI enablement
      return process.env.ConEmuANSI === 'ON';

    case 'powershell-5':
      // PowerShell 5.1 can support ANSI with $OutputEncoding
      // but it's unreliable, default to false for safety
      return false;

    case 'cmd':
    case 'unknown':
    default:
      return false;
  }
}

/**
 * Check if the terminal supports 256-color palette.
 */
function check256ColorSupport(terminalType: TerminalType): boolean {
  const term = process.env.TERM || '';
  
  // Check TERM variable for 256-color support
  if (term.includes('256color') || term.includes('xterm')) {
    return true;
  }

  switch (terminalType) {
    case 'windows-terminal':
    case 'powershell-7':
    case 'git-bash':
    case 'wsl':
    case 'iterm2':
    case 'macos-terminal':
    case 'linux-terminal':
    case 'vscode':
      return true;

    default:
      return false;
  }
}

/**
 * Check if the terminal supports true color (24-bit RGB).
 */
function checkTrueColorSupport(terminalType: TerminalType): boolean {
  const colorterm = process.env.COLORTERM || '';
  
  // Check COLORTERM for true color support
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return true;
  }

  switch (terminalType) {
    case 'windows-terminal':
    case 'iterm2':
    case 'vscode':
    case 'wsl':
      return true;

    default:
      return false;
  }
}

/**
 * Check if the terminal supports Unicode characters.
 */
function checkUnicodeSupport(terminalType: TerminalType): boolean {
  switch (terminalType) {
    case 'windows-terminal':
    case 'powershell-7':
    case 'git-bash':
    case 'wsl':
    case 'iterm2':
    case 'macos-terminal':
    case 'linux-terminal':
    case 'vscode':
      return true;

    case 'conemu':
      // ConEmu supports Unicode but rendering can be inconsistent
      return true;

    case 'powershell-5':
    case 'cmd':
    case 'unknown':
    default:
      return false;
  }
}

/**
 * Check if the terminal supports box drawing characters.
 */
function checkBoxDrawingSupport(terminalType: TerminalType): boolean {
  // Box drawing requires both Unicode and proper font support
  const unicodeSupport = checkUnicodeSupport(terminalType);
  
  if (!unicodeSupport) {
    return false;
  }

  switch (terminalType) {
    case 'windows-terminal':
    case 'powershell-7':
    case 'git-bash':
    case 'wsl':
    case 'iterm2':
    case 'macos-terminal':
    case 'linux-terminal':
    case 'vscode':
      return true;

    default:
      return false;
  }
}

/**
 * Check if the terminal supports emoji.
 */
function checkEmojiSupport(terminalType: TerminalType): boolean {
  // Emoji support requires Unicode and proper font rendering
  const unicodeSupport = checkUnicodeSupport(terminalType);
  
  if (!unicodeSupport) {
    return false;
  }

  switch (terminalType) {
    case 'windows-terminal':
    case 'iterm2':
    case 'macos-terminal':
    case 'vscode':
    case 'wsl':
      return true;

    // Emoji rendering can be inconsistent on these
    case 'git-bash':
    case 'linux-terminal':
    case 'conemu':
      return false;

    default:
      return false;
  }
}

/**
 * Get terminal width in columns.
 */
function getTerminalWidth(): number {
  // Try to get from process.stdout
  if (process.stdout.columns && process.stdout.columns > 0) {
    return process.stdout.columns;
  }

  // Default to 80 columns (standard terminal width)
  return 80;
}

/**
 * Get recommended progress bar style based on terminal capabilities.
 */
function getRecommendedProgressBarStyle(capabilities: TerminalCapabilities): ProgressBarStyle {
  if (!capabilities.supportsUnicode) {
    return 'ascii';
  }

  if (!capabilities.supportsAnsi) {
    return 'ascii';
  }

  // Unicode-capable terminals get the best style
  return 'solid';
}

/**
 * Detect all terminal capabilities.
 * This is the main entry point for capability detection.
 */
export function detectTerminalCapabilities(): TerminalCapabilities {
  const terminalType = detectTerminalType();
  const isWindows = os.platform() === 'win32';

  const capabilities: TerminalCapabilities = {
    terminalType,
    supportsAnsi: checkAnsiSupport(terminalType),
    supports256Color: check256ColorSupport(terminalType),
    supportsTrueColor: checkTrueColorSupport(terminalType),
    supportsUnicode: checkUnicodeSupport(terminalType),
    supportsBoxDrawing: checkBoxDrawingSupport(terminalType),
    supportsEmoji: checkEmojiSupport(terminalType),
    terminalWidth: getTerminalWidth(),
    isWindows,
    recommendedProgressBarStyle: 'solid', // Will be updated below
  };

  capabilities.recommendedProgressBarStyle = getRecommendedProgressBarStyle(capabilities);

  return capabilities;
}

// ============================================================================
// Singleton Cache
// ============================================================================

let cachedCapabilities: TerminalCapabilities | null = null;

/**
 * Get cached terminal capabilities.
 * Detection is only performed once per process.
 */
export function getTerminalCapabilities(): TerminalCapabilities {
  if (!cachedCapabilities) {
    cachedCapabilities = detectTerminalCapabilities();
  }
  return cachedCapabilities;
}

/**
 * Reset the cached capabilities (for testing).
 */
export function resetCapabilitiesCache(): void {
  cachedCapabilities = null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Replace Unicode characters with ASCII equivalents.
 */
export function replaceUnicodeWithAscii(text: string): string {
  const replacements: Record<string, string> = {
    // Box drawing
    '├': '|--',
    '└': '`--',
    '─': '-',
    '│': '|',
    '┌': '+-',
    '┐': '-+',
    '┘': '-+',
    '┬': '-+-',
    '┴': '-+-',
    '┼': '-|-',

    // Progress bar characters
    '█': '#',
    '▓': '#',
    '░': '.',
    '●': '*',
    '○': 'o',
    '▸': '>',
    '▹': '-',

    // Common symbols
    '✓': '[OK]',
    '✗': '[X]',
    '⚠': '[!]',
    '⚡': '!',
    '◈': '*',
    '◇': 'o',

    // Emoji thinking indicators
    '💭': '(thinking)',
    '🧠': '(thinking)',
    '🤔': '(thinking)',

    // Health indicators
    '🟢': '[OK]',
    '🟡': '[!!]',
    '🔴': '[!!]',
  };

  let result = text;
  for (const [unicode, ascii] of Object.entries(replacements)) {
    result = result.split(unicode).join(ascii);
  }

  return result;
}

/**
 * Sanitize output for terminals with limited capabilities.
 */
export function sanitizeForTerminal(text: string, capabilities: TerminalCapabilities): string {
  let result = text;

  // Strip ANSI if not supported
  if (!capabilities.supportsAnsi) {
    result = stripAnsi(result);
  }

  // Replace Unicode if not supported
  if (!capabilities.supportsUnicode) {
    result = replaceUnicodeWithAscii(result);
  }

  return result;
}

/**
 * Check if we should use safe mode (forced ASCII/ANSI stripping).
 * Windows terminals that don't support ANSI should use safe mode.
 */
export function shouldUseSafeMode(capabilities: TerminalCapabilities): boolean {
  // If ANSI is not supported, we must use safe mode
  if (!capabilities.supportsAnsi) {
    return true;
  }

  // Windows CMD and PowerShell 5 should always use safe mode
  if (capabilities.isWindows) {
    if (capabilities.terminalType === 'cmd' || capabilities.terminalType === 'powershell-5') {
      return true;
    }
  }

  return false;
}