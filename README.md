# SubConvert - 代理订阅转换

自托管的代理节点订阅转换工具，部署在 Cloudflare Pages 上。所有转换逻辑在 Cloudflare 边缘节点本地执行，**不依赖任何第三方转换服务**，确保订阅信息零泄漏。

## 功能特性

- 🔒 **零泄漏** — 转换逻辑完全本地执行，不调用任何第三方 API
- ⚡ **实时转换** — 每次访问订阅链接都拉取最新源订阅并即时转换
- 📦 **多格式支持** — Clash/Mihomo、Sing-Box、V2Ray Base64、纯文本互转
- 🌐 **全协议覆盖** — SS、VMess、VLESS、Trojan、Hysteria2、TUIC、AnyTLS
- 🔗 **自定义路径** — 可自定义输出 URL 的 path，如 `/sub/my-sub`
- 📋 **链接管理** — 查看所有已生成的转换链接，支持复制和删除
- 🚀 **一键部署** — 基于 Cloudflare Pages + KV，零服务器成本

## 支持的格式

### 输入格式（自动检测）

- Base64 编码的订阅链接（V2Ray 格式）
- Clash / Mihomo YAML 配置
- Sing-Box JSON 配置
- 纯文本 URI 列表（每行一个节点）

### 输出格式

| 格式        | 说明                                             |
| --------- | ---------------------------------------------- |
| `clash`   | Clash / Mihomo YAML 配置（含 proxy-groups 和 rules） |
| `singbox` | Sing-Box JSON 配置（含 route 和 dns）                |
| `base64`  | V2Ray Base64 编码的 URI 列表                        |
| `plain`   | 纯文本 URI 列表                                     |

### 支持的代理协议

- Shadowsocks (`ss://`)
- VMess (`vmess://`)
- VLESS (`vless://`)
- Trojan (`trojan://`)
- Hysteria2 (`hysteria2://` / `hy2://`)
- TUIC (`tuic://`)
- AnyTLS (`anytls://`)

## 部署

本项目基于 Cloudflare Pages + KV，**零构建依赖**（js-yaml 已内联），两种部署方式任选其一。

> **关于 KV 绑定（重要）**：KV 命名空间绑定变量名固定为 `SUBCONVERT_KV`。本项目提供两种绑定方式，任选其一、**不要混用**：
> - **方式一（推荐，文件化，一次成功）**：使用仓库附带的 `wrangler.toml.example` 模板，填入你自己的 KV ID 后重命名成 `wrangler.toml`。Cloudflare 会把该文件当作配置真源，KV 绑定随之自动生效，无需在 Dashboard 手动绑定。`wrangler.toml` 已被 `.gitignore` 忽略，不会进公开仓库，KV ID 不会泄露。
> - **方式二（Dashboard 手动）**：不提交 `wrangler.toml`，改在 Cloudflare Dashboard 的绑定界面手动添加 `SUBCONVERT_KV`。
>
> ⚠️ **两种方式的取舍**：**一旦仓库里存在 `wrangler.toml`，Cloudflare 就会把它当作项目配置的 source of truth，Dashboard 的绑定界面会变为只读**（提示「此项目的绑定在通过 wrangler.toml 进行管理」）。这并非 bug，而是有意为之——方式一正是利用这一点让绑定随 `git push` 自动更新；方式二则反过来，靠「仓库里无 wrangler.toml」来保持 Dashboard 可编辑。**务必二选一，不要混用**，否则会出现绑定被文件锁死、或部署缺绑定的问题。

### 前置要求

- 一个 Cloudflare 账号
- （仅本地开发需要）[Node.js](https://nodejs.org/) 18+

### 方式一：通过 GitHub 导入 + wrangler.toml（文件化配置，推荐 ✅ 一次成功）

1. 在 Cloudflare Dashboard 左侧 **KV** → **Create a namespace** 创建一个 KV 命名空间（名字随意，如 `subconvert-kv`），记下它生成的 **ID**。
2. 把仓库根目录的 **`wrangler.toml.example`** 重命名 / 复制为 **`wrangler.toml`**，并将其中的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 替换成第 1 步的 KV ID。
3. 提交这次改动（本地提交即可；`wrangler.toml` 已被 `.gitignore` 忽略，不会推到公开仓库，KV ID 不会泄露）。
4. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选择你的仓库，构建设置：
   - **Framework preset**：`None`
   - **Build command**：留空（无需构建，依赖已内联）
   - **Build output directory**：`public`
5. 点击 **Save and Deploy**。wrangler.toml 会被当作配置真源，其中的 KV 绑定自动生效，首次部署即可直接使用。
6. （可选）设置访问密码，见下方「访问密码保护」一节。

> 之后修改绑定 / 配置只需编辑 `wrangler.toml` 再 `git push`，Cloudflare 会自动重新部署并应用新配置。Dashboard 的绑定界面此时为只读，属预期行为。

部署完成后访问你的 `*.pages.dev` 地址即可使用。

### 方式二：通过 GitHub 导入 + Dashboard 手动绑定 KV

> 适用于不想在仓库里保留 `wrangler.toml`、希望绑定在 Dashboard 里可随时编辑的场景。

1. 确保仓库根目录**没有** `wrangler.toml`（本仓库默认即如此）。
2. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选择你的仓库，构建设置：
   - **Framework preset**：`None`
   - **Build command**：留空（无需构建，依赖已内联）
   - **Build output directory**：`public`
3. 点击 **Save and Deploy**，等待首次部署完成。
4. 创建 KV 命名空间：Dashboard 左侧 **KV** → **Create a namespace**，名字随意（如 `subconvert-kv`），记下它的 **ID**。
5. 绑定 KV：进入你的 Pages 项目 → **Settings** → **Functions** → **KV namespace bindings** → **Add binding**：
   - Variable name：`SUBCONVERT_KV`
   - KV namespace：选择上一步创建的命名空间
6. 回到项目 **Deployments** 标签，点击最新一次部署的 **Redeploy** 使绑定生效。
7. （可选）设置访问密码，见下方「访问密码保护」一节。

### 方式三：通过 Wrangler CLI 直接上传（不推荐）

> ⚠️ 直接 `wrangler pages deploy` 上传时，绑定同样依赖 `wrangler.toml`：没有它就没有 KV 绑定（API 全 500），有它又会锁 Dashboard。若坚持，请先按方式一准备好 `wrangler.toml`（含你的 KV ID）后再执行：

```bash
npm install      # 仅本地需要
npx wrangler login
npm run deploy   # wrangler pages deploy public（依赖 wrangler.toml 中的 KV 绑定）
```

> 此方式无法靠 `git push` 自动更新，且 `wrangler.toml` 含你的 KV ID，须自行保管、勿误提交到公开仓库。

### 本地开发

```bash
npm run dev
```

访问 `http://localhost:8788`。`dev.js` 会自动清除代理环境变量，并以命令行参数 `wrangler pages dev public --kv SUBCONVERT_KV` 绑定一个本地 KV 实例——**本仓库不含 `wrangler.toml`，本地开发完全不依赖它，也无需创建线上 KV**。

## 访问密码保护（可选）

为了防止他人随意访问你的首页并管理/删除转换链接，你可以配置首页访问密码：

1. 在 Cloudflare Dashboard 中进入 **Workers & Pages** → 你的 `subconvert` 项目 → **Settings** → **Environment variables**。
2. 添加环境变量：
   - 变量名：`ACCESS_PASSWORD`
   - 变量值：`你的自定义密码`
3. 保存并重新部署项目。

> **说明**：
> - 未设置 `ACCESS_PASSWORD` 时，首页保持公开访问。
> - **密码仅限制访问和管理网页首页**；网页生成的转换链接（如 `/sub/my-sub`）完全免密且公开可访问，以便各类代理客户端订阅更新。
> - 本地开发调试时，可在根目录创建 `.dev.vars` 文件并写入 `ACCESS_PASSWORD=你的密码`。


## 使用方法

1. 打开网站首页
2. 填写源订阅 URL
3. 选择目标格式（Clash / Sing-Box / V2Ray / Plain Text）
4. 可选：填写自定义路径（同时作为备注标识，留空则自动生成）
5. 点击「生成转换链接」
6. 复制生成的订阅链接，导入到你的代理客户端

在「转换链接管理」区域可以：

- 查看所有已生成的链接
- 复制订阅链接
- 在新标签页预览
- 删除不需要的链接
- 查看访问次数

## 项目结构

```
subconvert/
├── functions/                  # Cloudflare Pages Functions (后端)
│   ├── _lib/                   # 共享库（下划线前缀，不作为路由）
│   │   ├── utils.js            # 工具函数（base64, URL解析等）
│   │   ├── uri-parse.js        # 代理协议 URI 解析器
│   │   ├── uri-generate.js     # 代理协议 URI 生成器
│   │   ├── sub-parse.js        # 订阅内容解析（自动检测格式）
│   │   ├── sub-generate.js     # 订阅内容生成
│   │   ├── store.js            # KV 存储操作
│   │   ├── convert.js          # 转换管道
│   │   ├── response.js         # HTTP 响应辅助
│   │   └── vendor/
│   │       └── js-yaml.mjs     # js-yaml v4.3.1 内联（MIT，无需 npm install）
│   ├── api/
│   │   ├── convert.js          # POST /api/convert — 创建转换
│   │   └── links.js            # GET/DELETE /api/links — 管理链接
│   └── sub/
│       └── [path].js           # GET /sub/:path — 订阅输出端点
├── public/                     # 静态前端
│   ├── index.html
│   ├── style.css
│   └── app.js
├── package.json
├── deploy.js                   # 部署脚本（清除代理环境变量；本项目不推荐使用）
├── dev.js                      # 本地开发启动脚本（清除代理环境变量，CLI 传入 KV 绑定）
├── .gitignore                  # 已忽略 wrangler.toml（其存在会锁死 Dashboard KV 绑定）
├── wrangler.toml.example       # Cloudflare Pages 配置模板（重命名填入 KV ID 后即 wrangler.toml）
├── LICENSE
└── README.md
```

## API 文档

### 创建转换链接

```
POST /api/convert
Content-Type: application/json

{
  "sourceUrl": "https://example.com/subscribe/...",
  "targetFormat": "clash",
  "customPath": "my-sub"          // 可选，同时作为备注标识
}
```

### 列出所有链接

```
GET /api/links
```

### 删除链接

```
DELETE /api/links?path=my-sub
```

### 获取转换后的订阅

```
GET /sub/:path
```

## 安全说明

- 所有订阅转换逻辑在 Cloudflare 边缘节点本地执行
- **不调用任何第三方转换 API**，订阅数据不会发送到外部服务
- 源订阅 URL 仅存储在你自己的 Cloudflare KV 中
- 建议为自定义路径使用不易猜到的字符串

## 常见问题

### 本地开发服务器页面空白/一直转圈

如果你使用了代理软件（Clash、v2ray 等），`HTTPS_PROXY` 环境变量会干扰 wrangler 4 的 ProxyWorker 内部转发，导致页面无法加载。

`npm run dev` 使用 `dev.js` 脚本启动，会自动在 Node.js 层面清除代理环境变量。如果仍有问题，可能是代理软件在系统网络层拦截了本地连接，请尝试：

1. **完全退出代理软件**（不仅是关闭系统代理设置，需要退出代理软件进程本身）
2. 或在代理软件中将 `127.0.0.1` 和 `localhost` 添加到直连/绕过列表
3. 或手动执行：

```powershell
# PowerShell
$env:HTTPS_PROXY=""; $env:HTTP_PROXY=""; $env:ALL_PROXY=""; node dev.js
```

### Dashboard 提示「此项目的绑定在通过 wrangler.toml 进行管理」，无法手动绑定 KV

这是 **`wrangler.toml` 文件存在于仓库中**导致的，与里面有没有 KV 块无关。Cloudflare 官方文档（Pages · Configuration）明确：Pages 项目里只要有 `wrangler.toml`，它就被视为项目配置的 **source of truth（真源）**，Dashboard 的对应字段变为只读（只能看、不能改）。

**先分清你属于哪种情况：**

- **情况 A（有意为之）**：如果你是按「方式一」部署、主动把 `wrangler.toml.example` 重命名成了 `wrangler.toml`——那么 Dashboard 只读是**预期行为**，绑定由文件管理，修改配置请编辑 `wrangler.toml` 再 `git push`，无需在 Dashboard 操作。这是正常的，不用纠结。
- **情况 B（本想用 Dashboard 却误带文件）**：如果你打算用「方式二（Dashboard 手动绑定）」，但连上仓库后却看到这个提示，说明仓库里**存在 `wrangler.toml`**（可能你误把 `wrangler.toml.example` 改完名提交了，或之前遗留）。此时需要移除它来恢复 Dashboard 可编辑。

**仓库默认状态**：本仓库**故意不提交激活的 `wrangler.toml`**，只附带 `wrangler.toml.example` 模板（不会被 Cloudflare 读取、也不会锁 Dashboard），并把 `wrangler.toml` 加入 `.gitignore` 防止误提交。

官方原文：
> *"If you decide that you don't want to use wrangler.toml for configuration, you can safely delete it and create a new deployment. Configuration values from your last deployment will still apply and you will be able to edit them from the dashboard."*

**如果你属于情况 B，恢复 Dashboard 可编辑的操作步骤**：

1. 确保仓库根目录**没有**激活的 `wrangler.toml`（仅保留 `wrangler.toml.example` 模板即可）。
2. 推送改动触发重新部署（或手动 **Deployments → Redeploy**）。
3. 部署完成后进入 **Settings → Functions → KV namespace bindings**（或 **Settings → Bindings**），此时界面应已可编辑。
4. **Add binding**：变量名 `SUBCONVERT_KV`，选择你的命名空间，再 **Redeploy** 一次生效。✅

> 之后每次 `git push` 都会自动沿用这个 Dashboard 绑定（绑定存于项目级，跨部署持久），因为仓库里已无 `wrangler.toml`，Cloudflare 不会再把它锁成只读。

**本地开发不需要 `wrangler.toml`**：`npm run dev`（`dev.js`）会以命令行参数 `wrangler pages dev public --kv SUBCONVERT_KV` 启动，目录与 KV 绑定都通过 CLI 传入，不依赖 `wrangler.toml`。若你本地想自建一个 `wrangler.toml` 用于其他调试，注意它已被 `.gitignore` 忽略、不会进仓库。

### wrangler 4 不支持 `[...path].js` 路由

wrangler 4 不支持 splat 路由参数（`...`），参数名只能包含字母数字和下划线。本项目使用 `[path].js` 单段路由，完全满足自定义路径需求。

### 部分订阅源返回 403 Forbidden

可能原因及解决方案：

1. **User-Agent 不被识别** — 默认使用 `clash-verge/v2.5.1`，大多数订阅源支持。如需修改默认 UA，可编辑 `functions/_lib/convert.js` 中的 `DEFAULT_UA` 常量。

2. **订阅源启用了 Cloudflare 防护（Under Attack 模式）** — 如果错误信息中包含 `Just a moment...`，说明订阅源网站本身也托管在 Cloudflare 上并开启了 JS 挑战。由于本服务运行在 Cloudflare 边缘网络上，Cloudflare-to-Cloudflare 的请求会触发挑战页，Worker 无法执行 JavaScript 也就无法通过挑战。这是 Cloudflare 平台层面的限制，无法从代码层面解决。建议联系订阅源提供商获取不经过 Cloudflare 挑战的订阅域名。

## License

MIT
