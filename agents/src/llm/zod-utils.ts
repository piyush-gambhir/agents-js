// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { toStrictJsonSchema } from 'openai/lib/transform';
import { zodToJsonSchema as zodToJsonSchemaV3 } from 'zod-to-json-schema';
import type * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';

export type ZodParseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZodSchema = z4.core.$ZodType<any, any> | z3.Schema<any, z3.ZodTypeDef, any>;

/**
 * Detects if a schema is a Zod v4 schema.
 * Zod v4 schemas have a `_zod` property that v3 schemas don't have.
 *
 * @param schema - The schema to check
 * @returns True if the schema is a Zod v4 schema
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Required to match Zod v4's type signature
export function isZod4Schema(schema: ZodSchema): schema is z4.core.$ZodType<any, any> {
  return '_zod' in schema;
}

/**
 * Checks if a value is a Zod schema (either v3 or v4).
 *
 * @param value - The value to check
 * @returns True if the value is a Zod schema
 */
export function isZodSchema(value: unknown): value is ZodSchema {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if ('_zod' in value) {
    return true;
  }

  if ('_def' in value && typeof value._def === 'object' && value._def !== null) {
    const def = value._def as Record<string, unknown>;
    if ('typeName' in def) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a Zod schema is an object schema.
 *
 * @param schema - The schema to check
 * @returns True if the schema is an object schema
 */
export function isZodObjectSchema(schema: ZodSchema): boolean {
  const schemaWithInternals = schema as {
    _def?: { type?: string; typeName?: string };
    _zod?: { traits?: Set<string> };
  };

  if (isZod4Schema(schema)) {
    return (
      schemaWithInternals._def?.type === 'object' ||
      schemaWithInternals._zod?.traits?.has('ZodObject') ||
      false
    );
  }

  return schemaWithInternals._def?.typeName === 'ZodObject';
}

/**
 * Converts a Zod schema to JSON Schema format.
 * Handles both Zod v3 and v4 schemas automatically.
 *
 * Adapted from Vercel AI SDK's zod3Schema and zod4Schema functions.
 * Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L237-L269
 *
 * @param schema - The Zod schema to convert
 * @param isOpenai - Whether to use OpenAI-specific formatting (default: true)
 * @returns A JSON Schema representation of the Zod schema
 */
export function zodSchemaToJsonSchema(
  schema: ZodSchema,
  isOpenai: boolean = true,
  strict: boolean = false,
): JSONSchema7 {
  let result: JSONSchema7;

  if (isZod4Schema(schema)) {
    result = z4.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'output',
      reused: 'inline',
    }) as JSONSchema7;
  } else {
    result = zodToJsonSchemaV3(schema, {
      target: isOpenai ? 'openAi' : 'jsonSchema7',
      $refStrategy: 'none',
    }) as JSONSchema7;
  }

  return strict ? (toStrictJsonSchema(result) as JSONSchema7) : result;
}

/**
 * Parses a value against a Zod schema.
 * Handles both Zod v3 and v4 parse APIs automatically.
 *
 * @param schema - The Zod schema to parse against
 * @param value - The value to parse
 * @returns A promise that resolves to the parse result
 */
export async function parseZodSchema<T = unknown>(
  schema: ZodSchema,
  value: unknown,
): Promise<ZodParseResult<T>> {
  if (isZod4Schema(schema)) {
    const result = await z4.safeParseAsync(schema, value);
    return result as ZodParseResult<T>;
  } else {
    const result = await schema.safeParseAsync(value);
    return result as ZodParseResult<T>;
  }
}
