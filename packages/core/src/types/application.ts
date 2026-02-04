/**
 * Application-level type definitions for OriJS.
 */

import type { Constructor } from './context';
import type { ControllerClass } from './controller';
import type { Transport } from './logging';

/**
 * Configuration for a registered controller.
 */
export interface ControllerConfig {
	path: string;
	controller: ControllerClass;
	deps: Constructor[];
}

/**
 * Configuration for a registered provider/service.
 */
export interface ProviderConfig {
	service: Constructor;
	deps: Constructor[];
	eager?: boolean;
}

/**
 * Options for registering a provider.
 */
export interface ProviderOptions {
	/** Instantiate immediately at startup instead of lazily on first use */
	eager?: boolean;
}

/**
 * Options for configuring the application logger.
 */
export interface AppLoggerOptions {
	level?: 'debug' | 'info' | 'warn' | 'error';
	transports?: Transport[];
	/** Clear console on application startup (default: false) */
	clearConsole?: boolean;
}

/**
 * CORS configuration options.
 */
export interface CorsConfig {
	/** Allowed origins. Use '*' for all origins, or specify allowed origins. */
	origin: string | string[];
	/** Allowed HTTP methods. Default: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] */
	methods?: string[];
	/** Allowed headers. Default: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'] */
	allowedHeaders?: string[];
	/** Headers to expose to the browser. Default: [] */
	exposedHeaders?: string[];
	/** Allow credentials (cookies, authorization headers). Default: true */
	credentials?: boolean;
	/** Max age for preflight cache in seconds. Default: 86400 (24 hours) */
	maxAge?: number;
}
