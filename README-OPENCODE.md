# OpenCode Viewer

cc-viewer 的 OpenCode 兼容版本，用于实时监控 OpenCode 的 API 请求和 Token 使用统计。

## 安装

```bash
cd ~/Project/cc-viewer
bun install
```

## 使用方法

### 启动监控服务

```bash
bun ocv.js
# 或者
node ocv.js
```

服务将在 http://127.0.0.1:7010 启动。

### 安装 OpenCode 插件（可选，用于实时推送）

将 `contrib/oc-viewer-plugin.js` 复制到 `~/.opencode/plugin/` 目录：

```bash
mkdir -p ~/.opencode/plugin
cp contrib/oc-viewer-plugin.js ~/.opencode/plugin/
```

然后在 `~/.opencode/opencode.jsonc` 中添加插件配置：

```json
{
  "plugins": ["file://$HOME/.opencode/plugin/oc-viewer-plugin.js"]
}
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | GET | 获取活跃会话列表 |
| `/api/session` | GET/POST | 获取/切换当前监控会话 |
| `/api/requests` | GET | 获取请求列表 |
| `/api/token-stats` | GET | 获取 Token 统计 |
| `/api/projects` | GET | 获取项目列表 |
| `/api/messages/{sessionId}` | GET | 获取指定会话的消息 |
| `/events` | GET | SSE 实时事件流 |
| `/api/plugin-event` | POST | 插件事件推送 |

## 数据源

数据读取自 OpenCode 的存储目录：

- 消息存储：`~/.local/share/opencode/storage/message/`
- Part 存储：`~/.local/share/opencode/storage/part/`
- 数据库：`~/.local/share/opencode/opencode.db`

## 与 cc-viewer 的差异

| 功能 | cc-viewer | OpenCode Viewer |
|------|-----------|-----------------|
| 数据来源 | fetch 拦截 | 文件监听 + SQLite |
| 实时性 | 即时 | 文件更新时 |
| API 请求详情 | 完整原始数据 | 消息元数据 |
| Token 统计 | ✓ | ✓ |
| 会话管理 | ✓ | ✓ |

## 开发

```bash
# 运行开发服务器
bun run dev

# 构建
bun run build
```