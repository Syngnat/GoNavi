import { type ShellConvertResult, parseBooleanLiteral } from './mongodbLiterals';
import {
  parseCollectionAndMethod,
  splitTopLevelComma,
  parseChainCalls,
  parseMongoJSONDoc,
  parseMongoSortObject,
  parsePositiveInt,
  isNoopMongoChainMethod,
  parseMongoOptionalDoc,
  parseMongoJSONPipeline,
  parseBooleanArg,
  parseMongoJSONArray,
  normalizeMongoDocuments,
} from './mongodbShellParse';
import { buildMongoCountCommand, buildMongoFindCommand } from './mongodbQueryBuild';
import { parseMongoJSONValue } from './mongodbEditing';

const buildMongoInsertCommand = (
  collection: string,
  documents: Record<string, unknown>[],
  options: Record<string, unknown>,
): string => {
  const command: Record<string, unknown> = {
    insert: String(collection || '').trim(),
    documents,
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.bypassDocumentValidation !== 'undefined') {
    command.bypassDocumentValidation = !!options.bypassDocumentValidation;
  }
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

const buildMongoUpdateCommand = (
  collection: string,
  filter: Record<string, unknown>,
  update: unknown,
  options: Record<string, unknown>,
  multi: boolean,
): string => {
  const updateItem: Record<string, unknown> = {
    q: filter,
    u: update,
    multi,
  };
  if (typeof options.upsert !== 'undefined') updateItem.upsert = !!options.upsert;
  if (typeof options.collation !== 'undefined') updateItem.collation = options.collation;
  if (typeof options.arrayFilters !== 'undefined') updateItem.arrayFilters = options.arrayFilters;
  if (typeof options.hint !== 'undefined') updateItem.hint = options.hint;

  const command: Record<string, unknown> = {
    update: String(collection || '').trim(),
    updates: [updateItem],
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.bypassDocumentValidation !== 'undefined') {
    command.bypassDocumentValidation = !!options.bypassDocumentValidation;
  }
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

const buildMongoDeleteCommand = (
  collection: string,
  filter: Record<string, unknown>,
  options: Record<string, unknown>,
  limit: 0 | 1,
): string => {
  const deleteItem: Record<string, unknown> = {
    q: filter,
    limit,
  };
  if (typeof options.collation !== 'undefined') deleteItem.collation = options.collation;
  if (typeof options.hint !== 'undefined') deleteItem.hint = options.hint;

  const command: Record<string, unknown> = {
    delete: String(collection || '').trim(),
    deletes: [deleteItem],
  };
  if (typeof options.ordered !== 'undefined') command.ordered = !!options.ordered;
  if (typeof options.writeConcern !== 'undefined') command.writeConcern = options.writeConcern;
  if (typeof options.comment !== 'undefined') command.comment = options.comment;
  if (typeof options.let !== 'undefined') command.let = options.let;
  return JSON.stringify(command);
};

const convertMongoShellShortcutCommand = (raw: string): ShellConvertResult | null => {
  const normalized = String(raw || '')
    .replace(/[;；]+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === 'show dbs' || normalized === 'show databases') {
    return {
      recognized: true,
      command: JSON.stringify({ listDatabases: 1, nameOnly: true }),
    };
  }

  if (normalized === 'show collections' || normalized === 'show tables') {
    return {
      recognized: true,
      command: JSON.stringify({ listCollections: 1, filter: {}, nameOnly: true }),
    };
  }

  return null;
};

export const convertMongoShellToJsonCommand = (raw: string): ShellConvertResult => {
  let input = String(raw || '').trim();
  input = input.replace(/^[\s]*(\/\/[^\n]*\n)+/g, '').trim();
  input = input.replace(/[;；]+\s*$/, '');
  const shortcut = convertMongoShellShortcutCommand(input);
  if (shortcut) {
    return shortcut;
  }
  if (!/^db\./i.test(input)) {
    return { recognized: false };
  }

  try {
    const parsed = parseCollectionAndMethod(input);
    if (!parsed) return { recognized: false };

    const collection = parsed.collection;
    const method = parsed.method;
    const args = splitTopLevelComma(parsed.argsText);
    const chain = parseChainCalls(parsed.tailText);

    if (method === 'find' || method === 'findone') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} first argument`) : {};
      let projection = args.length > 1 ? parseMongoJSONDoc(args[1], `${method} second argument (projection)`) : undefined;
      let sort: Record<string, 1 | -1> | undefined;
      let limit: number | undefined = method === 'findone' ? 1 : undefined;
      let skip: number | undefined;
      let useCountCommand = false;

      for (const item of chain) {
        if (item.method === 'sort') {
          sort = parseMongoSortObject(item.arg);
          continue;
        }
        if (item.method === 'limit') {
          limit = parsePositiveInt(item.arg, 'limit');
          continue;
        }
        if (item.method === 'skip') {
          skip = parsePositiveInt(item.arg, 'skip');
          continue;
        }
        if (item.method === 'project') {
          projection = parseMongoJSONDoc(item.arg, 'project argument');
          continue;
        }
        if (item.method === 'count') {
          if (item.arg) {
            const parsedBool = parseBooleanLiteral(item.arg);
            if (parsedBool === null) {
              throw new Error('count chain argument must be true or false');
            }
          }
          useCountCommand = true;
          continue;
        }
        if (isNoopMongoChainMethod(item.method)) {
          continue;
        }
        throw new Error(`Unsupported chain method .${item.method}()`);
      }

      if (method === 'findone') {
        limit = 1;
      }
      if (useCountCommand) {
        return {
          recognized: true,
          command: buildMongoCountCommand(collection, filter),
        };
      }

      return {
        recognized: true,
        command: buildMongoFindCommand({
          collection,
          filter,
          projection,
          sort,
          limit,
          skip,
        }),
      };
    }

    if (method === 'count' || method === 'countdocuments') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} argument`) : {};
      return {
        recognized: true,
        command: buildMongoCountCommand(collection, filter),
      };
    }

    if (method === 'distinct') {
      if (args.length === 0) throw new Error('distinct field argument is required');
      const key = parseMongoJSONValue(args[0]);
      if (typeof key !== 'string' || !key.trim()) {
        throw new Error('distinct field argument must be a string');
      }
      const query = args.length > 1 ? parseMongoJSONDoc(args[1], 'distinct query argument') : {};
      const options = args.length > 2 ? parseMongoOptionalDoc(args[2]) : {};
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      const command: Record<string, unknown> = {
        distinct: collection,
        key: key.trim(),
        query,
      };
      for (const option of ['collation', 'hint', 'comment', 'maxTimeMS', 'readConcern', 'let']) {
        if (typeof options[option] !== 'undefined') command[option] = options[option];
      }
      return {
        recognized: true,
        command: JSON.stringify(command),
      };
    }

    if (method === 'aggregate') {
      const pipeline = args.length > 0 ? parseMongoJSONPipeline(args[0]) : [];
      const options = args.length > 1 ? parseMongoJSONDoc(args[1], 'aggregate second argument (options)') : {};

      for (const item of chain) {
        if (item.method === 'sort') {
          pipeline.push({ $sort: parseMongoSortObject(item.arg) });
          continue;
        }
        if (item.method === 'limit') {
          pipeline.push({ $limit: parsePositiveInt(item.arg, 'limit') });
          continue;
        }
        if (item.method === 'skip') {
          pipeline.push({ $skip: parsePositiveInt(item.arg, 'skip') });
          continue;
        }
        if (item.method === 'match') {
          pipeline.push({ $match: parseMongoJSONDoc(item.arg, 'match argument') });
          continue;
        }
        if (item.method === 'project') {
          pipeline.push({ $project: parseMongoJSONDoc(item.arg, 'project argument') });
          continue;
        }
        if (item.method === 'allowdiskuse') {
          options.allowDiskUse = parseBooleanArg(item.arg, 'allowDiskUse argument');
          continue;
        }
        if (isNoopMongoChainMethod(item.method)) {
          continue;
        }
        throw new Error(`Unsupported chain method .${item.method}()`);
      }

      const command: Record<string, unknown> = {
        aggregate: collection,
        pipeline,
      };
      Object.assign(command, options || {});
      if (typeof command.cursor === 'undefined') {
        command.cursor = {};
      }

      return {
        recognized: true,
        command: JSON.stringify(command),
      };
    }

    if (method === 'insertone' || method === 'insertmany' || method === 'insert') {
      if (args.length === 0) throw new Error(`${method} first argument is required`);
      const firstArg = parseMongoJSONValue(args[0]);
      let documents: Record<string, unknown>[] = [];
      if (method === 'insertone') {
        if (!firstArg || typeof firstArg !== 'object' || Array.isArray(firstArg)) {
          throw new Error('insertOne first argument must be a JSON object');
        }
        documents = [firstArg as Record<string, unknown>];
      } else if (method === 'insertmany') {
        const docs = parseMongoJSONArray(args[0], 'insertMany first argument');
        documents = normalizeMongoDocuments(docs, 'insertMany first argument');
      } else {
        documents = normalizeMongoDocuments(firstArg, 'insert first argument');
      }
      const options = parseMongoOptionalDoc(args[1]);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoInsertCommand(collection, documents, options),
      };
    }

    if (method === 'replaceone') {
      if (args.length < 2) {
        throw new Error('replaceOne requires filter and replacement arguments');
      }
      const filter = parseMongoJSONDoc(args[0], 'replaceOne first argument');
      const replacement = parseMongoJSONDoc(args[1], 'replaceOne second argument');
      const options = parseMongoOptionalDoc(args[2]);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoUpdateCommand(collection, filter, replacement, options, false),
      };
    }

    if (method === 'updateone' || method === 'updatemany' || method === 'update') {
      if (args.length < 2) {
        throw new Error(`${method} requires at least filter and update arguments`);
      }
      const filter = parseMongoJSONDoc(args[0], `${method} first argument`);
      const updateExpr = parseMongoJSONValue(args[1]);
      if (
        !updateExpr ||
        typeof updateExpr !== 'object'
      ) {
        throw new Error(`${method} second argument must be update document or pipeline`);
      }
      let options: Record<string, unknown> = {};
      if (method === 'update') {
        const third = args[2];
        const fourth = args[3];
        const thirdBool = parseBooleanLiteral(String(third || ''));
        if (typeof third === 'undefined' || !String(third).trim()) {
          options = {};
        } else if (thirdBool !== null) {
          options.upsert = thirdBool;
          if (typeof fourth !== 'undefined' && String(fourth).trim()) {
            const fourthBool = parseBooleanLiteral(String(fourth));
            if (fourthBool === null) throw new Error('update fourth argument must be true or false');
            options.multi = fourthBool;
          }
        } else {
          options = parseMongoOptionalDoc(third);
          if (typeof fourth !== 'undefined' && String(fourth).trim()) {
            const fourthBool = parseBooleanLiteral(String(fourth));
            if (fourthBool === null) throw new Error('update fourth argument must be true or false');
            options.multi = fourthBool;
          }
        }
      } else {
        options = parseMongoOptionalDoc(args[2]);
      }
      const multi = method === 'updatemany' || (method === 'update' && options.multi === true);
      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoUpdateCommand(collection, filter, updateExpr, options, multi),
      };
    }

    if (method === 'deleteone' || method === 'deletemany' || method === 'remove') {
      const filter = args.length > 0 ? parseMongoJSONDoc(args[0], `${method} first argument`) : {};
      let options: Record<string, unknown> = {};
      let limit: 0 | 1 = method === 'deleteone' ? 1 : 0;

      if (method === 'remove' && args.length > 1) {
        const rawSecond = String(args[1] || '').trim().toLowerCase();
        if (rawSecond === 'true' || rawSecond === 'false') {
          limit = rawSecond === 'true' ? 1 : 0;
        } else {
          options = parseMongoOptionalDoc(args[1]);
          if (typeof options.justOne !== 'undefined') {
            limit = options.justOne ? 1 : 0;
            delete options.justOne;
          }
        }
      } else if (args.length > 1) {
        options = parseMongoOptionalDoc(args[1]);
      }

      if (method === 'deletemany') limit = 0;
      if (method === 'deleteone') limit = 1;

      for (const item of chain) {
        if (isNoopMongoChainMethod(item.method)) continue;
        throw new Error(`Unsupported chain method .${item.method}()`);
      }
      return {
        recognized: true,
        command: buildMongoDeleteCommand(collection, filter, options, limit),
      };
    }

    return { recognized: false };
  } catch (error: any) {
    return {
      recognized: true,
      error: String(error?.message || error || 'Mongo shell command parse failed'),
    };
  }
};
