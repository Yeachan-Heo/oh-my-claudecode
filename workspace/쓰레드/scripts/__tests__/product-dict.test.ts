import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { NeedsCategory, AffiliatePlatform, ProductEntry } from '../types.js';

const DICT_PATH = path.join(__dirname, '..', '..', 'data', 'product_dict', 'products_v1.json');

describe('product dictionary validation', () => {
  let dict: { version: string; total_products: number; products: ProductEntry[] };

  test('file exists and is valid JSON', () => {
    const raw = fs.readFileSync(DICT_PATH, 'utf8');
    dict = JSON.parse(raw);
    expect(dict).toBeDefined();
  });

  test('total_products matches actual array length', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    expect(dict.products.length).toBe(dict.total_products);
  });

  test('has at least 50 products', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    expect(dict.products.length).toBeGreaterThanOrEqual(50);
  });

  test('no duplicate product_id values', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    const ids = dict.products.map(p => p.product_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('all products have valid needs_categories', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    const validCategories: Set<string> = new Set(['불편해소', '시간절약', '돈절약', '성과향상', '외모건강', '자기표현']);
    for (const product of dict.products) {
      expect(product.needs_categories.length).toBeGreaterThan(0);
      for (const cat of product.needs_categories) {
        expect(validCategories.has(cat)).toBe(true);
      }
    }
  });

  test('all products have valid affiliate_platform', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    const validPlatforms: Set<string> = new Set(['coupang_partners', 'naver_smartstore', 'ali_express', 'other']);
    for (const product of dict.products) {
      expect(validPlatforms.has(product.affiliate_platform)).toBe(true);
    }
  });

  test('all required fields are non-empty', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    for (const product of dict.products) {
      expect(product.product_id).toBeTruthy();
      expect(product.name).toBeTruthy();
      expect(product.category).toBeTruthy();
      expect(product.price_range).toBeTruthy();
      expect(product.description).toBeTruthy();
      expect(product.keywords.length).toBeGreaterThan(0);
    }
  });

  test('all 6 needs categories are covered', () => {
    dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
    const coveredCategories = new Set<string>();
    for (const product of dict.products) {
      for (const cat of product.needs_categories) {
        coveredCategories.add(cat);
      }
    }
    const expected: NeedsCategory[] = ['불편해소', '시간절약', '돈절약', '성과향상', '외모건강', '자기표현'];
    for (const cat of expected) {
      expect(coveredCategories.has(cat)).toBe(true);
    }
  });
});
