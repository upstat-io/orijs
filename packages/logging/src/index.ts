export { Logger, type LogObject, type Transport, type LoggerOptions, type SetMetaCallback } from './logger';
export { levels, type LevelName, type LevelNumber } from './levels';
export {
	requestContext,
	runWithContext,
	generateCorrelationId,
	generateSpanId,
	createTraceContext,
	createChildTraceContext,
	capturePropagationMeta,
	setMeta,
	type RequestContextData,
	type TraceContext,
	type PropagationMeta
} from './context';
export {
	// Trace field utilities (prefer Logger.configure({ traceFields }) for registration)
	getTraceFields,
	isTraceField,
	getTraceField,
	truncateValue,
	formatTraceField,
	extractTraceFields,
	ANSI_COLORS,
	DEFAULT_TRUNCATE_LENGTH,
	// For advanced use cases and testing
	registerTraceFields,
	resetTraceFields
} from './trace-fields';
// Re-export TraceFieldDef from types
export type { TraceFieldDef, LoggerGlobalOptions, Logging } from './types';
export {
	transports,
	consoleTransport,
	fileTransport,
	filterTransport,
	multiTransport
} from './transports/index';
export type {
	ConsoleTransportOptions,
	FileTransportOptions,
	FileRotateOptions,
	FilterOptions
} from './transports/index';
export { readLogConfig, buildLoggerOptions, createLoggerOptionsFromConfig, type LogConfig } from './config';
export { DEFAULT_FLUSH_INTERVAL, DEFAULT_BUFFER_SIZE, MAX_WRITE_SIZE } from './log-buffer';
