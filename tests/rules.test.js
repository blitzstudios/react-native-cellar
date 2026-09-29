/**
 * Each rule over a throwaway app tree, configured through `settings.cellar` the way an app configures it. The tree's
 * service disagrees with its filename (`score_service.ts` declaring `GameScoreService`) and sits in a directory of its
 * own, the two shapes a scan of the services has missed before: a facade it misses is silently no longer checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { RuleTester } = require('eslint');

const plugin = require('..');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cellar-lint-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

fs.mkdirSync(path.join(ROOT, 'shared/stores/scores'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'shared/services/score_service'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'shared/services/score_service/score_service.ts'),
  [
    "import { scoresStore } from '../../stores/scores';",
    '',
    'export namespace GameScoreService {',
    '  export namespace Hooks {',
    '    export const useLiveScore = (args) => scoresStore.reads.Stat.useValue(args.params);',
    '  }',
    '}',
  ].join('\n'),
);

const CONSUMER = path.join(ROOT, 'app/src/some_component.tsx');
const WIRING = path.join(ROOT, 'app/src/stores/cellar/bind.ts');

const settings = {
  cellar: {
    storesDir: 'shared/stores',
    servicesDir: 'shared/services',
    wiringDir: /\/app\/src\/stores\/cellar\//,
    wiringHint: 'Wiring belongs in app/src/stores/cellar/.',
  },
};

const ruleTester = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings,
});

global.describe = test.describe;
global.it = test.it;

ruleTester.run('cellar_store_boundary', plugin.rules.cellar_store_boundary, {
  valid: [
    { filename: CONSUMER, code: "import type { Score } from '../../shared/stores/scores';" },
    { filename: WIRING, code: "import { scoresStore } from '../../../../shared/stores/scores';" },
  ],
  invalid: [{ filename: CONSUMER, code: "import { scoresStore } from '../../shared/stores/scores';", errors: [{ messageId: 'reachesPastFacade' }] }],
});

ruleTester.run('facade_call_shape', plugin.rules.facade_call_shape, {
  valid: [{ filename: path.join(ROOT, 'shared/services/score_service/score_service.ts'), code: 'export const useScore = ({ params, options }) => null;' }],
  invalid: [
    {
      filename: path.join(ROOT, 'shared/services/score_service/score_service.ts'),
      code: 'export const useScore = (gameId) => null;',
      errors: [{ messageId: 'positionalArgument' }],
    },
  ],
});

ruleTester.run('no_read_arg_sentinel', plugin.rules.no_read_arg_sentinel, {
  valid: [
    { filename: CONSUMER, code: 'GameScoreService.Hooks.useLiveScore({ params: { gameId } });' },
    // A namespace the tree does not declare stays out of scope.
    { filename: CONSUMER, code: "LeagueService.Hooks.useDraft({ params: { draftId: draftId ?? '' } });" },
  ],
  invalid: [
    { filename: CONSUMER, code: "GameScoreService.Hooks.useLiveScore({ params: { gameId: gameId ?? '' } });", errors: [{ messageId: 'emptyStringSentinel' }] },
  ],
});

ruleTester.run('no_read_result_rq_field', plugin.rules.no_read_result_rq_field, {
  valid: [{ filename: CONSUMER, code: 'const { data, isLoading } = GameScoreService.Hooks.useLiveScore({ params: { gameId } });' }],
  invalid: [
    {
      filename: CONSUMER,
      code: 'const { data, isInitialLoading } = GameScoreService.Hooks.useLiveScore({ params: { gameId } });',
      errors: [{ messageId: 'notOnDataResult' }],
    },
  ],
});

test('asks for the layout rather than guessing one', () => {
  const context = { settings: {}, getFilename: () => CONSUMER, filename: CONSUMER };
  require('node:assert').throws(() => plugin.rules.cellar_store_boundary.create(context), /settings\.cellar\.storesDir/);
});
