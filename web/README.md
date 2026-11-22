# mcp-relay 控制台

Vite + TypeScript 单页控制台，使用 Proto UI **0.3.0-alpha.1** 的 **Web Components** 适配器和
shadcn 原型（button / dialog / tabs / switch）。布局、表格与输入使用原生语义 HTML 加
shadcn 设计令牌。

## 开发

```bash
npm ci
npm run dev
```

开发服务器默认把资源挂在 `/app/` 下，API 请求同源发送到 `/api/*`。

## 构建

```bash
npm run build
```

产物在 `web/dist`，`index.html` 引用相对路径的 `/app/assets/*` 哈希资源；无 CDN 依赖。
构建前重新生成 Proto UI 组件索引时使用：

```bash
npx @proto.ui/cli@0.3.0-alpha.1 add wc shadcn-button --no-interactive
```

## 结构

- `proto-ui/`：CLI 生成的 Web Components 注册代码（勿手改）。
- `src/styles/proto-ui-style.css`：CLI 生成的 shadcn 主题与 token 工具类入口。
- `src/styles/app.css`：控制台布局；按 shadcn/ui **Rhea** 风格使用紧凑尺寸与 `1rem` 控件圆角。
- `src/api.ts`：同源 API 客户端（cookie 会话、`X-CSRF-Token`）。
- `src/dashboard.ts`：设备、配对码、撤销、审计、邀请码界面。

Proto UI `0.3.0-alpha.1` 没有 `styleProfile` / Rhea 预置 API，因此页面在
`<html data-style-profile="rhea">` 上声明样式档位，并在 `app.css` 中按 shadcn Rhea 的公开
密度与圆角数值覆盖 `proto-ui-shadcn-*` 宿主元素；组件与 token 仍来自官方 shadcn 原型。
