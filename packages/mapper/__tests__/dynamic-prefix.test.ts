import { describe, test, expect } from 'bun:test';
import { Mapper } from '../src/mapper';
import { field } from '../src/field';

describe('Mapper dynamic prefix', () => {
	const Tables = Mapper.defineTables({
		Step: {
			tableName: 'step',
			id: field('id').number(),
			title: field('title').string(),
			description: field('description').string().optional()
		}
	});

	interface Step {
		id: number;
		title: string;
		description?: string;
	}

	const StepMapper = Mapper.for<Step>(Tables.Step).build();

	describe('basic prefix usage', () => {
		test('should map columns with prefix', () => {
			const row = {
				step_id: 1,
				step_title: 'First Step',
				step_description: 'Do this first'
			};

			const result = StepMapper.map(row, { prefix: 'step_' }).value();

			expect(result).toEqual({
				id: 1,
				title: 'First Step',
				description: 'Do this first'
			});
		});

		test('should use different prefixes on same row', () => {
			const row = {
				step_id: 1,
				step_title: 'Step One',
				action_id: 2,
				action_title: 'Action One'
			};

			const step = StepMapper.map(row, { prefix: 'step_' }).value();
			const action = StepMapper.map(row, { prefix: 'action_' }).value();

			expect(step).toEqual({ id: 1, title: 'Step One' });
			expect(action).toEqual({ id: 2, title: 'Action One' });
		});

		test('should work without prefix (default behavior)', () => {
			const row = {
				id: 1,
				title: 'No Prefix',
				description: 'Direct columns'
			};

			const result = StepMapper.map(row).value();

			expect(result).toEqual({
				id: 1,
				title: 'No Prefix',
				description: 'Direct columns'
			});
		});

		test('should throw MapperError when required prefixed columns are missing', () => {
			const row = {
				id: 1,
				title: 'No Prefix'
			};

			// Looking for step_id, step_title which don't exist - throws for required fields
			expect(() => StepMapper.map(row, { prefix: 'step_' })).toThrow('cannot coerce null/undefined');
		});
	});

	describe('prefix with mapMany', () => {
		test('should apply prefix to all rows in mapMany', () => {
			const rows = [
				{ item_id: 1, item_title: 'Item 1' },
				{ item_id: 2, item_title: 'Item 2' },
				{ item_id: 3, item_title: 'Item 3' }
			];

			const results = StepMapper.mapMany(rows, { prefix: 'item_' });

			expect(results).toEqual([
				{ id: 1, title: 'Item 1' },
				{ id: 2, title: 'Item 2' },
				{ id: 3, title: 'Item 3' }
			]);
		});

		test('should throw when any row has missing required fields', () => {
			const rows = [
				{ item_id: 1, item_title: 'Item 1' },
				{ other_id: 2, other_title: 'Other 2' }, // Wrong prefix - will throw
				{ item_id: 3, item_title: 'Item 3' }
			];

			// mapMany throws when any row fails to map required fields
			expect(() => StepMapper.mapMany(rows, { prefix: 'item_' })).toThrow('cannot coerce null/undefined');
		});
	});

	describe('prefix with optional fields', () => {
		test('should handle optional fields with prefix', () => {
			const row = {
				step_id: 1,
				step_title: 'Step'
				// step_description is missing (optional)
			};

			const result = StepMapper.map(row, { prefix: 'step_' }).value();

			expect(result).toEqual({
				id: 1,
				title: 'Step',
				description: undefined
			});
		});

		test('should handle null optional fields with prefix', () => {
			const row = {
				step_id: 1,
				step_title: 'Step',
				step_description: null
			};

			const result = StepMapper.map(row, { prefix: 'step_' }).value();

			expect(result).toEqual({
				id: 1,
				title: 'Step',
				description: undefined
			});
		});
	});

	describe('prefix with defaults', () => {
		const TablesWithDefaults = Mapper.defineTables({
			Config: {
				tableName: 'config',
				id: field('id').number(),
				name: field('name').string(),
				enabled: field('enabled').boolean().default(false),
				retries: field('retries').number().default(3)
			}
		});

		interface Config {
			id: number;
			name: string;
			enabled: boolean;
			retries: number;
		}

		const ConfigMapper = Mapper.for<Config>(TablesWithDefaults.Config).build();

		test('should apply defaults when prefixed column is missing', () => {
			const row = {
				cfg_id: 1,
				cfg_name: 'My Config'
				// cfg_enabled and cfg_retries are missing
			};

			const result = ConfigMapper.map(row, { prefix: 'cfg_' }).value();

			expect(result).toEqual({
				id: 1,
				name: 'My Config',
				enabled: false,
				retries: 3
			});
		});

		test('should use actual values over defaults when present', () => {
			const row = {
				cfg_id: 1,
				cfg_name: 'My Config',
				cfg_enabled: true,
				cfg_retries: 5
			};

			const result = ConfigMapper.map(row, { prefix: 'cfg_' }).value();

			expect(result).toEqual({
				id: 1,
				name: 'My Config',
				enabled: true,
				retries: 5
			});
		});
	});

	describe('prefix with field renames', () => {
		const TablesWithRename = Mapper.defineTables({
			User: {
				tableName: 'user',
				id: field('id').number(),
				uuid: field('uuid').string(),
				email: field('email').string()
			}
		});

		interface UserRenamed {
			oderId: number;
			uuid: string;
			email: string;
		}

		const UserMapper = Mapper.for<UserRenamed>(TablesWithRename.User).field('id').as('oderId').build();

		test('should apply prefix to renamed fields', () => {
			const row = {
				owner_id: 42,
				owner_uuid: 'abc-123',
				owner_email: 'test@example.com'
			};

			const result = UserMapper.map(row, { prefix: 'owner_' }).value();

			expect(result).toEqual({
				oderId: 42,
				uuid: 'abc-123',
				email: 'test@example.com'
			});
		});
	});

	describe('prefix with transforms', () => {
		const TablesForTransform = Mapper.defineTables({
			Item: {
				tableName: 'item',
				id: field('id').number(),
				name: field('name').string()
			}
		});

		interface Item {
			id: number;
			name: string;
		}

		const ItemMapper = Mapper.for<Item>(TablesForTransform.Item)
			.transform('name', (v) => v.toUpperCase())
			.build();

		test('should apply transforms after prefix mapping', () => {
			const row = {
				prod_id: 1,
				prod_name: 'widget'
			};

			const result = ItemMapper.map(row, { prefix: 'prod_' }).value();

			expect(result).toEqual({
				id: 1,
				name: 'WIDGET'
			});
		});
	});

	describe('real-world use case: automation steps', () => {
		const AutomationTables = Mapper.defineTables({
			AutomationStep: {
				tableName: 'automation_step',
				id: field('id').number(),
				title: field('title').string(),
				type: field('type').string(),
				order: field('order').number()
			}
		});

		interface AutomationStep {
			id: number;
			title: string;
			type: string;
			order: number;
		}

		const AutomationStepMapper = Mapper.for<AutomationStep>(AutomationTables.AutomationStep).build();

		test('should map automation steps with dynamic prefix', () => {
			// Simulates a query that returns steps with step_1_, step_2_ prefixes
			const row = {
				step_1_id: 1,
				step_1_title: 'Send Email',
				step_1_type: 'email',
				step_1_order: 1,
				step_2_id: 2,
				step_2_title: 'Wait',
				step_2_type: 'delay',
				step_2_order: 2
			};

			const step1 = AutomationStepMapper.map(row, { prefix: 'step_1_' }).value();
			const step2 = AutomationStepMapper.map(row, { prefix: 'step_2_' }).value();

			expect(step1).toEqual({
				id: 1,
				title: 'Send Email',
				type: 'email',
				order: 1
			});

			expect(step2).toEqual({
				id: 2,
				title: 'Wait',
				type: 'delay',
				order: 2
			});
		});

		test('should allow iterating with dynamic prefixes', () => {
			const row = {
				step_count: 3,
				step_0_id: 1,
				step_0_title: 'First',
				step_0_type: 'action',
				step_0_order: 0,
				step_1_id: 2,
				step_1_title: 'Second',
				step_1_type: 'condition',
				step_1_order: 1,
				step_2_id: 3,
				step_2_title: 'Third',
				step_2_type: 'action',
				step_2_order: 2
			};

			const stepCount = row.step_count;
			const steps: AutomationStep[] = [];

			for (let i = 0; i < stepCount; i++) {
				const step = AutomationStepMapper.map(row, { prefix: `step_${i}_` }).value();
				if (step) steps.push(step);
			}

			expect(steps).toHaveLength(3);
			expect(steps[0]!.title).toBe('First');
			expect(steps[1]!.title).toBe('Second');
			expect(steps[2]!.title).toBe('Third');
		});
	});
});
