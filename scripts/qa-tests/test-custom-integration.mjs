#!/usr/bin/env node
/**
 * QA Test: Custom Integration System
 * 
 * Run with: node scripts/qa-tests/test-custom-integration.mjs
 * 
 * Tests the actual dispatch code with real HTTP requests
 * to verify webhook and CLI integrations work end-to-end.
 */

import http from 'http';
import { sendCustomWebhook, sendCustomCli } from '../../dist/notifications/dispatcher.js';

const PORT = 3458;
let receivedRequest = null;

// Create test server
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    receivedRequest = { method: req.method, headers: req.headers, body };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
});

async function runTests() {
  return new Promise((resolve) => {
    server.listen(PORT, async () => {
      console.log('🧪 QA Test: Custom Integration System\n');
      let passed = 0;
      let failed = 0;
      
      const testPayload = {
        event: 'session-end',
        sessionId: 'qa-test-session',
        projectName: 'qa-test-project',
        projectPath: '/home/test/project',
        timestamp: new Date().toISOString(),
        durationMs: 45000,
        agentsSpawned: 3,
        agentsCompleted: 3,
        reason: 'completed',
        message: 'QA test message'
      };

      // Test 1: Webhook dispatch with template interpolation
      console.log('Test 1: Webhook dispatch with template interpolation');
      receivedRequest = null;
      const webhookIntegration = {
        id: 'qa-webhook',
        type: 'webhook',
        enabled: true,
        config: {
          url: `http://localhost:${PORT}/webhook`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          bodyTemplate: JSON.stringify({
            event: '{{event}}',
            sessionId: '{{sessionId}}',
            projectName: '{{projectName}}',
            timestamp: '{{timestamp}}'
          }),
          timeout: 5000
        },
        events: ['session-end']
      };

      const webhookResult = await sendCustomWebhook(webhookIntegration, testPayload);
      if (webhookResult.success && receivedRequest) {
        try {
          const body = JSON.parse(receivedRequest.body);
          if (body.event === 'session-end' && body.sessionId === 'qa-test-session') {
            console.log('  ✅ PASS - Template interpolation working');
            passed++;
          } else {
            console.log('  ❌ FAIL - Template values incorrect');
            failed++;
          }
        } catch {
          console.log('  ❌ FAIL - Could not parse body');
          failed++;
        }
      } else {
        console.log('  ❌ FAIL - Request failed:', webhookResult.error);
        failed++;
      }

      // Test 2: CLI dispatch with echo
      console.log('\nTest 2: CLI command execution');
      const cliIntegration = {
        id: 'qa-cli',
        type: 'cli',
        enabled: true,
        config: {
          command: 'echo',
          args: ['Event={{event}}', 'Project={{projectName}}'],
          timeout: 5000
        },
        events: ['session-end']
      };

      const cliResult = await sendCustomCli(cliIntegration, testPayload);
      if (cliResult.success) {
        console.log('  ✅ PASS - CLI command executed');
        passed++;
      } else {
        console.log('  ❌ FAIL - CLI error:', cliResult.error);
        failed++;
      }

      // Test 3: Webhook with custom headers
      console.log('\nTest 3: Webhook with custom headers');
      receivedRequest = null;
      const headerIntegration = {
        ...webhookIntegration,
        config: {
          ...webhookIntegration.config,
          headers: {
            'Content-Type': 'application/json',
            'X-Custom-Header': 'test-value',
            'Authorization': 'Bearer test-token'
          }
        }
      };

      const headerResult = await sendCustomWebhook(headerIntegration, testPayload);
      if (headerResult.success && receivedRequest?.headers['x-custom-header'] === 'test-value') {
        console.log('  ✅ PASS - Custom headers working');
        passed++;
      } else {
        console.log('  ❌ FAIL - Headers not received correctly');
        failed++;
      }

      console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
      server.close();
      resolve(failed === 0);
    });
  });
}

runTests().then((success) => process.exit(success ? 0 : 1));
