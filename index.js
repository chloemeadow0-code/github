import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN is required');
  process.exit(1);
}

// ═══════════════════════════════════════
//  GitHub API
// ═══════════════════════════════════════

async function gh(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

function owner(o) {
  const resolved = o || GITHUB_OWNER;
  if (!resolved) throw new Error('owner 未指定，请设置 GITHUB_OWNER 环境变量或传入 owner 参数');
  return resolved;
}

// ═══════════════════════════════════════
//  MCP Server 工厂
// ═══════════════════════════════════════

function createServer() {
  const server = new McpServer({
    name: 'github-mcp',
    version: '1.0.0',
  });

  // ─── create_repo ───
  server.tool(
    'create_repo',
    '创建 GitHub 仓库',
    {
      name: z.string().describe('仓库名'),
      description: z.string().optional().describe('仓库描述'),
      is_private: z.boolean().optional().describe('是否私有，默认 true'),
    },
    async ({ name, description, is_private }) => {
      const repo = await gh('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || '',
          private: is_private ?? true,
          auto_init: true,
        }),
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            full_name: repo.full_name,
            url: repo.html_url,
            clone_url: repo.clone_url,
            private: repo.private,
          }, null, 2),
        }],
      };
    }
  );

  // ─── list_repos ───
  server.tool(
    'list_repos',
    '列出你的 GitHub 仓库',
    {
      per_page: z.number().optional().describe('每页数量，默认 30'),
      page: z.number().optional().describe('页码，默认 1'),
    },
    async ({ per_page, page }) => {
      const repos = await gh(`/user/repos?sort=updated&per_page=${per_page || 30}&page=${page || 1}`);
      const list = repos.map((r) => ({
        name: r.full_name,
        private: r.private,
        url: r.html_url,
        updated: r.updated_at,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  // ─── push_files ───
  server.tool(
    'push_files',
    '批量推送文件到仓库（单次 commit，可创建或更新文件）',
    {
      owner: z.string().optional().describe('仓库所有者，默认用 GITHUB_OWNER'),
      repo: z.string().describe('仓库名'),
      branch: z.string().optional().describe('分支名，默认 main'),
      message: z.string().describe('commit 信息'),
      files: z.array(z.object({
        path: z.string().describe('文件路径，如 src/index.js'),
        content: z.string().describe('文件内容'),
      })).describe('要推送的文件列表'),
    },
    async ({ owner: o, repo, branch, message, files }) => {
      const own = owner(o);
      const br = branch || 'main';

      // 1) 获取当前 ref
      const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
      const latestCommitSha = ref.object.sha;

      // 2) 获取当前 commit 的 tree
      const latestCommit = await gh(`/repos/${own}/${repo}/git/commits/${latestCommitSha}`);
      const baseTreeSha = latestCommit.tree.sha;
      // 3) 为每个文件创建 blob
      const treeItems = [];
      for (const file of files) {
        const blob = await gh(`/repos/${own}/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        });
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      }

      // 4) 创建新 tree
      const newTree = await gh(`/repos/${own}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
      });

      // 5) 创建 commit
      const newCommit = await gh(`/repos/${own}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: newTree.sha,
          parents: [latestCommitSha],
        }),
      });

      // 6) 更新 ref
      await gh(`/repos/${own}/${repo}/git/refs/heads/${br}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha }),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            commit: newCommit.sha,
            message: newCommit.message,
            files_pushed: files.map((f) => f.path),
            url: `https://github.com/${own}/${repo}/commit/${newCommit.sha}`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── get_file ───
  server.tool(
    'get_file',
    '读取仓库中某个文件的内容',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      path: z.string().describe('文件路径'),
      branch: z.string().optional().describe('分支名，默认 main'),
    },
    async ({ owner: o, repo, path, branch }) => {
      const own = owner(o);
      const file = await gh(`/repos/${own}/${repo}/contents/${path}?ref=${branch || 'main'}`);
      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      return { content: [{ type: 'text', text: content }] };
    }
  );

  // ─── list_files ───
  server.tool(
    'list_files',
    '列出仓库目录结构（支持递归）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      path: z.string().optional().describe('目录路径，默认根目录'),
      branch: z.string().optional().describe('分支名，默认 main'),
      recursive: z.boolean().optional().describe('是否递归列出所有文件，默认 false'),
    },
    async ({ owner: o, repo, path, branch, recursive }) => {
      const own = owner(o);
      const br = branch || 'main';

      // 递归模式：用 git trees API
      if (recursive) {
        const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
        const commitSha = ref.object.sha;
        const commit = await gh(`/repos/${own}/${repo}/git/commits/${commitSha}`);
        const tree = await gh(`/repos/${own}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
        const items = tree.tree
          .filter((t) => t.type === 'blob')
          .map((t) => ({ path: t.path, size: t.size }));
        return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
      }

      // 普通模式：用 contents API
      const p = path ? `/repos/${own}/${repo}/contents/${path}?ref=${br}` : `/repos/${own}/${repo}/contents?ref=${br}`;
      const items = await gh(p);
      if (Array.isArray(items)) {
        const list = items.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ name: items.name, path: items.path, type: items.type, size: items.size }, null, 2),
        }],
      };
    }
  );

  // ─── delete_files ───
  server.tool(
    'delete_files',
    '从仓库中删除文件（单次 commit）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      branch: z.string().optional().describe('分支名，默认 main'),
      message: z.string().describe('commit 信息'),
      paths: z.array(z.string()).describe('要删除的文件路径列表'),
    },
    async ({ owner: o, repo, branch, message, paths }) => {
      const own = owner(o);
      const br = branch || 'main';

      const ref = await gh(`/repos/${own}/${repo}/git/ref/heads/${br}`);
      const latestCommitSha = ref.object.sha;
      const latestCommit = await gh(`/repos/${own}/${repo}/git/commits/${latestCommitSha}`);

      const treeItems = paths.map((p) => ({
        path: p,
        mode: '100644',
        type: 'blob',
        sha: null,
      }));

      const newTree = await gh(`/repos/${own}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: latestCommit.tree.sha, tree: treeItems }),
      });

      const newCommit = await gh(`/repos/${own}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: newTree.sha,
          parents: [latestCommitSha],
        }),
      });

      await gh(`/repos/${own}/${repo}/git/refs/heads/${br}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha }),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            commit: newCommit.sha,
            deleted: paths,
            url: `https://github.com/${own}/${repo}/commit/${newCommit.sha}`,
          }, null, 2),
        }],
      };
    }
  );

  // ─── delete_repo ───
  server.tool(
    'delete_repo',
    '删除 GitHub 仓库（需要确认仓库名）',
    {
      owner: z.string().optional().describe('仓库所有者'),
      repo: z.string().describe('仓库名'),
      confirm: z.string().describe('再次输入仓库名以确认删除'),
    },
    async ({ owner: o, repo, confirm }) => {
      if (confirm !== repo) {
        return { content: [{ type: 'text', text: '❌ 确认名称不匹配，已取消删除' }] };
      }
      const own = owner(o);
      await gh(`/repos/${own}/${repo}`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: `✅ 已删除仓库 ${own}/${repo}` }] };
    }
  );

  return server;
}

// ═══════════════════════════════════════
//  Express + Transport
// ═══════════════════════════════════════

const app = express();
app.use(express.json());

// ─── Streamable HTTP (推荐，/mcp) ───

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (req, res) => res.status(405).end());
app.delete('/mcp', (req, res) => res.status(405).end());

// ─── SSE fallback (/sse + /messages) ───

const sseSessions = new Map();

app.get('/sse', async (req, res) => {
  try {
    const server = createServer();
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, { transport, server });

    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
      server.close();
    });

    await server.connect(transport);
  } catch (err) {
    console.error('SSE connection error:', err);
    if (!res.headersSent) res.status(500).end();
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sseSessions.get(sessionId);
  if (session) {
    await session.transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'Unknown session' });
  }
});

// ─── Health check ───

app.get('/health', (req, res) => res.json({ status: 'ok', owner: GITHUB_OWNER }));

// ─── Start ───

app.listen(PORT, () => {
  console.log(`✅ GitHub MCP Server running on port ${PORT}`);
  console.log(`   Streamable HTTP: /mcp`);
  console.log(`   SSE fallback:    /sse`);
  console.log(`   Owner:           ${GITHUB_OWNER || '(not set, must pass in tool calls)'}`);
});