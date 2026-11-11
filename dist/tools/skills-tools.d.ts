/**
 * Skills Tools
 *
 * MCP tools for loading and listing OMC learned skills
 * from local (.omc/skills/) and global (~/.omc/skills/) directories.
 */
import { z } from 'zod';
export declare const loadLocalTool: {
    name: string;
    description: string;
    schema: {
        projectRoot: z.ZodOptional<z.ZodString>;
    };
    handler: (args: {
        projectRoot?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
export declare const loadGlobalTool: {
    name: string;
    description: string;
    schema: {};
    handler: (_args: Record<string, never>) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
export declare const listSkillsTool: {
    name: string;
    description: string;
    schema: {
        projectRoot: z.ZodOptional<z.ZodString>;
    };
    handler: (args: {
        projectRoot?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
};
/** All skills tools for registration in omc-tools-server */
export declare const skillsTools: ({
    name: string;
    description: string;
    schema: {
        projectRoot: z.ZodOptional<z.ZodString>;
    };
    handler: (args: {
        projectRoot?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    schema: {};
    handler: (_args: Record<string, never>) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
})[];
//# sourceMappingURL=skills-tools.d.ts.map