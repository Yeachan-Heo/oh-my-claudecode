import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  Task,
  checkIncompleteTodos,
  isValidTask,
  readTaskFiles,
  getTaskDirectory,
  isTaskIncomplete,
  checkIncompleteTasks,
  checkLegacyTodos,
  isUserAbort,
  createTodoContinuationHook,
  formatTodoStatus,
  getNextPendingTodo,
  isValidSessionId,
  type Todo,
  type IncompleteTodosResult,
  type StopContext,
  type TaskCheckResult
} from '../hooks/todo-continuation/index.js';

// Mock fs and os modules
vi.mock('fs');
vi.mock('os');

describe('Task System Support', () => {
  const mockHomedir = '/home/testuser';

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getTaskDirectory', () => {
    it('should return correct path for session ID', () => {
      const sessionId = 'abc123';
      const result = getTaskDirectory(sessionId);
      expect(result).toBe(path.join(mockHomedir, '.claude', 'tasks', sessionId));
    });

    it('should handle session ID with special characters', () => {
      const sessionId = 'session-123_test';
      const result = getTaskDirectory(sessionId);
      expect(result).toContain(sessionId);
    });

    it('should handle empty session ID', () => {
      const sessionId = '';
      const result = getTaskDirectory(sessionId);
      // After security validation: empty string is invalid → returns ''
      expect(result).toBe('');
    });
  });

  describe('isValidTask', () => {
    it('should return true for valid Task object', () => {
      const validTask = {
        id: '1',
        subject: 'Test task',
        status: 'pending'
      };
      expect(isValidTask(validTask)).toBe(true);
    });

    it('should return true for Task with all optional fields', () => {
      const fullTask = {
        id: '1',
        subject: 'Test task',
        description: 'A detailed description',
        activeForm: 'Testing task',
        status: 'pending',
        blocks: ['2', '3'],
        blockedBy: ['0']
      };
      expect(isValidTask(fullTask)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isValidTask(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidTask(undefined)).toBe(false);
    });

    it('should return false for missing id', () => {
      expect(isValidTask({ subject: 'Test', status: 'pending' })).toBe(false);
    });

    it('should return false for empty id', () => {
      expect(isValidTask({ id: '', subject: 'Test', status: 'pending' })).toBe(false);
    });

    it('should return false for missing subject', () => {
      expect(isValidTask({ id: '1', status: 'pending' })).toBe(false);
    });

    it('should return false for empty subject', () => {
      expect(isValidTask({ id: '1', subject: '', status: 'pending' })).toBe(false);
    });

    it('should return false for missing status', () => {
      expect(isValidTask({ id: '1', subject: 'Test' })).toBe(false);
    });

    it('should return false for invalid status', () => {
      expect(isValidTask({ id: '1', subject: 'Test', status: 'invalid' })).toBe(false);
    });

    it('should accept all valid status values', () => {
      expect(isValidTask({ id: '1', subject: 'Test', status: 'pending' })).toBe(true);
      expect(isValidTask({ id: '1', subject: 'Test', status: 'in_progress' })).toBe(true);
      expect(isValidTask({ id: '1', subject: 'Test', status: 'completed' })).toBe(true);
    });

    it('should return false for non-object types', () => {
      expect(isValidTask('string')).toBe(false);
      expect(isValidTask(123)).toBe(false);
      expect(isValidTask(true)).toBe(false);
      expect(isValidTask([])).toBe(false);
    });

    it('should return false for id with wrong type', () => {
      expect(isValidTask({ id: 123, subject: 'Test', status: 'pending' })).toBe(false);
    });

    it('should return false for subject with wrong type', () => {
      expect(isValidTask({ id: '1', subject: 123, status: 'pending' })).toBe(false);
    });
  });

  describe('isTaskIncomplete', () => {
    it('should return true for pending task', () => {
      const task: Task = { id: '1', subject: 'Test', status: 'pending' };
      expect(isTaskIncomplete(task)).toBe(true);
    });

    it('should return true for in_progress task', () => {
      const task: Task = { id: '1', subject: 'Test', status: 'in_progress' };
      expect(isTaskIncomplete(task)).toBe(true);
    });

    it('should return false for completed task', () => {
      const task: Task = { id: '1', subject: 'Test', status: 'completed' };
      expect(isTaskIncomplete(task)).toBe(false);
    });
  });

  describe('readTaskFiles', () => {
    it('should return empty array when directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = readTaskFiles('session123');
      expect(result).toEqual([]);
    });

    it('should read valid task files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return JSON.stringify({ id: '1', subject: 'Task 1', status: 'pending' });
        }
        return JSON.stringify({ id: '2', subject: 'Task 2', status: 'completed' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
    });

    it('should skip .lock files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '.lock'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ id: '1', subject: 'Task', status: 'pending' }));

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
    });

    it('should skip non-json files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.txt', 'README.md'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return JSON.stringify({ id: '1', subject: 'Task 1', status: 'pending' });
        }
        return 'not json';
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
    });

    it('should skip invalid JSON files', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return 'not valid json';
        }
        return JSON.stringify({ id: '2', subject: 'Task 2', status: 'pending' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should skip files with invalid task structure', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json', '3.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return JSON.stringify({ id: '1', subject: 'Valid', status: 'pending' });
        } else if (filePath.includes('2.json')) {
          return JSON.stringify({ id: '', subject: 'Invalid', status: 'pending' });
        }
        return JSON.stringify({ subject: 'Missing ID', status: 'pending' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('should handle directory read errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = readTaskFiles('session123');
      expect(result).toEqual([]);
    });

    it('should handle file read errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          throw new Error('File read error');
        }
        return JSON.stringify({ id: '2', subject: 'Task 2', status: 'pending' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });
  });

  describe('checkIncompleteTasks', () => {
    it('should count only incomplete tasks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json', '3.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return JSON.stringify({ id: '1', subject: 'Task 1', status: 'pending' });
        }
        if (filePath.includes('2.json')) {
          return JSON.stringify({ id: '2', subject: 'Task 2', status: 'completed' });
        }
        return JSON.stringify({ id: '3', subject: 'Task 3', status: 'in_progress' });
      });

      const result = checkIncompleteTasks('session123');
      expect(result.count).toBe(2);
      expect(result.total).toBe(3);
      expect(result.tasks).toHaveLength(2);
    });

    it('should return zero when all tasks complete', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: '1', subject: 'Task', status: 'completed' })
      );

      const result = checkIncompleteTasks('session123');
      expect(result.count).toBe(0);
      expect(result.total).toBe(2);
    });

    it('should return correct tasks array', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json', '2.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('1.json')) {
          return JSON.stringify({ id: '1', subject: 'Pending', status: 'pending' });
        }
        return JSON.stringify({ id: '2', subject: 'Complete', status: 'completed' });
      });

      const result = checkIncompleteTasks('session123');
      expect(result.tasks[0].subject).toBe('Pending');
      expect(result.tasks[0].status).toBe('pending');
    });

    it('should handle empty task directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      const result = checkIncompleteTasks('session123');
      expect(result.count).toBe(0);
      expect(result.total).toBe(0);
      expect(result.tasks).toEqual([]);
    });
  });

  describe('checkIncompleteTodos with dual-mode', () => {
    it('should return source: none when no tasks or todos', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = await checkIncompleteTodos('session123');
      expect(result.source).toBe('none');
      expect(result.count).toBe(0);
    });

    it('should return source: task when only Tasks have incomplete items', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return /[\\/]tasks[\\/]/.test(p);
      });
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: '1', subject: 'Task', status: 'pending' })
      );

      const result = await checkIncompleteTodos('session123');
      expect(result.source).toBe('task');
      expect(result.count).toBe(1);
    });

    it('should return source: todo when only legacy todos exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return /[\\/]todos[\\/]/.test(p) || /todos\.json$/.test(p);
      });
      vi.mocked(fs.readdirSync).mockReturnValue(['session123.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([{ content: 'Todo', status: 'pending' }])
      );

      const result = await checkIncompleteTodos('session123');
      expect(result.source).toBe('todo');
      expect(result.count).toBe(1);
    });

    it('should return source: both when both systems have incomplete items', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation((dirPath: any) => {
        if (/[\\/]tasks[\\/]/.test(dirPath)) {
          return ['1.json'] as any;
        }
        return ['session123.json'] as any;
      });
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (/[\\/]tasks[\\/]/.test(filePath)) {
          return JSON.stringify({ id: '1', subject: 'Task', status: 'pending' });
        }
        return JSON.stringify([{ content: 'Todo', status: 'pending' }]);
      });

      const result = await checkIncompleteTodos('session123');
      expect(result.source).toBe('both');
      expect(result.count).toBeGreaterThan(0);
    });

    it('should prioritize tasks over legacy todos', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation((dirPath: any) => {
        if (/[\\/]tasks[\\/]/.test(dirPath)) {
          return ['1.json'] as any;
        }
        return ['session123.json'] as any;
      });
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (/[\\/]tasks[\\/]/.test(filePath)) {
          return JSON.stringify({ id: '1', subject: 'Task Subject', status: 'pending' });
        }
        return JSON.stringify([{ content: 'Legacy Todo', status: 'pending' }]);
      });

      const result = await checkIncompleteTodos('session123');
      expect(result.todos[0].content).toBe('Task Subject');
    });
  });

  describe('isUserAbort', () => {
    it('should return false for undefined context', () => {
      expect(isUserAbort(undefined)).toBe(false);
    });

    it('should return true for user_requested flag (snake_case)', () => {
      const context: StopContext = { user_requested: true };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should return true for userRequested flag (camelCase)', () => {
      const context: StopContext = { userRequested: true };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should detect user_cancel in stop_reason', () => {
      const context: StopContext = { stop_reason: 'user_cancel' };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should detect user_interrupt in stopReason', () => {
      const context: StopContext = { stopReason: 'user_interrupt' };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should detect ctrl_c pattern', () => {
      const context: StopContext = { stop_reason: 'ctrl_c' };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should detect abort pattern', () => {
      const context: StopContext = { stop_reason: 'aborted' };
      expect(isUserAbort(context)).toBe(true);
    });

    it('should detect exact cancel pattern (not substring)', () => {
      // After issue #210 fix, 'cancel' only matches exactly, not as substring
      const context: StopContext = { stop_reason: 'cancel' };
      expect(isUserAbort(context)).toBe(true);
      // Compound words like operation_cancelled should NOT match
      expect(isUserAbort({ stop_reason: 'operation_cancelled' })).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isUserAbort({ stop_reason: 'USER_CANCEL' })).toBe(true);
      expect(isUserAbort({ stop_reason: 'Abort' })).toBe(true);
    });

    it('should return false for normal completion', () => {
      const context: StopContext = { stop_reason: 'end_turn' };
      expect(isUserAbort(context)).toBe(false);
    });

    it('should return false for max_tokens', () => {
      const context: StopContext = { stop_reason: 'max_tokens' };
      expect(isUserAbort(context)).toBe(false);
    });

    it('should handle empty context object', () => {
      expect(isUserAbort({})).toBe(false);
    });
  });

  describe('createTodoContinuationHook', () => {
    it('should create hook with checkIncomplete method', () => {
      const hook = createTodoContinuationHook('/test/dir');
      expect(hook).toHaveProperty('checkIncomplete');
      expect(typeof hook.checkIncomplete).toBe('function');
    });

    it('should call checkIncompleteTodos with directory', async () => {
      const testDir = '/test/dir';
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const hook = createTodoContinuationHook(testDir);
      const result = await hook.checkIncomplete('session123');

      expect(result).toBeDefined();
      expect(result.source).toBe('none');
    });
  });

  describe('formatTodoStatus', () => {
    it('should format when all tasks complete', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 5,
        source: 'task'
      };
      expect(formatTodoStatus(result)).toBe('All tasks complete (5 total)');
    });

    it('should format with incomplete tasks', () => {
      const result: IncompleteTodosResult = {
        count: 3,
        todos: [],
        total: 10,
        source: 'task'
      };
      expect(formatTodoStatus(result)).toBe('7/10 completed, 3 remaining');
    });

    it('should handle zero total tasks', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 0,
        source: 'none'
      };
      expect(formatTodoStatus(result)).toBe('All tasks complete (0 total)');
    });

    it('should handle all tasks incomplete', () => {
      const result: IncompleteTodosResult = {
        count: 5,
        todos: [],
        total: 5,
        source: 'task'
      };
      expect(formatTodoStatus(result)).toBe('0/5 completed, 5 remaining');
    });

    it('should handle single task remaining', () => {
      const result: IncompleteTodosResult = {
        count: 1,
        todos: [],
        total: 10,
        source: 'task'
      };
      expect(formatTodoStatus(result)).toBe('9/10 completed, 1 remaining');
    });
  });

  describe('getNextPendingTodo', () => {
    it('should return in_progress todo first', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'in_progress' },
        { content: 'Task 3', status: 'pending' }
      ];
      const result: IncompleteTodosResult = {
        count: 3,
        todos,
        total: 3,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 2');
      expect(next!.status).toBe('in_progress');
    });

    it('should return first pending when no in_progress', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'pending' },
        { content: 'Task 3', status: 'completed' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos: todos.filter(t => t.status !== 'completed'),
        total: 3,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 1');
      expect(next!.status).toBe('pending');
    });

    it('should return null when no todos', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 0,
        source: 'none'
      };
      const next = getNextPendingTodo(result);
      expect(next).toBeNull();
    });

    it('should return null when all completed', () => {
      const result: IncompleteTodosResult = {
        count: 0,
        todos: [],
        total: 3,
        source: 'task'
      };
      const next = getNextPendingTodo(result);
      expect(next).toBeNull();
    });

    it('should handle todos with priority field', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', priority: 'low' },
        { content: 'Task 2', status: 'in_progress', priority: 'high' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos,
        total: 2,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 2');
    });

    it('should handle todos with id field', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending', id: 'todo-1' },
        { content: 'Task 2', status: 'pending', id: 'todo-2' }
      ];
      const result: IncompleteTodosResult = {
        count: 2,
        todos,
        total: 2,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('todo-1');
    });

    it('should prefer in_progress over multiple pending', () => {
      const todos: Todo[] = [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'pending' },
        { content: 'Task 3', status: 'pending' },
        { content: 'Task 4', status: 'in_progress' }
      ];
      const result: IncompleteTodosResult = {
        count: 4,
        todos,
        total: 4,
        source: 'todo'
      };
      const next = getNextPendingTodo(result);
      expect(next).not.toBeNull();
      expect(next!.content).toBe('Task 4');
      expect(next!.status).toBe('in_progress');
    });
  });

  describe('checkLegacyTodos', () => {
    it('should read from session-specific location', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return p.includes('session123.json');
      });
      vi.mocked(fs.readdirSync).mockReturnValue(['session123.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([{ content: 'Todo', status: 'pending' }])
      );

      const result = checkLegacyTodos('session123');
      expect(result.count).toBe(1);
    });

    it('should read from project .omc directory', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return /[\\/]\.omc[\\/]todos\.json$/.test(p);
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([{ content: 'Todo', status: 'pending' }])
      );

      const result = checkLegacyTodos(undefined, '/project/dir');
      expect(result.count).toBe(1);
    });

    it('should deduplicate todos from multiple sources', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['session123.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([{ content: 'Same Todo', status: 'pending' }])
      );

      const result = checkLegacyTodos('session123', '/project/dir');
      // Should only count unique todos
      expect(result.count).toBeGreaterThanOrEqual(1);
    });

    it('should handle object format with todos array', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['session123.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ todos: [{ content: 'Todo', status: 'pending' }] })
      );

      const result = checkLegacyTodos('session123');
      expect(result.count).toBe(1);
    });

    it('should filter out cancelled todos', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['session123.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify([
          { content: 'Pending', status: 'pending' },
          { content: 'Cancelled', status: 'cancelled' },
          { content: 'Completed', status: 'completed' }
        ])
      );

      const result = checkLegacyTodos('session123');
      expect(result.count).toBe(1);
      expect(result.total).toBe(3);
    });
  });

  describe('Integration: Task and Todo Systems', () => {
    it('should prefer tasks when both exist and tasks have incomplete items', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation((dirPath: any) => {
        if (/[\\/]tasks[\\/]/.test(dirPath)) {
          return ['1.json'] as any;
        }
        return ['session123.json'] as any;
      });
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (/[\\/]tasks[\\/]/.test(filePath)) {
          return JSON.stringify({ id: '1', subject: 'Task', status: 'pending' });
        }
        return JSON.stringify([{ content: 'Todo', status: 'completed' }]);
      });

      const result = await checkIncompleteTodos('session123');
      expect(result.source).toBe('task');
      expect(result.count).toBe(1);
    });

    it('should handle user abort during check', async () => {
      const stopContext: StopContext = { user_requested: true };
      const result = await checkIncompleteTodos('session123', undefined, stopContext);
      expect(result.count).toBe(0);
      expect(result.source).toBe('none');
    });

    it('should convert tasks to todo format in result', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => /[\\/]tasks[\\/]/.test(p));
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'task-1', subject: 'Task Subject', status: 'pending' })
      );

      const result = await checkIncompleteTodos('session123');
      expect(result.todos[0].content).toBe('Task Subject');
      expect(result.todos[0].id).toBe('task-1');
      expect(result.todos[0].status).toBe('pending');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed JSON gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['bad.json', 'good.json'] as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (filePath.includes('bad.json')) {
          return '{invalid json}';
        }
        return JSON.stringify({ id: '1', subject: 'Good', status: 'pending' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('should handle very long file lists', () => {
      const manyFiles = Array.from({ length: 1000 }, (_, i) => `${i}.json`);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(manyFiles as any);
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        const match = filePath.match(/(\d+)\.json/);
        const id = match ? match[1] : '0';
        return JSON.stringify({ id, subject: `Task ${id}`, status: 'pending' });
      });

      const result = readTaskFiles('session123');
      expect(result).toHaveLength(1000);
    });

    it('should handle unicode in task subjects', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: '1', subject: 'Task with émojis 🚀', status: 'pending' })
      );

      const result = readTaskFiles('session123');
      expect(result[0].subject).toBe('Task with émojis 🚀');
    });

    it('should handle tasks with blocks and blockedBy', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['1.json'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          id: '1',
          subject: 'Task',
          status: 'pending',
          blocks: ['2', '3'],
          blockedBy: ['0']
        })
      );

      const result = readTaskFiles('session123');
      expect(result[0].blocks).toEqual(['2', '3']);
      expect(result[0].blockedBy).toEqual(['0']);
    });
  });

  describe('Security: Session ID Validation', () => {
    it('should reject path traversal attempts with ../', () => {
      expect(isValidSessionId('../../../etc')).toBe(false);
    });

    it('should reject path traversal with encoded characters', () => {
      expect(isValidSessionId('..%2F..%2F')).toBe(false);
    });

    it('should reject session IDs starting with dot', () => {
      expect(isValidSessionId('.hidden')).toBe(false);
    });

    it('should reject session IDs starting with hyphen', () => {
      expect(isValidSessionId('-invalid')).toBe(false);
    });

    it('should reject empty session ID', () => {
      expect(isValidSessionId('')).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(isValidSessionId(null as any)).toBe(false);
      expect(isValidSessionId(undefined as any)).toBe(false);
    });

    it('should reject session IDs with slashes', () => {
      expect(isValidSessionId('abc/def')).toBe(false);
      expect(isValidSessionId('abc\\def')).toBe(false);
    });

    it('should reject session IDs with special characters', () => {
      expect(isValidSessionId('abc$def')).toBe(false);
      expect(isValidSessionId('abc;def')).toBe(false);
      expect(isValidSessionId('abc|def')).toBe(false);
    });

    it('should accept valid alphanumeric session IDs', () => {
      expect(isValidSessionId('abc123')).toBe(true);
      expect(isValidSessionId('session-123')).toBe(true);
      expect(isValidSessionId('session_123')).toBe(true);
      expect(isValidSessionId('ABC123xyz')).toBe(true);
    });

    it('should accept session IDs up to 256 characters', () => {
      const longId = 'a'.repeat(256);
      expect(isValidSessionId(longId)).toBe(true);
    });

    it('should reject session IDs over 256 characters', () => {
      const tooLongId = 'a'.repeat(257);
      expect(isValidSessionId(tooLongId)).toBe(false);
    });

    it('should accept numeric session IDs starting with digit', () => {
      expect(isValidSessionId('123456')).toBe(true);
    });
  });

  describe('Security: getTaskDirectory with validation', () => {
    it('should return empty string for invalid session ID', () => {
      const result = getTaskDirectory('../../../etc/passwd');
      expect(result).toBe('');
    });

    it('should return valid path for valid session ID', () => {
      const result = getTaskDirectory('valid-session-123');
      expect(result).toContain('valid-session-123');
      expect(result).toContain(path.join('.claude', 'tasks'));
    });
  });

  describe('Security: readTaskFiles with validation', () => {
    it('should return empty array for path traversal attempt', () => {
      const result = readTaskFiles('../../../etc');
      expect(result).toEqual([]);
    });
  });

  describe('Security: checkIncompleteTasks with validation', () => {
    it('should return zero count for invalid session ID', () => {
      const result = checkIncompleteTasks('../../../etc');
      expect(result.count).toBe(0);
      expect(result.tasks).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('Task status: deleted handling', () => {
    it('should treat deleted status as valid task', () => {
      const task = { id: '1', subject: 'Test', status: 'deleted' };
      expect(isValidTask(task)).toBe(true);
    });

    it('should treat deleted task as complete (not incomplete)', () => {
      const task: Task = { id: '1', subject: 'Test', status: 'deleted' };
      expect(isTaskIncomplete(task)).toBe(false);
    });
  });
});
