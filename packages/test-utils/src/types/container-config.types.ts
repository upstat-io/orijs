/**
 * Container configuration types for test infrastructure
 */

export interface PostgresContainerConfig {
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	connectionString: string;
}

export interface RedisContainerConfig {
	host: string;
	port: number;
	db?: number;
	namespace?: string;
	connectionString: string;
}

/**
 * Bun test setup options
 */
export interface BunTestSetupOptions {
	packageName: string;
	dependencies: ('postgres' | 'redis')[];
	runMigrations?: boolean;
	migrationsPath?: string;
	timeout?: number;
}
