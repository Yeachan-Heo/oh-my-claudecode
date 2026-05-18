import { describe, expect, it, vi } from 'vitest';

describe('Vue LSP catalog entry', () => {
  it('lists Vue/Volar as not installed when vue-language-server is absent', async () => {
    vi.resetModules();
    vi.doMock('child_process', () => ({
      spawnSync: vi.fn(() => ({ status: 1 }))
    }));

    const { getAllServers } = await import('../tools/lsp/servers.js');
    const { lspServersTool } = await import('../tools/lsp-tools.js');
    const vueServer = getAllServers().find(server => server.command === 'vue-language-server');

    expect(vueServer).toMatchObject({
      name: 'Vue Language Server (Volar)',
      command: 'vue-language-server',
      args: ['--stdio'],
      extensions: ['.vue'],
      installHint: 'npm install -g @vue/language-server',
      installed: false
    });

    const rendered = await lspServersTool.handler({});
    const text = rendered.content[0].text;
    expect(text).toContain('### Not Installed:');
    expect(text).toContain('- Vue Language Server (Volar) (vue-language-server)');
    expect(text).toContain('Extensions: .vue');
    expect(text).toContain('Install: npm install -g @vue/language-server');
  });
});
