/**
 * Cellar's lint rules: a store is reached through its service, a facade read takes `{ params, options? }`, a read's
 * params pass absence through rather than spelling it `''`, and a read's result is used as a `DataResult`. They find
 * the app's stores and services from `settings.cellar`, so they know nothing of any one app's directories:
 *
 *   settings: {
 *     cellar: {
 *       storesDir: 'app-shared/src/stores',     // from the directory the stores' imports are resolved against
 *       servicesDir: 'app-shared/src/services',
 *       wiringDir: /\/stores\/cellar\//,        // files that bind stores to a database, which may import them
 *       wiringHint: 'Wiring belongs in src/stores/cellar/.',
 *       extraCallShapeFacades: [],               // services held to facade_call_shape that import no store
 *     },
 *   }
 *
 * Plain CommonJS, since ESLint loads plugins without a build step.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} layout
 * @param {string} layout.storesDir The stores' directory from the app's root, such as `app-shared/src/stores`.
 * @param {string} layout.servicesDir The services' directory from the app's root, such as `app-shared/src/services`.
 * @param {RegExp} layout.wiringDir Files that bind the stores to a database, which may import them directly.
 * @param {string} layout.wiringHint The sentence telling someone wiring up a backend where that code belongs.
 * @param {string[]} [layout.extraCallShapeFacades] Services held to `facade_call_shape` that import no store.
 */
function createCellarRules(layout) {
  // A store's module specifier: the stores' directory by its path, or reached relatively as `../../stores`.
  const STORE_SPECIFIER = `(?:${escapeRegExp(layout.storesDir)}|(?:\\.\\.\\/)+${escapeRegExp(layout.storesDir.split('/').pop())})`;


  const STORES_SEGMENT = `${layout.storesDir}/`;

  const NON_STORE_DIRS = new Set(['tests']);

  /**
   * The directory that binds the stores in each app — `src/v2/stores/cellar/` on mobile, `src/stores/cellar/` on
   * web — so the exemption is granted by being the wiring rather than by being named like it.
   */
  const WIRING_DIR = layout.wiringDir;

  const TEST_FILE = /(^|\/)(tests?|__tests__|__mocks__)\/|\.(test|spec)\.[jt]sx?$/;

  const toPosix = p => p.replace(/\\/g, '/');

  /** The `clients/` directory above `fromFile`, or null if there isn't one. */
  function findClientsRoot(fromFile) {
    let dir = path.dirname(fromFile);
    for (;;) {
      if (fs.existsSync(path.join(dir, ...layout.storesDir.split('/')))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /** Maps each store domain to the service facades that import it. */
  let facadeIndexCache = null;
  function facadeIndex(root) {
    if (facadeIndexCache && facadeIndexCache.root === root) return facadeIndexCache.index;
    const index = new Map();
    const servicesDir = path.join(root, ...layout.servicesDir.split('/'));
    const storeImport = new RegExp(`from\\s+'${STORE_SPECIFIER}\\/([a-z0-9_]+)`, 'g');

    const record = (domain, facade) => {
      if (NON_STORE_DIRS.has(domain)) return;
      if (!index.has(domain)) index.set(domain, new Set());
      index.get(domain).add(facade);
    };

    const readDir = dir => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return [];
      }
    };

    const creditFile = (full, facade) => {
      if (TEST_FILE.test(toPosix(full))) return;
      let src;
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch (e) {
        return;
      }
      for (const m of src.matchAll(storeImport)) record(m[1], facade);
    };

    const scanDir = (dir, facade, depth) => {
      for (const entry of readDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) scanDir(full, facade, depth + 1);
        } else if (/\.tsx?$/.test(entry.name)) {
          creditFile(full, facade);
        }
      }
    };

    for (const entry of readDir(servicesDir)) {
      const facade = entry.name.replace(/\.tsx?$/, '');
      if (entry.isDirectory()) scanDir(path.join(servicesDir, entry.name), facade, 1);
      else if (/\.tsx?$/.test(entry.name)) creditFile(path.join(servicesDir, entry.name), facade);
    }

    facadeIndexCache = { root, index };
    return index;
  }

  const pascalCase = snake => snake.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

  /** Facades subject to `facade_call_shape` that import no store, so `facadeIndex` does not find them. */
  const EXTRA_CALL_SHAPE_FACADES = new Set(layout.extraCallShapeFacades || []);

  /** The `services/` entry a file belongs to — `foo_service.ts` and `foo_service/**` are both `foo_service`. */
  function facadeOf(filename) {
    const m = toPosix(filename).match(new RegExp(`\\/${escapeRegExp(layout.servicesDir)}\\/([^/]+?)(?:\\.tsx?)?(?:\\/|$)`));
    return m ? m[1] : null;
  }

  let callShapeFacadesCache = null;
  function isCallShapeFacade(root, filename) {
    const facade = facadeOf(filename);
    if (!facade) return false;

    if (!callShapeFacadesCache || callShapeFacadesCache.root !== root) {
      const set = new Set(EXTRA_CALL_SHAPE_FACADES);
      for (const facades of facadeIndex(root).values()) for (const f of facades) set.add(f);
      callShapeFacadesCache = { root, set };
    }
    return callShapeFacadesCache.set.has(facade);
  }

  const READ_DECL = /export\s+(?:const|function)\s+((?:use|get)[A-Z]\w*)/g;

  /** The names of a file's paired-read tables: `const Reads = { Player: pairRead(...) }`, or `const Reads = publishReads(...)`. */
  function pairedReadTableNames(src) {
    const names = new Set();
    let open = null;
    let sawPairRead = false;

    for (const line of src.split('\n')) {
      // `const Reads = publishReads(() => store.reads)` publishes every read of the store in one line.
      const published = /^\s*(?:const|let)\s+(\w+)\s*=\s*publishReads\(/.exec(line);
      if (published) {
        names.add(published[1]);
        continue;
      }
      if (open === null) {
        const start = /^\s*(?:const|let)\s+(\w+)\s*=\s*\{\s*$/.exec(line);
        if (start) {
          open = start[1];
          sawPairRead = false;
        }
      } else if (/^\s*\}/.test(line)) {
        if (sawPairRead) names.add(open);
        open = null;
      } else if (line.includes('pairRead(')) {
        sawPairRead = true;
      }
    }
    return names;
  }
  const SERVICE_NAMESPACE_DECL = /export\s+namespace\s+(\w+Service)\b/g;
  const STORE_IMPORT_BLOCK =
    new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+'${STORE_SPECIFIER}\\/[^']*'`, 'g');

  /** Adds `file`'s store-reading hooks and getters to `out`, under each service namespace the file declares. */
  function collectStoreReadNames(file, out) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return;
    }

    // Store symbols this file imports, under their local aliases.
    const storeNames = new Set();
    for (const block of src.matchAll(STORE_IMPORT_BLOCK)) {
      for (const spec of block[1].split(',')) {
        const name = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
        if (name) storeNames.add(name.trim());
      }
    }
    // A read published from a table (`export const getPlayer = Reads.Player.getValue`) mentions only the table,
    // so the table counts as a store symbol too.
    for (const table of pairedReadTableNames(src)) storeNames.add(table);

    if (storeNames.size === 0) return;
    const mentionsStore = new RegExp(`\\b(?:${[...storeNames].join('|')})\\b`);

    const namespaces = [...src.matchAll(SERVICE_NAMESPACE_DECL)];

    namespaces.forEach((ns, i) => {
      const section = src.slice(ns.index, i + 1 < namespaces.length ? namespaces[i + 1].index : src.length);
      // A declaration's body runs to the next matched declaration.
      const starts = [...section.matchAll(READ_DECL)];
      starts.forEach((m, j) => {
        const body = section.slice(m.index, j + 1 < starts.length ? starts[j + 1].index : section.length);
        if (!mentionsStore.test(body)) return;
        if (!out.has(ns[1])) out.set(ns[1], new Set());
        out.get(ns[1]).add(m[1]);
      });
    });
  }

  /**
   * The read name in `PlayerService.Hooks.usePlayer(...)` or `PlayerService.getPlayer(...)`, or null when the
   * call is not a store read.
   */
  function storeReadCallName(node, readNames) {
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || !callee.object || !callee.property) return null;
    const name = callee.property.name;
    if (!name) return null;
    const object = callee.object;

    const ns =
      object.type === 'MemberExpression' && object.property && object.property.name === 'Hooks' ? object.object : object;
    if (ns.type !== 'Identifier') return null;

    const names = readNames.get(ns.name);
    return names && names.has(name) ? name : null;
  }

  let storeReadNamesCache = null;
  function storeReadNames(root) {
    if (storeReadNamesCache && storeReadNamesCache.root === root) return storeReadNamesCache.index;

    const index = new Map();
    const servicesDir = path.join(root, ...layout.servicesDir.split('/'));

    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      entries.forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) walk(full, depth + 1);
        } else if (/\.tsx?$/.test(entry.name) && !TEST_FILE.test(toPosix(full))) {
          collectStoreReadNames(full, index);
        }
      });
    };

    walk(servicesDir, 1);
    storeReadNamesCache = { root, index };
    return index;
  }

  /** Every field a store read's `DataResult` has, from Cellar that builds one, so the rule cannot drift from it. */
  /** Every field a store read's `DataResult` has; a test in Cellar keeps it equal to `DATA_RESULT_KEYS`. */
    const DATA_RESULT_KEYS = ['data', 'status', 'isLoading', 'isFetching', 'isSuccess', 'isError', 'refetch'];

  /** React Query v4 `UseQueryResult` fields that a `DataResult` does not carry. */
  const RQ_ONLY_RESULT_KEYS = [
    'dataUpdatedAt',
    'error',
    'errorUpdatedAt',
    'errorUpdateCount',
    'failureCount',
    'fetchStatus',
    'isFetched',
    'isFetchedAfterMount',
    'isInitialLoading',
    'isLoadingError',
    'isPaused',
    'isPlaceholderData',
    'isPreviousData',
    'isRefetchError',
    'isRefetching',
    'isStale',
    'remove',
  ];


  /** Every message these rules report, keyed by `messageId`. `{{placeholder}}`s are filled from `data` at the report site. */

  const MESSAGES = {
    cellar_store_boundary: {
      reachesPastFacade:
        "`{{segment}}{{domain}}` is the {{domain}} store's internals: its reads are addressed by store-shaped arguments rather than " +
        'the facade params, and most of what it exports (backend builders, the schema, the shred spec, raw selectors) is not a read ' +
        'at all. {{via}}. ' +
        'If you only need a type, write `import type { ... }`. ' +
        '{{wiringHint}}',
    },
    no_read_arg_sentinel: {
      emptyStringSentinel:
        "`''` as a fallback in a read's `params` stands in for an argument that isn't there, which only stays inert " +
        'while a separate condition keeps rejecting it. Read args are nullable: pass the optional through ' +
        "(`playerId`, not `playerId ?? ''`), and if the read should be off for some other reason say so directly " +
        'with `options: { enabled: <condition> }`.',
    },
    facade_call_shape: {
      tooManyArguments:
        '`{{name}}` takes {{count}} arguments. Every facade read takes exactly one, `{ params, options? }` — fold the rest into ' +
        "`params`, which is the read's complete address, and put anything that gates or tunes the read (`enabled`, `staleTime`) in `options`.",
      positionalArgument:
        '`{{name}}` takes a positional argument. Every facade read takes `{ params, options? }` — a caller should never have to ' +
        'remember which reads are spelled which way. Wrap it: `{ params: { {{example}}: ... } }`. (If this already is the right ' +
        'shape behind a named type, destructure it — `({ params, options }: {{typeName}})` — so the shape is visible here.)',
      strayKeys:
        '`{{name}}` takes {{stray}} beside `params`. Every facade read takes `{ params, options? }` — `params` is the read\'s ' +
        'complete address, so anything that narrows or identifies what is read belongs inside it, and anything that gates or ' +
        'tunes the read (`enabled`, `staleTime`) belongs in `options`.',
    },
    no_read_result_rq_field: {
      notOnDataResult:
        '`{{hook}}` returns a `DataResult`, which has no `{{key}}` — this read is always `undefined`, so whatever it guards never fires. {{fix}}',
    },
  };

  const rules = {
    /**
     * Flags any value import of `<storesDir>/<domain>` from app code. Type-only imports are allowed.
     * The store layer itself, its service facades, per-platform wiring, and tests are exempt.
     */
    'cellar_store_boundary': {
      meta: {
        type: 'problem',
        docs: { description: 'Reach a store through its service facade, not directly.' },
        schema: [],
        messages: MESSAGES.cellar_store_boundary,
      },
      create(context) {
      const filename = toPosix(context.getFilename());

      if (
        filename.includes(`/${layout.storesDir}/`) ||
        filename.includes(`/${layout.servicesDir}/`) ||
        WIRING_DIR.test(filename) ||
        TEST_FILE.test(filename)
      ) {
        return {};
      }

      const storeDomain = source => {
        if (typeof source !== 'string') return null;
        let rest = null;
        const direct = source.indexOf(STORES_SEGMENT);
        if (direct >= 0) {
          rest = source.slice(direct + STORES_SEGMENT.length);
        } else if (source.startsWith('.')) {
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), source));
          const i = resolved.indexOf(STORES_SEGMENT);
          if (i >= 0) rest = resolved.slice(i + STORES_SEGMENT.length);
        }
        if (!rest) return null;
        const domain = rest.split('/')[0];
        if (!domain || NON_STORE_DIRS.has(domain)) return null;
        return domain;
      };

      const dataFor = domain => {
        const root = findClientsRoot(context.getFilename());
        const facades = root ? Array.from(facadeIndex(root).get(domain) || []).sort() : [];
        const via = facades.length
          ? `Call it through ${facades.map(f => `\`${pascalCase(f)}\` (${layout.servicesDir}/${f})`).join(' or ')}`
          : `No service fronts this store yet — add a facade under \`${layout.servicesDir}\` and call that`;
        return { segment: STORES_SEGMENT, domain, via, wiringHint: layout.wiringHint };
      };

      const report = (node, source) => {
        const domain = storeDomain(source);
        if (domain) context.report({ node, messageId: 'reachesPastFacade', data: dataFor(domain) });
      };

      const isTypeOnly = node => {
        if (node.importKind === 'type' || node.exportKind === 'type') return true;
        const specifiers = node.specifiers;
        // A bare `import 'x'` names nothing but still runs the module.
        if (!specifiers || specifiers.length === 0) return false;
        return specifiers.every(s => s.importKind === 'type' || s.exportKind === 'type');
      };

      return {
        ImportDeclaration(node) {
          if (!isTypeOnly(node)) report(node, node.source.value);
        },
        'ExportNamedDeclaration[source]'(node) {
          if (!isTypeOnly(node)) report(node, node.source.value);
        },
        ExportAllDeclaration(node) {
          if (node.exportKind !== 'type') report(node, node.source.value);
        },
        CallExpression(node) {
          const callee = node.callee;
          const isRequire = callee.type === 'Identifier' && callee.name === 'require';
          const isDynamicImport = callee.type === 'Import' || callee.type === 'ImportExpression';
          if ((isRequire || isDynamicImport) && node.arguments.length > 0 && node.arguments[0].type === 'Literal') {
            report(node, node.arguments[0].value);
          }
        },
      };
      },
    },
    /**
     * Flags an empty-string fallback (`??`, `||`, or a conditional) anywhere inside a read's `params`, for both
     * `use*` hooks and their `get*` twins. A field whose value is a plain `''` is not a fallback and passes.
     */
    'no_read_arg_sentinel': {
      meta: {
        type: 'problem',
        docs: { description: "Absence in a read's params is passed through, not spelled ''." },
        schema: [],
        messages: MESSAGES.no_read_arg_sentinel,
      },
      create(context) {
      const root = findClientsRoot(context.getFilename());
      const readNames = root ? storeReadNames(root) : new Map();
      if (readNames.size === 0) return {};

      const isEmptyString = node => node && node.type === 'Literal' && node.value === '';

      const isStoreReadCall = node => !!storeReadCallName(node, readNames);

      /**
       * Properties already reported, for the file rather than the call: one hoisted locator is typically read by
       * several reads, and each of them reaches the same `?? ''` — which is one thing to fix, not four.
       */
      const reported = new Set();

      /** The empty-string arm of a fallback, or null when the expression isn't one. */
      const sentinelArm = node => {
        if (!node) return null;
        if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression') return sentinelArm(node.expression);
        if (node.type === 'ChainExpression') return sentinelArm(node.expression);
        if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
          return isEmptyString(node.right) ? node.right : sentinelArm(node.right);
        }
        if (node.type === 'ConditionalExpression') {
          if (isEmptyString(node.consequent)) return node.consequent;
          if (isEmptyString(node.alternate)) return node.alternate;
          return sentinelArm(node.consequent) || sentinelArm(node.alternate);
        }
        return null;
      };

      /** The expression inside any type assertions, so a locator spelled `{ … } as const` reads as the object it is. */
      const unwrap = node => {
        if (!node) return null;
        if (
          node.type === 'TSAsExpression' ||
          node.type === 'TSSatisfiesExpression' ||
          node.type === 'TSNonNullExpression' ||
          node.type === 'TSTypeAssertion' ||
          node.type === 'TSInstantiationExpression'
        ) {
          return unwrap(node.expression);
        }
        return node;
      };

      /** What a `useMemo` callback evaluates to: its expression body, or the sole `return` of a block one. */
      const bodyValue = body => {
        if (!body || body.type !== 'BlockStatement') return body;
        const returns = body.body.filter(statement => statement.type === 'ReturnStatement');
        return returns.length === 1 ? returns[0].argument : null;
      };

      /** The initializer behind an identifier, when a single `const` binds it and nothing reassigns it. */
      const initBehind = identifier => {
        const scope = context.getScope();
        let variable = null;
        for (let s = scope; s && !variable; s = s.upper) {
          variable = s.variables.find(v => v.name === identifier.name) || null;
        }
        if (!variable || variable.defs.length !== 1) return null;
        const def = variable.defs[0];
        if (def.type !== 'Variable' || !def.node.init || def.node.id.type !== 'Identifier') return null;
        // Reassigned somewhere, so the initializer is not what the read receives.
        if (variable.references.some(ref => ref.isWrite() && ref.identifier !== def.name)) return null;

        const init = unwrap(def.node.init);
        if (init.type !== 'CallExpression') return init;
        const callee = init.callee;
        const isMemo = callee && (callee.name === 'useMemo' || (callee.property && callee.property.name === 'useMemo'));
        if (!isMemo) return null;
        const callback = init.arguments[0];
        return callback ? unwrap(bodyValue(callback.body)) : null;
      };

      /**
       * Every value a node can evaluate to: type assertions removed, one `const` binding followed, and both arms
       * of a ternary taken. Written inline a locator is the node itself; hoisted, or built in the `useMemo` a
       * stable args object usually needs, it is a step away — and these rules seeing only the inline form is how
       * a call site opts out of all of them without saying so.
       */
      const valueCandidates = (node, out = [], seen = new Set()) => {
        const resolved = unwrap(node);
        if (!resolved || seen.has(resolved)) return out;
        seen.add(resolved);
        if (resolved.type === 'ConditionalExpression') {
          valueCandidates(resolved.consequent, out, seen);
          valueCandidates(resolved.alternate, out, seen);
        } else if (resolved.type === 'Identifier') {
          valueCandidates(initBehind(resolved), out, seen);
        } else {
          out.push(resolved);
        }
        return out;
      };

      /** The `params` value of every object a read call's argument can evaluate to. */
      const paramsValues = arg => {
        const out = [];
        for (const object of valueCandidates(arg)) {
          const params =
            object.type === 'ObjectExpression' &&
            object.properties.find(p => p.type === 'Property' && p.key && (p.key.name === 'params' || p.key.value === 'params'));
          if (params) out.push(params.value);
        }
        return out;
      };

      /**
       * Every property inside a `params` object at any depth, so nested locators are covered. Each value is
       * resolved first: `params: { locator: statsLocator }` is how every stats read is written, so a walk that
       * stops at an identifier — or at the `as const` those locators carry — sees none of them.
       */
      const paramProperties = (node, out = []) => {
        for (const value of valueCandidates(node)) {
          if (value.type === 'ObjectExpression') {
            for (const p of value.properties) {
              if (p.type === 'Property') {
                out.push(p);
                paramProperties(p.value, out);
              }
            }
          } else if (value.type === 'ArrayExpression') {
            for (const element of value.elements) paramProperties(element, out);
          }
        }
        return out;
      };

      /**
       * The empty-string arm behind an identifier, when it is bound by a `const` the read is the sole reader of.
       * A binding read elsewhere has been normalized for general use and is left alone.
       */
      const boundSentinel = identifier => {
        const scope = context.getScope();
        let variable = null;
        for (let s = scope; s && !variable; s = s.upper) {
          variable = s.variables.find(v => v.name === identifier.name) || null;
        }
        if (!variable || variable.defs.length !== 1) return null;
        const def = variable.defs[0];
        if (def.type !== 'Variable' || !def.node.init) return null;
        // A destructured binding does not receive the initializer's `''`: `const [sport] = s?.split('-') ?? ''`
        // binds `undefined`.
        if (def.node.id.type !== 'Identifier') return null;
        if (variable.references.some(ref => ref.isWrite() && ref.identifier !== def.name)) return null;
        if (variable.references.filter(ref => ref.isRead()).length !== 1) return null;
        return sentinelArm(def.node.init);
      };

      return {
        CallExpression(node) {
          if (!isStoreReadCall(node)) return;
          for (const arg of node.arguments) {
            for (const params of paramsValues(arg)) {
              for (const prop of paramProperties(params).filter(p => !reported.has(p))) {
                const arm = sentinelArm(prop.value) || (prop.value.type === 'Identifier' ? boundSentinel(prop.value) : null);
                if (arm) {
                  reported.add(prop);
                  context.report({ node: prop, messageId: 'emptyStringSentinel' });
                }
              }
            }
          }
        },
      };
      },
    },
    /**
     * Requires every exported read on a service facade to take one argument, `{ params, options? }`, where
     * `params` is the read's complete address. Checked at the declaration, which covers every call site through
     * the type checker. Facade exports that are not reads carry an `eslint-disable-next-line` with a reason.
     */
    'facade_call_shape': {
      meta: {
        type: 'problem',
        docs: { description: 'Every facade read takes one argument, `{ params, options? }`.' },
        schema: [],
        messages: MESSAGES.facade_call_shape,
      },
      create(context) {
      const filename = toPosix(context.getFilename());
      if (TEST_FILE.test(filename)) return {};

      const root = findClientsRoot(context.getFilename());
      if (!root || !isCallShapeFacade(root, filename)) return {};

      const ALLOWED = new Set(['params', 'options']);

      const unwrap = t => (t && t.type === 'TSParenthesizedType' ? unwrap(t.typeAnnotation) : t);

      /**
       * The property names a parameter's declared type offers a caller, or null when the type is a bare
       * reference whose members this rule cannot see.
       */
      const typeKeys = node => {
        const t = unwrap(node);
        if (!t) return null;

        if (t.type === 'TSTypeLiteral') {
          return t.members.map(m => (m.key && (m.key.name || m.key.value)) || '?');
        }
        if (t.type === 'TSIntersectionType') {
          const parts = t.types.map(typeKeys);
          return parts.some(p => p === null) ? null : parts.flat();
        }
        // `ReadOptions` contributes `options` and nothing else.
        if (t.type === 'TSTypeReference' && t.typeName && t.typeName.name === 'ReadOptions') return ['options'];

        // `Parameters<typeof someRead>[0]` — the argument is another read's argument, checked at that read.
        if (t.type === 'TSIndexedAccessType') {
          const obj = unwrap(t.objectType);
          const idx = unwrap(t.indexType);
          const isParameters = obj && obj.type === 'TSTypeReference' && obj.typeName && obj.typeName.name === 'Parameters';
          const isFirst = idx && idx.type === 'TSLiteralType' && idx.literal && idx.literal.value === 0;
          if (isParameters && isFirst) return [];
        }
        return null;
      };

      /** The names a destructured parameter introduces, or null when it isn't destructured. */
      const patternKeys = param => {
        if (!param || param.type !== 'ObjectPattern') return null;
        return param.properties.map(p => (p.type === 'RestElement' ? '...' : (p.key && (p.key.name || p.key.value)) || '?'));
      };

      const check = (name, fn) => {
        const FN = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];
        // Reads with no parameter list of their own — query builders and paired reads — get their shape from
        // the builder or from `PairedRead`, and are checked there.
        if (!fn || !FN.includes(fn.type)) return;

        const params = fn.params;
        if (params.length === 0) return;

        if (params.length > 1) {
          context.report({ node: params[1], messageId: 'tooManyArguments', data: { name, count: String(params.length) } });
          return;
        }

        const param = params[0].type === 'AssignmentPattern' ? params[0].left : params[0];
        const annotation = param.typeAnnotation && param.typeAnnotation.typeAnnotation;
        // Either the declared type shows the shape or destructuring does. A bare type alias shows neither and is
        // reported; a read that wants a named args type can destructure it.
        const keys = typeKeys(annotation) ?? patternKeys(param);

        if (keys === null) {
          context.report({
            node: annotation || param,
            messageId: 'positionalArgument',
            data: {
              name,
              example: param.name || 'x',
              typeName: annotation && annotation.typeName ? annotation.typeName.name : 'Args',
            },
          });
          return;
        }

        const stray = keys.filter(k => !ALLOWED.has(k));
        if (stray.length === 0) return;

        context.report({
          node: annotation,
          messageId: 'strayKeys',
          data: { name, stray: stray.map(k => `\`${k}\``).join(', ') },
        });
      };

      // `use*` is a read wherever it sits. `get*` is a read only when it sits in a twin namespace *and* reaches a
      // store, which separates the hooks' imperative twins from query builders, transforms, and dev helpers.
      const readNames = storeReadNames(root);
      const TWIN_NAMESPACES = new Set(['Hooks', 'Internal']);

      const isRead = (node, name) => {
        if (/^use[A-Z]/.test(name)) return true;
        if (!/^get[A-Z]/.test(name)) return false;

        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'TSModuleDeclaration' && p.id && p.id.name) {
            // The `*Service` namespace is the facade root.
            if (/Service$/.test(p.id.name)) {
              const names = readNames.get(p.id.name);
              return Boolean(names && names.has(name));
            }
            if (!TWIN_NAMESPACES.has(p.id.name)) return false;
          }
        }
        return false;
      };

      return {
        'ExportNamedDeclaration > FunctionDeclaration'(node) {
          if (node.id && isRead(node, node.id.name)) check(node.id.name, node);
        },
        'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator'(node) {
          if (!node.id || node.id.type !== 'Identifier' || !isRead(node, node.id.name)) return;
          check(node.id.name, node.init);
        },
      };
      },
    },
    /**
     * Flags React Query fields read off a store read's `DataResult`, which yield `undefined`. Destructured
     * fields are checked against `DATA_RESULT_KEYS`; fields read off a held result are checked against
     * `RQ_ONLY_RESULT_KEYS`, since `results.map(...)` on a plural read is otherwise indistinguishable from a
     * field access. `usePrime*` is exempt — it returns a `PrimeState`.
     */
    'no_read_result_rq_field': {
      meta: {
        type: 'problem',
        docs: { description: 'A store read returns a DataResult, not a React Query result.' },
        schema: [],
        messages: MESSAGES.no_read_result_rq_field,
      },
      create(context) {
      const root = findClientsRoot(context.getFilename());
      const readNames = root ? storeReadNames(root) : new Map();
      if (readNames.size === 0) return {};

      const allowed = new Set(DATA_RESULT_KEYS);
      const rqOnly = new Set(RQ_ONLY_RESULT_KEYS);

      // `DataResult` equivalents named in the report; fields with no equivalent get the full field list instead.
      const REPLACEMENT = {
        isInitialLoading: 'isLoading',
        isRefetching: 'isFetching',
        isLoadingError: 'isError',
        isRefetchError: 'isError',
        error: 'isError',
        isFetching: 'isFetching',
      };

      const dataFor = (hook, key) => ({
        hook,
        key,
        fix: REPLACEMENT[key]
          ? `Use \`${REPLACEMENT[key]}\`.${key === 'error' ? ' (A `DataResult` carries no error object — the read either has rows or it does not.)' : ''}`
          : `A \`DataResult\` has ${DATA_RESULT_KEYS.map(k => `\`${k}\``).join(', ')}, and nothing else.`,
      });

      /** Store reads held in a variable, checked at `Program:exit` once every reference's `parent` is set. */
      const held = [];

      const readHookName = init => {
        if (!init || init.type !== 'CallExpression') return null;
        const hook = storeReadCallName(init, readNames);
        // Getters return the value itself, not a `DataResult`.
        if (!hook || !hook.startsWith('use') || hook.startsWith('usePrime')) return null;
        return hook;
      };

      return {
        VariableDeclarator(node) {
          const hook = readHookName(node.init);
          if (!hook || !node.id) return;

          if (node.id.type === 'ObjectPattern') {
            node.id.properties.forEach(prop => {
              if (prop.type !== 'Property' || !prop.key || prop.computed) return;
              const key = prop.key.name || prop.key.value;
              if (allowed.has(key)) return;
              context.report({ node: prop, messageId: 'notOnDataResult', data: dataFor(hook, key) });
            });
            return;
          }

          if (node.id.type === 'Identifier') held.push({ node, hook });
        },

        'Program:exit'() {
          for (const { node, hook } of held) {
            for (const variable of context.getDeclaredVariables(node)) {
              for (const ref of variable.references) {
                const id = ref.identifier;
                const parent = id.parent;
                const readsAField = parent && parent.type === 'MemberExpression' && parent.object === id && !parent.computed;
                const key = readsAField && parent.property ? parent.property.name : null;
                if (key && rqOnly.has(key)) {
                  context.report({ node: parent, messageId: 'notOnDataResult', data: dataFor(hook, key) });
                }
              }
            }
          }
        },
      };
      },
    },
  };

  return { rules, messages: MESSAGES, storeReadNames, DATA_RESULT_KEYS, RQ_ONLY_RESULT_KEYS };
}

const RULE_NAMES = ['cellar_store_boundary', 'no_read_arg_sentinel', 'facade_call_shape', 'no_read_result_rq_field'];

/** The layout a lint run configured, checked once: every rule needs to know where the stores and services are. */
function layoutOf(settings) {
  const layout = settings && settings.cellar;
  if (!layout || typeof layout.storesDir !== 'string' || typeof layout.servicesDir !== 'string') {
    throw new Error('@sleeperhq/eslint-plugin-cellar: set `settings.cellar.storesDir` and `settings.cellar.servicesDir` in your ESLint config');
  }
  return {
    storesDir: layout.storesDir,
    servicesDir: layout.servicesDir,
    wiringDir: layout.wiringDir instanceof RegExp ? layout.wiringDir : new RegExp(layout.wiringDir || '(?!)'),
    wiringHint: layout.wiringHint || '',
    extraCallShapeFacades: layout.extraCallShapeFacades || [],
  };
}

/** The rules built for one layout, reused for every file a run lints with the same settings. */
const built = new Map();
function rulesFor(settings) {
  const layout = layoutOf(settings);
  const key = JSON.stringify({ ...layout, wiringDir: String(layout.wiringDir) });
  if (!built.has(key)) built.set(key, createCellarRules(layout));
  return built.get(key);
}

// Metadata never depends on the layout, so it is read off a placeholder one.
const described = createCellarRules({ storesDir: 'stores', servicesDir: 'services', wiringDir: /(?!)/, wiringHint: '' });

module.exports = {
  rules: Object.fromEntries(
    RULE_NAMES.map((name) => [
      name,
      { meta: described.rules[name].meta, create: (context) => rulesFor(context.settings).rules[name].create(context) },
    ]),
  ),
  /** The store-reading hooks and getters each service declares, for a layout's `settings`: what the rules check calls against. */
  storeReadNames: (settings, root) => rulesFor(settings).storeReadNames(root),
  DATA_RESULT_KEYS: described.DATA_RESULT_KEYS,
  RQ_ONLY_RESULT_KEYS: described.RQ_ONLY_RESULT_KEYS,
};
