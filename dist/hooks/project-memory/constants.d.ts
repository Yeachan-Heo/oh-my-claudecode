/**
 * Project Memory Constants
 */
export declare const MEMORY_FILE = "project-memory.json";
export declare const MEMORY_DIR = ".omc";
export declare const CACHE_EXPIRY_MS: number;
export declare const SCHEMA_VERSION = "1.0.0";
export declare const CONFIG_PATTERNS: ({
    file: string;
    indicates: {
        language: string;
        packageManager: string;
    };
} | {
    file: string;
    indicates: {
        language: string;
        packageManager?: undefined;
    };
} | {
    file: string;
    indicates: {
        packageManager: string;
        language?: undefined;
    };
})[];
export declare const FRAMEWORK_PATTERNS: Record<string, {
    category: 'frontend' | 'backend' | 'fullstack' | 'testing' | 'build';
}>;
export declare const MAIN_DIRECTORIES: string[];
export declare const BUILD_COMMAND_PATTERNS: RegExp[];
export declare const TEST_COMMAND_PATTERNS: RegExp[];
//# sourceMappingURL=constants.d.ts.map