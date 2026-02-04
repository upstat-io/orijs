import { describe, it, expect } from 'bun:test';
import { ClientMessage, JoinRoom, LeaveRoom, Heartbeat, Authenticate } from '../src/control-messages';
import type { AuthenticateData } from '../src/control-messages';

describe('ClientMessage.define()', () => {
	it('creates a frozen message definition', () => {
		const TestMessage = ClientMessage.define<{ id: string }>('test.message');

		expect(TestMessage.name).toBe('test.message');
		expect(Object.isFrozen(TestMessage)).toBe(true);
	});

	it('has _data type carrier for type inference', () => {
		const TestMessage = ClientMessage.define<{ count: number }>('test.typed');

		// TypeScript uses _data for inference; runtime value is undefined
		expect(TestMessage._data).toBeUndefined();
	});
});

describe('JoinRoom', () => {
	it('has correct message name', () => {
		expect(JoinRoom.name).toBe('room.join');
	});

	it('is frozen', () => {
		expect(Object.isFrozen(JoinRoom)).toBe(true);
	});
});

describe('LeaveRoom', () => {
	it('has correct message name', () => {
		expect(LeaveRoom.name).toBe('room.leave');
	});

	it('is frozen', () => {
		expect(Object.isFrozen(LeaveRoom)).toBe(true);
	});
});

describe('Heartbeat', () => {
	it('has correct message name', () => {
		expect(Heartbeat.name).toBe('heartbeat');
	});

	it('is frozen', () => {
		expect(Object.isFrozen(Heartbeat)).toBe(true);
	});
});

describe('Authenticate', () => {
	it('has correct message name', () => {
		expect(Authenticate.name).toBe('auth.authenticate');
	});

	it('is frozen', () => {
		expect(Object.isFrozen(Authenticate)).toBe(true);
	});

	it('accepts generic credential structure', () => {
		// Test that various auth credential shapes are valid AuthenticateData
		const jwtAuth: AuthenticateData = { token: 'jwt-token-here' };
		const multiTokenAuth: AuthenticateData = {
			userToken: 'user-jwt',
			appToken: 'app-check-token'
		};
		const apiKeyAuth: AuthenticateData = { apiKey: 'sk_live_xxx' };
		const emptyAuth: AuthenticateData = {};

		// All should be valid (compile-time check, runtime just verify they're objects)
		expect(typeof jwtAuth).toBe('object');
		expect(typeof multiTokenAuth).toBe('object');
		expect(typeof apiKeyAuth).toBe('object');
		expect(typeof emptyAuth).toBe('object');
	});
});
