/**
 * The query, sort, projection and update semantics the local driver runs on.
 *
 * Every operator here exists because something in this repository uses it.
 * Everything else throws, so an unsupported filter surfaces as a crash during
 * development rather than as a query that silently matches the wrong rows.
 */
import { UnsupportedQueryError, type Filter, type ProjectionSpec, type SortSpec, type UpdateSpec } from './types';

const SUPPORTED_OPERATORS = new Set(['$in', '$nin', '$ne', '$eq', '$exists', '$type', '$gt', '$gte', '$lt', '$lte', '$regex']);
const SUPPORTED_UPDATE_OPERATORS = new Set(['$set', '$setOnInsert', '$unset']);

/** Mongo treats a missing field and an explicit null as the same value in filters. */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof RegExp);
}

export function getPath(document: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, document);
}

function setPath(document: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let target = document;
  for (const segment of segments) {
    const next = target[segment];
    if (!isPlainObject(next)) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  target[last] = value;
}

function deletePath(document: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let target: Record<string, unknown> | undefined = document;
  for (const segment of segments) {
    const next: unknown = target[segment];
    if (!isPlainObject(next)) return;
    target = next;
  }
  delete target[last];
}

function equals(left: unknown, right: unknown): boolean {
  if (isNullish(left) && isNullish(right)) return true;
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equals(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => equals(left[key], right[key]));
  }
  return false;
}

/** Mongo scalar ordering, narrowed to the types this repo stores. */
export function compareValues(left: unknown, right: unknown): number {
  if (isNullish(left) && isNullish(right)) return 0;
  if (isNullish(left)) return -1;
  if (isNullish(right)) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

/** A scalar filter value matches an array field when any element matches. */
function matchesScalar(fieldValue: unknown, predicate: (candidate: unknown) => boolean): boolean {
  if (Array.isArray(fieldValue) && fieldValue.some(predicate)) return true;
  return predicate(fieldValue);
}

function bsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return Number.isInteger(value) ? 'int' : 'double';
    case 'boolean': return 'bool';
    case 'object': return 'object';
    default: return 'undefined';
  }
}

function matchesOperators(fieldValue: unknown, condition: Record<string, unknown>): boolean {
  for (const [operator, operand] of Object.entries(condition)) {
    if (!SUPPORTED_OPERATORS.has(operator)) {
      throw new UnsupportedQueryError(`unsupported query operator "${operator}"`);
    }
    if (!matchesOperator(fieldValue, operator, operand)) return false;
  }
  return true;
}

function matchesOperator(fieldValue: unknown, operator: string, operand: unknown): boolean {
  switch (operator) {
    case '$eq':
      return matchesScalar(fieldValue, (candidate) => equals(candidate, operand));
    case '$ne':
      return !matchesScalar(fieldValue, (candidate) => equals(candidate, operand));
    case '$in': {
      if (!Array.isArray(operand)) throw new UnsupportedQueryError('$in requires an array');
      return matchesScalar(fieldValue, (candidate) => operand.some((item) => equals(candidate, item)));
    }
    case '$nin': {
      if (!Array.isArray(operand)) throw new UnsupportedQueryError('$nin requires an array');
      return !matchesScalar(fieldValue, (candidate) => operand.some((item) => equals(candidate, item)));
    }
    case '$exists':
      return (fieldValue !== undefined) === Boolean(operand);
    case '$type': {
      const wanted = Array.isArray(operand) ? operand : [operand];
      return matchesScalar(fieldValue, (candidate) => wanted.includes(bsonTypeOf(candidate)));
    }
    case '$gt':
      return !isNullish(fieldValue) && compareValues(fieldValue, operand) > 0;
    case '$gte':
      return !isNullish(fieldValue) && compareValues(fieldValue, operand) >= 0;
    case '$lt':
      return !isNullish(fieldValue) && compareValues(fieldValue, operand) < 0;
    case '$lte':
      return !isNullish(fieldValue) && compareValues(fieldValue, operand) <= 0;
    case '$regex': {
      const pattern = operand instanceof RegExp ? operand : new RegExp(String(operand));
      return matchesScalar(fieldValue, (candidate) => typeof candidate === 'string' && pattern.test(candidate));
    }
    default:
      throw new UnsupportedQueryError(`unsupported query operator "${operator}"`);
  }
}

/**
 * Validates a filter without needing a document to test it against, so an
 * unsupported operator throws even when the collection happens to be empty.
 */
export function assertSupportedFilter(filter: Filter = {}): void {
  for (const [key, condition] of Object.entries(filter)) {
    if (key.startsWith('$')) throw new UnsupportedQueryError(`unsupported top-level query operator "${key}"`);
    if (!isPlainObject(condition)) continue;
    const keys = Object.keys(condition);
    const operators = keys.filter((name) => name.startsWith('$'));
    if (operators.length === 0) continue;
    if (operators.length !== keys.length) {
      throw new UnsupportedQueryError(`"${key}" mixes operators with literal keys`);
    }
    for (const operator of operators) {
      if (!SUPPORTED_OPERATORS.has(operator)) throw new UnsupportedQueryError(`unsupported query operator "${operator}"`);
    }
  }
}

export function assertSupportedUpdate(update: UpdateSpec): void {
  for (const operator of Object.keys(update)) {
    if (!SUPPORTED_UPDATE_OPERATORS.has(operator)) {
      throw new UnsupportedQueryError(`unsupported update operator "${operator}"`);
    }
  }
}

export function matchesFilter(document: Record<string, unknown>, filter: Filter = {}): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key.startsWith('$')) {
      throw new UnsupportedQueryError(`unsupported top-level query operator "${key}"`);
    }
    const fieldValue = getPath(document, key);

    if (condition instanceof RegExp) {
      if (!matchesScalar(fieldValue, (candidate) => typeof candidate === 'string' && condition.test(candidate))) {
        return false;
      }
      continue;
    }
    if (isPlainObject(condition) && Object.keys(condition).some((key) => key.startsWith('$'))) {
      if (!matchesOperators(fieldValue, condition)) return false;
      continue;
    }
    if (!matchesScalar(fieldValue, (candidate) => equals(candidate, condition))) return false;
  }
  return true;
}

export function sortDocuments<T>(documents: T[], spec?: SortSpec): T[] {
  if (!spec || Object.keys(spec).length === 0) return documents;
  const keys = Object.entries(spec);
  return [...documents].sort((left, right) => {
    for (const [key, direction] of keys) {
      const order = compareValues(getPath(left, key), getPath(right, key));
      if (order !== 0) return order * direction;
    }
    return 0;
  });
}

export function projectDocument<T extends Record<string, unknown>>(document: T, spec?: ProjectionSpec): Partial<T> {
  if (!spec) return document;
  const including = Object.values(spec).some((value) => value === 1);
  if (including) {
    const projected: Record<string, unknown> = {};
    if (spec._id !== 0) projected._id = document._id;
    for (const [key, value] of Object.entries(spec)) {
      if (value === 1 && key !== '_id') projected[key] = getPath(document, key);
    }
    return projected as Partial<T>;
  }
  const projected = { ...document } as Record<string, unknown>;
  for (const [key, value] of Object.entries(spec)) {
    if (value === 0) delete projected[key];
  }
  return projected as Partial<T>;
}

/** The document Mongo would synthesise for an upsert that matched nothing. */
export function upsertBaseDocument(filter: Filter): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [key, condition] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (condition instanceof RegExp) continue;
    if (isPlainObject(condition) && Object.keys(condition).some((operator) => operator.startsWith('$'))) {
      const equality = condition.$eq;
      if (equality !== undefined) setPath(base, key, equality);
      continue;
    }
    setPath(base, key, condition);
  }
  return base;
}

export interface AppliedUpdate<T> {
  document: T;
  changed: boolean;
}

export function applyUpdate<T extends Record<string, unknown>>(
  existing: T | undefined,
  update: UpdateSpec,
  filter: Filter = {},
): AppliedUpdate<T> {
  assertSupportedUpdate(update);

  const inserting = existing === undefined;
  const next = (inserting ? upsertBaseDocument(filter) : { ...existing }) as Record<string, unknown>;

  if (inserting && update.$setOnInsert) {
    for (const [path, value] of Object.entries(update.$setOnInsert)) setPath(next, path, value);
  }
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) setPath(next, path, value);
  }
  if (update.$unset) {
    for (const path of Object.keys(update.$unset)) deletePath(next, path);
  }

  return { document: next as T, changed: inserting || !equals(existing, next) };
}
