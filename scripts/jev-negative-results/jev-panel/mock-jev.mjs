// A local stand-in for the Jev API: an HTTP server that records the request bodies and answers every question from a table
// (a yes/no question gets { noul }, a choice question gets { choice, confidence }). Answers come back in reverse question order so a
// reader that takes answers by position instead of by question name is caught. No network access, no key.
import { createServer } from 'node:http';

export function answerFor(body, table = {}) {
  const answers = {};
  for (const name of Object.keys(body?.questions ?? {}).reverse()) {
    const question = body.questions[name];
    const given = table[name];
    if (question.type === 'choice') {
      const choice = given?.choice ?? Object.keys(question.criteria ?? {})[0];
      answers[name] = { type: 'choice', choice, confidence: given?.confidence ?? 0.9 };
    } else {
      answers[name] = { type: 'noul', noul: given?.noul ?? 0.1 };
    }
  }
  return { answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

export async function startMock() {
  const received = [];
  let table = {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* stays null */ }
      received.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answerFor(body, table)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    answer(next) { table = next; },
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
