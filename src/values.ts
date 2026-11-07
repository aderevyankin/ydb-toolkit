import {StatusIds_StatusCode} from "@ydbjs/api/operation";
import type {Type, Value} from "@ydbjs/value";
import {List, ListType} from "@ydbjs/value/list";
import {Optional, OptionalType} from "@ydbjs/value/optional";
import {Struct, StructType} from "@ydbjs/value/struct";
import {
  Bool, BoolType, Double, DoubleType, Int32, Int32Type, Int64, Int64Type,
  Json, JsonType, JsonDocument, JsonDocumentType, Timestamp, TimestampType,
  Uint32, Uint32Type, Uint64, Uint64Type, Utf8, Utf8Type,
} from "@ydbjs/value/primitive";

function integer64(value: bigint | number, unsigned = false): bigint {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new Error("Int64/Uint64 requires bigint or a safe integer number");
  }
  const result = BigInt(value);
  const min = unsigned ? 0n : -(1n << 63n);
  const max = unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n;
  if (result < min || result > max) {throw new RangeError("Int64/Uint64 out of range");}
  return result;
}

function nativeToValue(type: Type, value: unknown): Value {
  if (!(type instanceof OptionalType) && (value ?? null) === null) {throw new Error("Required List/Struct value is missing");}
  if (type instanceof Int64Type) {return new Int64(integer64(value as bigint | number));}
  if (type instanceof Uint64Type) {return new Uint64(integer64(value as bigint | number, true));}
  if (type instanceof Int32Type || type instanceof Uint32Type) {
    const unsigned = type instanceof Uint32Type;
    if (typeof value !== "number" || !Number.isInteger(value)
      || value < (unsigned ? 0 : -2147483648) || value > (unsigned ? 4294967295 : 2147483647)) {
      throw new TypeError("Expected an in-range Int32/Uint32 integer");
    }
    return unsigned ? new Uint32(value) : new Int32(value);
  }
  if (type instanceof DoubleType) {
    if (typeof value !== "number") {throw new TypeError("Expected Double number");}
    return new Double(value);
  }
  if (type instanceof BoolType) {
    if (typeof value !== "boolean") {throw new TypeError("Expected Bool boolean");}
    return new Bool(value);
  }
  if (type instanceof Utf8Type || type instanceof JsonType || type instanceof JsonDocumentType) {
    if (typeof value !== "string") {throw new TypeError("Expected Utf8/JSON string");}
    if (type instanceof Utf8Type) {return new Utf8(value);}
    JSON.parse(value);
    return type instanceof JsonType ? new Json(value) : new JsonDocument(value);
  }
  if (type instanceof TimestampType) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {throw new TypeError("Expected a valid Date");}
    return new Timestamp(value);
  }
  if (type instanceof OptionalType) {
    return (value ?? null) === null ? new Optional(null, type.itemType) : new Optional(nativeToValue(type.itemType, value));
  }
  if (type instanceof ListType) {
    if (!Array.isArray(value) || value.length === 0) {throw new Error("Empty or invalid YDB List parameter");}
    return new List(...value.map(item => nativeToValue(type.item, item)));
  }
  if (type instanceof StructType) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new Error("Expected Struct object");}
    return new Struct(Object.fromEntries([...type].map(([name, fieldType]) => {
      if (!Object.hasOwn(value, name) && !(fieldType instanceof OptionalType)) {throw new Error(`Missing Struct field: ${name}`);}
      return [name, nativeToValue(fieldType, (value as Record<string, unknown>)[name])];
    })), type);
  }
  throw new Error(`Unsupported native conversion: ${type.constructor.name}`);
}

export const TypedValues = {
  bool: (value: boolean) => new Bool(value), double: (value: number) => new Double(value),
  int32: (value: number) => new Int32(value), int64: (value: bigint | number) => new Int64(integer64(value)),
  uint32: (value: number) => new Uint32(value), uint64: (value: bigint | number) => new Uint64(integer64(value, true)),
  utf8: (value: string) => new Utf8(value), timestamp: (value: Date) => new Timestamp(value),
  json: (value: string) => new Json(value), jsonDocument: (value: string) => new JsonDocument(value),
  optional: (value: Value) => new Optional(value), optionalNull: (type: Type) => new Optional(null, type),
  list: (type: Type, values: unknown[]): List => {
    if (values.length === 0) {throw new Error("Empty YDB List parameter is not supported: skip the query");}
    return new List(...values.map(value => nativeToValue(type, value)));
  },
} as const;

export const Types = {
  BOOL: new BoolType(), DOUBLE: new DoubleType(), INT32: new Int32Type(), INT64: new Int64Type(),
  JSON: new JsonType(), JSON_DOCUMENT: new JsonDocumentType(), TIMESTAMP: new TimestampType(),
  UINT32: new Uint32Type(), UINT64: new Uint64Type(), UTF8: new Utf8Type(),
  optional: (type: Type) => new OptionalType(type), list: (type: Type) => new ListType(type),
  struct: (fields: Record<string, Type>) => new StructType(Object.keys(fields), Object.values(fields)),
} as const;

const optional = <T>(type: Type, make: (value: T) => Value) => (value?: T | null): Value =>
  (value ?? null) === null ? TypedValues.optionalNull(type) : TypedValues.optional(make(value as T));
const required = <T>(name: string, make: (value: T) => Value) => (value: T): Value => {
  if ((value ?? null) === null) {throw new Error(`Required ${name} value is missing`);}
  return make(value);
};
function jsonText(value: unknown): string {
  const text = JSON.stringify(value) ?? null;
  if (text === null) {throw new Error("Value cannot be serialized as JSON");}
  return text;
}
const json = (value: unknown): Value => new Json(jsonText(value));
const jsonDocument = (value: unknown): Value => new JsonDocument(jsonText(value));

export const ydb = {
  required: {
    utf8: required("Utf8", TypedValues.utf8), int32: required("Int32", TypedValues.int32),
    int64: required("Int64", TypedValues.int64), uint32: required("Uint32", TypedValues.uint32),
    uint64: required("Uint64", TypedValues.uint64), double: required("Double", TypedValues.double),
    bool: required("Bool", TypedValues.bool), timestamp: required("Timestamp", TypedValues.timestamp),
    json: required("Json", json), jsonDocument: required("JsonDocument", jsonDocument),
  },
  optional: {
    utf8: optional(Types.UTF8, TypedValues.utf8), int32: optional(Types.INT32, TypedValues.int32),
    int64: optional(Types.INT64, TypedValues.int64), uint32: optional(Types.UINT32, TypedValues.uint32),
    uint64: optional(Types.UINT64, TypedValues.uint64), double: optional(Types.DOUBLE, TypedValues.double),
    bool: optional(Types.BOOL, TypedValues.bool), timestamp: optional(Types.TIMESTAMP, TypedValues.timestamp),
    json: optional(Types.JSON, json), jsonDocument: optional(Types.JSON_DOCUMENT, jsonDocument),
  },
};

export const isPreconditionFailed = (error: unknown): boolean =>
  (error as {code?: unknown} | null)?.code === StatusIds_StatusCode.PRECONDITION_FAILED;
