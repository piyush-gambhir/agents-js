// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SpeakingRateData } from './synchronizer.js';

describe('SpeakingRateData', () => {
  describe('constructor', () => {
    it('should initialize with empty arrays', () => {
      const data = new SpeakingRateData();
      expect(data.timestamps).toEqual([]);
      expect(data.speakingRate).toEqual([]);
      expect(data.speakIntegrals).toEqual([]);
      expect(data.pushedDuration).toBe(0);
    });
  });

  describe('addByRate', () => {
    it('should add a single rate entry', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);

      expect(data.timestamps).toEqual([1.0]);
      expect(data.speakingRate).toEqual([5.0]);
      expect(data.speakIntegrals).toEqual([5.0]);
      expect(data.pushedDuration).toBe(1.0);
    });

    it('should accumulate integrals across multiple entries', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0);
      data.addByRate(2.0, 6.0);
      data.addByRate(3.5, 2.0);

      expect(data.timestamps).toEqual([1.0, 2.0, 3.5]);
      expect(data.speakingRate).toEqual([4.0, 6.0, 2.0]);
      expect(data.speakIntegrals).toEqual([4.0, 10.0, 13.0]);
      expect(data.pushedDuration).toBe(3.5);
    });

    it('should handle zero rate', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 0.0);

      expect(data.timestamps).toEqual([1.0]);
      expect(data.speakingRate).toEqual([0.0]);
      expect(data.speakIntegrals).toEqual([0.0]);
    });
  });

  describe('addByAnnotation', () => {
    it('should buffer text without startTime', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', undefined, undefined);

      expect(data.timestamps).toEqual([]);
      expect(data.pushedDuration).toBe(0);
    });

    it('should add entry when startTime is provided', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', undefined, undefined);
      data.addByAnnotation('world', 1.0, undefined);

      expect(data.timestamps).toEqual([1.0]);
      expect(data.speakingRate).toEqual([5.0]);
      expect(data.speakIntegrals).toEqual([5.0]);
    });

    it('should handle startTime and endTime together', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello ', 0.0, 0.5);
      data.addByAnnotation('world', 0.5, 1.0);

      expect(data.timestamps.length).toBeGreaterThanOrEqual(2);
      expect(data.pushedDuration).toBe(1.0);
    });

    it('should calculate rate based on buffered text length', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('ab', undefined, undefined);
      data.addByAnnotation('cde', undefined, undefined);
      data.addByAnnotation('', 2.0, undefined);

      expect(data.timestamps).toEqual([2.0]);
      expect(data.speakingRate).toEqual([2.5]);
      expect(data.speakIntegrals).toEqual([5.0]);
    });

    it('should handle zero time delta gracefully', () => {
      const data = new SpeakingRateData();
      data.addByAnnotation('hello', 0.0, undefined);

      expect(data.timestamps).toEqual([0.0]);
      expect(data.speakingRate).toEqual([0.0]);
      expect(data.speakIntegrals).toEqual([0.0]);
    });
  });

  describe('accumulateTo', () => {
    it('should return 0 for empty data', () => {
      const data = new SpeakingRateData();
      expect(data.accumulateTo(1.0)).toBe(0);
    });

    it('should return 0 for timestamp before first entry', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);
      expect(data.accumulateTo(0.5)).toBe(0);
    });

    it('should return exact integral at timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0);
      data.addByRate(2.0, 6.0);

      expect(data.accumulateTo(1.0)).toBe(4.0);
      expect(data.accumulateTo(2.0)).toBe(10.0);
    });

    it('should interpolate between timestamps', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0);
      data.addByRate(2.0, 6.0);

      expect(data.accumulateTo(1.5)).toBe(7.0);
    });

    it('should extrapolate beyond last timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 4.0);
      data.addByRate(2.0, 6.0);

      expect(data.accumulateTo(3.0)).toBe(16.0);
    });

    it('should not exceed next integral when interpolating', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 100.0);
      data.addByRate(2.0, 1.0);

      expect(data.accumulateTo(1.5)).toBe(100.5);
    });
  });

  describe('pushedDuration', () => {
    it('should return 0 when empty', () => {
      const data = new SpeakingRateData();
      expect(data.pushedDuration).toBe(0);
    });

    it('should return last timestamp', () => {
      const data = new SpeakingRateData();
      data.addByRate(1.0, 5.0);
      data.addByRate(2.5, 3.0);
      data.addByRate(4.0, 7.0);

      expect(data.pushedDuration).toBe(4.0);
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical TTS word timing scenario', () => {
      const data = new SpeakingRateData();

      data.addByAnnotation('Hello ', 0.0, 0.3);
      data.addByAnnotation('world', 0.3, 0.6);

      expect(data.pushedDuration).toBe(0.6);

      const mid1 = data.accumulateTo(0.15);
      expect(mid1).toBeGreaterThan(0);
      expect(mid1).toBeLessThan(6);

      const mid2 = data.accumulateTo(0.45);
      expect(mid2).toBeGreaterThan(6);
    });

    it('should handle mixed rate and annotation data', () => {
      const data = new SpeakingRateData();

      data.addByRate(0.5, 4.0);

      data.addByAnnotation('test', undefined, undefined);
      data.addByAnnotation('', 1.0, undefined);

      expect(data.timestamps).toEqual([0.5, 1.0]);
      expect(data.speakIntegrals).toEqual([2.0, 6.0]);
    });
  });
});
