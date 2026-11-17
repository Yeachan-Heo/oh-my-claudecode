import { describe, it, expect } from 'vitest';
import { titleToSlug } from '../storage.js';
describe('titleToSlug non-ASCII fallback', () => {
    it('Latin titles unchanged', () => {
        expect(titleToSlug('Auth Architecture')).toBe('auth-architecture.md');
    });
    it('CJK title must not produce bare .md', () => {
        expect(titleToSlug('日本語ドキュメント')).toMatch(/^page-[0-9a-f]{8}\.md$/);
    });
    it('Korean title must not produce bare .md', () => {
        expect(titleToSlug('인증 아키텍처')).toMatch(/^page-[0-9a-f]{8}\.md$/);
    });
    it('empty string must not produce bare .md', () => {
        expect(titleToSlug('')).toMatch(/^page-[0-9a-f]{8}\.md$/);
    });
    it('deterministic for same input', () => {
        expect(titleToSlug('テスト')).toBe(titleToSlug('テスト'));
    });
    it('different CJK titles produce different slugs', () => {
        expect(titleToSlug('日本語')).not.toBe(titleToSlug('中文'));
    });
});
//# sourceMappingURL=slug-nonascii.test.js.map