/**
 * Directory Mapper
 * Detects and maps project directory structure and purposes
 */
import { DirectoryInfo } from './types.js';
/**
 * Detect directory structure and purposes
 */
export declare function mapDirectoryStructure(projectRoot: string): Promise<Record<string, DirectoryInfo>>;
/**
 * Update directory last accessed time
 */
export declare function updateDirectoryAccess(directoryMap: Record<string, DirectoryInfo>, dirPath: string): void;
//# sourceMappingURL=directory-mapper.d.ts.map