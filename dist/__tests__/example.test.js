import { describe, it, expect } from 'vitest';
describe('Example Test Suite', () => {
    it('should perform basic arithmetic', () => {
        expect(1 + 1).toBe(2);
    });
    it('should handle string operations', () => {
        expect('hello'.toUpperCase()).toBe('HELLO');
    });
    it('should work with arrays', () => {
        const arr = [1, 2, 3];
        expect(arr).toHaveLength(3);
        expect(arr).toContain(2);
    });
    it('should work with objects', () => {
        const obj = { name: 'test', value: 42 };
        expect(obj).toHaveProperty('name');
        expect(obj.value).toBe(42);
    });
});
//# sourceMappingURL=example.test.js.map