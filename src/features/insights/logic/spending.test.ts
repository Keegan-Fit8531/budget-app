import { expect, it } from 'vitest';
import { categorize } from './spending';

it('short capitals in a shop name stay capitals', () => {
  expect(categorize('SPARK NZ TRADING Auckland').shop).toBe('Spark NZ');
});
