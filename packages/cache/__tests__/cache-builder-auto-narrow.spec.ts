/**
 * CacheBuilder Auto-Narrow + Validation Guards Tests (BUG-11-083 cure)
 *
 * Pins the cure for the silent cache cascade break when Collection.dependsOn(Individual)
 * auto-derives the source entity's full params (which include keys the dependent doesn't
 * carry). The set-time meta-key (built from dependent's own params, with missing keys
 * silently dropped) and the invalidate-time meta-key (built from the source's full
 * invalidation params, with all keys present) never matched. Cascade walker found
 * nothing. Cache stayed warm. Users saw stale collection reads.
 *
 * The cure adds 3 guards + intersection logic in CacheBuilder.dependsOn():
 * - Self-dependency guard (rejects A.dependsOn(A))
 * - Cross-scope guard (rejects upward-cascade attempts)
 * - Explicit-params subset validation (rejects keys absent from dependent)
 * - Auto-narrow intersection (silently corrects the missing-keys case)
 *
 * See bug-tracker/plans/completed/BUG-11-083/ in the upstat repo for the full cure design.
 */

import { describe, it, expect } from 'bun:test';
import { EntityRegistry } from '../src/entity-registry';
import { CacheBuilderError, createCacheBuilder } from '../src/cache-builder';

// --- TEST FIXTURES ---

type TestParams = {
	accountUuid: string;
	projectUuid: string;
	monitorUuid: string;
	teamUuid: string;
	fbAuthUid: string;
	configId: string;
};

function createTestRegistry() {
	return EntityRegistry.create()
		.scope('global')
		.scope('account', 'accountUuid')
		.scope('project', 'projectUuid')
		.entity('Config', 'global', 'configId')
		.entity('Account', 'account')
		.entity('User', 'account', 'fbAuthUid')
		.entity('Project', 'project')
		.entity('Monitor', 'project', 'monitorUuid')
		.entity('MonitorSettings', 'project', 'monitorUuid')
		.entity('MonitorCollection', 'project')
		.entity('Team', 'project', 'teamUuid')
		.entity('TeamUsersCollection', 'project', 'teamUuid')
		.build();
}

// --- AUTO-NARROW TESTS ---

describe('CacheBuilder.dependsOn auto-narrow (BUG-11-083 cure)', () => {
	describe('auto-lookup branch (no explicit params)', () => {
		it('source has FEWER params than dependent: stores source params (subset, no narrowing needed)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorSettings (Project + monitorUuid) dependsOn Project (Project, no extra param).
			// Project params = [accountUuid, projectUuid]; subset of MonitorSettings.
			const config = Cache.for<TestParams>('MonitorSettings').ttl('5m').dependsOn('Project').build();
			expect(config.dependsOn.Project).toEqual(['accountUuid', 'projectUuid']);
		});

		it('source has SAME params as dependent: stores source params (no-op intersection)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorSettings (Project + monitorUuid) dependsOn Monitor (Project + monitorUuid).
			// Same params; intersection = full set.
			const config = Cache.for<TestParams>('MonitorSettings').ttl('5m').dependsOn('Monitor').build();
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
		});

		it('source has MORE params than dependent: narrows to dependent params (THE BUG CASE)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorCollection (Project, no extra param) dependsOn Monitor (Project + monitorUuid).
			// Source has monitorUuid which dependent doesn't carry; auto-narrow drops it.
			const config = Cache.for<TestParams>('MonitorCollection').ttl('5m').dependsOn('Monitor').build();
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid']);
		});

		it('source and dependent share ONLY scope params (DISJOINT extras): narrows to scope-only', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// TeamUsersCollection (Project + teamUuid) dependsOn Monitor (Project + monitorUuid).
			// teamUuid and monitorUuid are disjoint; intersection = [accountUuid, projectUuid].
			const config = Cache.for<TestParams>('TeamUsersCollection').ttl('5m').dependsOn('Monitor').build();
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid']);
		});

		it('multiple chained dependsOn each auto-narrows independently', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			const config = Cache.for<TestParams>('MonitorSettings')
				.ttl('5m')
				.dependsOn('Monitor') // same params → full set
				.dependsOn('Team') // teamUuid not in MonitorSettings → narrowed
				.build();
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid', 'monitorUuid']);
			expect(config.dependsOn.Team).toEqual(['accountUuid', 'projectUuid']);
		});

		it('idempotent: building same chain twice produces identical dependsOn keys', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			const a = Cache.for<TestParams>('MonitorCollection').ttl('5m').dependsOn('Monitor').build();
			const b = Cache.for<TestParams>('MonitorCollection').ttl('5m').dependsOn('Monitor').build();
			expect(a.dependsOn.Monitor).toEqual(b.dependsOn.Monitor as unknown as string[]);
		});
	});

	describe('explicit-params validation', () => {
		it('explicit override with valid subset: stored verbatim (no narrowing)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			const config = Cache.for<TestParams>('MonitorCollection')
				.ttl('5m')
				.dependsOn('Monitor', ['accountUuid', 'projectUuid'])
				.build();
			expect(config.dependsOn.Monitor).toEqual(['accountUuid', 'projectUuid']);
		});

		it('explicit override with empty array: stored verbatim (degenerate, valid)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// Account dependsOn Config with empty []; tags or scope-hierarchy required for cascade.
			// Note: Account scope is account (1); Config scope is global (0). Source shallower than
			// dependent → valid downward cascade (sourceIndex 0 < dependentIndex 1).
			const config = Cache.for<TestParams>('Account').ttl('1h').dependsOn('Config', []).build();
			expect(config.dependsOn.Config).toEqual([]);
		});

		it('explicit override with key NOT in dependent params: THROWS CacheBuilderError', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorCollection has [accountUuid, projectUuid]; teamUuid is not in its params.
			expect(() =>
				Cache.for<TestParams>('MonitorCollection')
					.ttl('5m')
					.dependsOn('Team', ['accountUuid', 'projectUuid', 'teamUuid' as keyof TestParams])
					.build()
			).toThrow(CacheBuilderError);
		});

		it('explicit override partially-valid: THROWS naming the invalid key(s)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			let caught: Error | null = null;
			try {
				Cache.for<TestParams>('MonitorCollection')
					.ttl('5m')
					.dependsOn('Team', ['accountUuid', 'teamUuid' as keyof TestParams])
					.build();
			} catch (e) {
				caught = e as Error;
			}
			expect(caught).toBeInstanceOf(CacheBuilderError);
			expect(caught?.message).toContain("'teamUuid'");
		});

		it('explicit override with key in dependent but NOT in source: THROWS (cascade meta-key would diverge)', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorSettings (Project + monitorUuid) dependsOn Team (Project + teamUuid).
			// `monitorUuid` IS in MonitorSettings's params but NOT in Team's. Passing it
			// would silently break cascade: set-time meta-key would include monitorUuid
			// (dependent has it), but at invalidate-time Team's invalidation params don't
			// include monitorUuid, so the meta-key would diverge — same failure mode as
			// the original BUG-11-083 auto-derive bug, just triggered via explicit override.
			let caught: Error | null = null;
			try {
				Cache.for<TestParams>('MonitorSettings')
					.ttl('5m')
					.dependsOn('Team', ['accountUuid', 'projectUuid', 'monitorUuid'])
					.build();
			} catch (e) {
				caught = e as Error;
			}
			expect(caught).toBeInstanceOf(CacheBuilderError);
			expect(caught?.message).toContain("'monitorUuid'");
			expect(caught?.message).toContain('source entity');
		});
	});

	describe('self-dependency guard', () => {
		it('A.dependsOn(A): THROWS CacheBuilderError at build time', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			expect(() => Cache.for<TestParams>('User').ttl('1h').dependsOn('User').build()).toThrow(
				CacheBuilderError
			);
		});

		it('A.dependsOn(A) error message identifies the self-dependency clearly', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			let caught: Error | null = null;
			try {
				Cache.for<TestParams>('Monitor').ttl('5m').dependsOn('Monitor').build();
			} catch (e) {
				caught = e as Error;
			}
			expect(caught).toBeInstanceOf(CacheBuilderError);
			expect(caught?.message).toContain('Self-dependency');
			expect(caught?.message).toContain("'Monitor'");
		});
	});

	describe('cross-scope guard', () => {
		it('UPWARD cascade (Account dependent → Project source): THROWS', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// User (Account scope) trying to depend on Monitor (Project scope).
			// Source scope deeper than dependent's; cascade cannot bridge upward.
			expect(() => Cache.for<TestParams>('User').ttl('1h').dependsOn('Monitor').build()).toThrow(
				CacheBuilderError
			);
		});

		it('UPWARD cascade error message points at tags as the cure path', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			let caught: Error | null = null;
			try {
				Cache.for<TestParams>('User').ttl('1h').dependsOn('Team').build();
			} catch (e) {
				caught = e as Error;
			}
			expect(caught).toBeInstanceOf(CacheBuilderError);
			expect(caught?.message).toContain('.tags()');
			expect(caught?.message).toContain('cache/invalidation.md');
		});

		it('DOWNWARD cascade (Project dependent → Account source): does NOT throw', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// Monitor (Project scope) dependsOn User (Account scope). Source shallower; valid.
			const config = Cache.for<TestParams>('Monitor').ttl('5m').dependsOn('User').build();
			// User has [accountUuid, fbAuthUid]; Monitor has [accountUuid, projectUuid, monitorUuid].
			// Intersection = [accountUuid].
			expect(config.dependsOn.User).toEqual(['accountUuid']);
		});

		it('SAME-SCOPE cascade (Project dependent → Project source): does NOT throw', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			// MonitorCollection (Project) dependsOn Monitor (Project) — same scope, normal.
			expect(() =>
				Cache.for<TestParams>('MonitorCollection').ttl('5m').dependsOn('Monitor').build()
			).not.toThrow();
		});

		it('DOWNWARD to Global (Project dependent → Global source): does NOT throw', () => {
			const Cache = createCacheBuilder(createTestRegistry());
			const config = Cache.for<TestParams>('Monitor').ttl('5m').dependsOn('Config').build();
			// Config (Global) params = [configId]; Monitor params = [accountUuid, projectUuid, monitorUuid].
			// Intersection = [] (no shared params besides scope which Global has none).
			expect(config.dependsOn.Config).toEqual([]);
		});
	});

	describe('regression — incident-settings-repository.ts reference fix scenario', () => {
		it('IncidentSeveritiesCollection.dependsOn(IncidentSeverity) auto-narrows correctly', () => {
			const registry = EntityRegistry.create()
				.scope('global')
				.scope('account', 'accountUuid')
				.scope('project', 'projectUuid')
				.entity('IncidentSeverity', 'project', 'incidentSeverityUuid')
				.entity('IncidentSeveritiesCollection', 'project')
				.build();
			const Cache = createCacheBuilder(registry);
			const config = Cache.for<{
				accountUuid: string;
				projectUuid: string;
				incidentSeverityUuid: string;
			}>('IncidentSeveritiesCollection')
				.ttl('1h')
				.dependsOn('IncidentSeverity')
				.build();
			// Pre-cure (BUG-11-083): would have stored [accountUuid, projectUuid, incidentSeverityUuid];
			// at setEntry the meta-key would silently drop incidentSeverityUuid (dependent doesn't have
			// it); at invalidate the meta-key would include it. Cascade walker found nothing.
			// Post-cure: auto-narrow stores [accountUuid, projectUuid]; both set + invalidate produce
			// matching meta-keys.
			expect(config.dependsOn.IncidentSeverity).toEqual(['accountUuid', 'projectUuid']);
		});
	});
});
