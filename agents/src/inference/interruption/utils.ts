// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { FRAME_DURATION_IN_S, MIN_INTERRUPTION_DURATION_IN_S } from './defaults.js';

export class BoundedCache<K, V extends object> {
  private cache: Map<K, V> = new Map();
  private readonly maxLen: number;

  constructor(maxLen: number = 10) {
    this.maxLen = maxLen;
  }

  set(key: K, value: V): void {
    this.cache.set(key, value);
    if (this.cache.size > this.maxLen) {
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }
  }

  updateValue(key: K, fields: Partial<V>): V | undefined {
    const value = this.cache.get(key);
    if (!value) return value;

    for (const [fieldName, fieldValue] of Object.entries(fields) as [keyof V, V[keyof V]][]) {
      if (fieldValue === undefined) continue;
      if (fieldName in (value as object)) {
        (value as Record<string, unknown>)[String(fieldName)] = fieldValue;
      }
    }
    return value;
  }

  setOrUpdate(key: K, factory: () => V, fields: Partial<V>): V {
    if (!this.cache.has(key)) {
      this.set(key, factory());
    }
    const result = this.updateValue(key, fields);
    if (!result) {
      throw new Error('setOrUpdate invariant failed: entry should exist after set');
    }
    return result;
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  pop(predicate?: (value: V) => boolean): V | undefined {
    if (predicate === undefined) {
      const first = this.cache.entries().next().value as [K, V] | undefined;
      if (!first) return undefined;
      const [key, value] = first;
      this.cache.delete(key);
      return value;
    }

    const keys = Array.from(this.cache.keys());
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const value = this.cache.get(key)!;
      if (predicate(value)) {
        this.cache.delete(key);
        return value;
      }
    }
    return undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }
}

export function estimateProbability(
  probabilities: number[],
  windowSizeInS: number = MIN_INTERRUPTION_DURATION_IN_S,
): number {
  const nTh = Math.ceil(windowSizeInS / FRAME_DURATION_IN_S);
  if (probabilities.length < nTh) {
    return 0;
  }

  const sorted = [...probabilities].sort((a, b) => b - a);
  return sorted[nTh - 1]!;
}
