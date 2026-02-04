import { consoleTransport } from './console';
import { fileTransport } from './file';
import { filterTransport } from './filter';
import { multiTransport } from './multi';

export { consoleTransport, type ConsoleTransportOptions } from './console';
export { fileTransport, type FileTransportOptions, type FileRotateOptions } from './file';
export { filterTransport, type FilterOptions } from './filter';
export { multiTransport } from './multi';

/**
 * Type for the transports namespace object
 */
interface TransportsNamespace {
	console: typeof consoleTransport;
	file: typeof fileTransport;
	filter: typeof filterTransport;
	multi: typeof multiTransport;
}

/**
 * Built-in transports for the logger.
 */
export const transports: TransportsNamespace = {
	console: consoleTransport,
	file: fileTransport,
	filter: filterTransport,
	multi: multiTransport
};
