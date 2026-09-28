/**
 * server/lib.mjs 的类型声明（该文件是零依赖的 ESM，供 tsc 与测试共用）。
 * 只声明被 src/ 与 test/ 实际消费的导出面。
 */

export declare const REPO_URL: string;
export declare const INSTALL_COMMAND: string;
export declare const VERSION: string;
export declare const STAMP_FILE_RE: RegExp;

export declare function projectArchiveDir(projectRoot: string): string;
export declare function mentionsRepo(text: unknown): boolean;
export declare function findRegisteredSources(
	paths: string[],
	readFile: (path: string) => string,
): string[];
export declare function countStamps(
	readdirSync: (dir: string) => string[],
	dir: string,
): number;

export interface ArchiveStatusState {
	version: string;
	registeredSources: string[];
	projectStamps: number;
	legacyStamps: number;
}

export declare function renderStatus(state: ArchiveStatusState): string;

export declare const TOOL_SCHEMA: {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown> };
};
