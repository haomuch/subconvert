# SubConvert - 代理订阅转换

自托管的代理节点订阅转换工具，部署在 Cloudflare Pages 上。转换逻辑全部在 Cloudflare 边缘节点本地执行，**不依赖任何第三方转换服务**，订阅数据不会外泄。

## 功能特性

- 🔒 转换在边缘节点本地完成，订阅数据零第三方接触
- 📦 多格式互转：Clash / Mihomo、Sing-Box、V2Ray Base64、纯文本
- 🌐 全协议覆盖：SS、VMess、VLESS、Trojan、Hysteria2、TUIC、AnyTLS
- 🔗 自定义输出路径（`/sub/my-sub`），便于识别和管理
- 📋 首页链接管理：查看、复制、预览、删除、访问统计
- ⚡ 结果在边缘缓存 5 分钟，避免慢源拖垮回源
- 🚀 基于 Cloudflare Pages + KV，零构建、零服务器成本

## 支持的格式

**输入**（自动检测格式）：Base64（V2Ray）、Clash / Mihomo YAML、Sing-Box JSON、纯文本 URI 列表。

**输出**：

| 格式 | 说明 |
| ------ | ------------------------------------ |
| `clash` | Clash / Mihomo YAML（含 proxy-groups 和 rules） |
| `singbox` | Sing-Box JSON（含 route 和 dns） |
| `base64` | V2Ray Base64 编码的 URI 列表 |
| `plain` | 纯文本 URI 列表 |

## 使用方法

1. 打开网站首页
2. 填写源订阅 URL，选择目标格式
3. （可选）填写自定义路径作为链接标识，留空则自动生成
4. 点击「生成转换链接」，将生成的订阅链接导入代理客户端即可

转换链接（`/sub/:path`）可直接访问、公开免密，供客户端订阅更新；首页的管理操作按下方「访问密码保护」配置。

## 部署

### 前置要求

- 一个 Cloudflare 账号
- （仅本地开发需要）Node.js 18+

项目零构建依赖（js-yaml 已内联），在 Pages 的构建设置中选择 Framework preset 为 `None`、Build command 留空、Build output directory 为 `public` 即可。

**KV 绑定是必须的**，绑定变量名固定为 `SUBCONVERT_KV`。两种绑定方式**任选其一、不要混用**：

## 方式一：文件化配置（推荐）

1. 在 Dashboard 左侧 **KV** → **Create a namespace** 创建一个命名空间，记下生成的 ID。
2. 将根目录的 `wrangler.toml.example` 复制为 `wrangler.toml`，把 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 替换为上面的 KV ID。
3. 按上述构建设置通过 GitHub 导入项目并部署即可。

> 注意：仓库中一旦存在 `wrangler.toml`，它就会被 Cloudflare 视为配置真源，Dashboard 的绑定界面变为只读（属预期行为）。之后改配置只需编辑该文件再 `git push`。该文件已被 `.gitignore` 忽略，不会泄露 KV ID。

## 方式二：Dashboard 手动绑定

不提交 `wrangler.toml`，直接部署。然后在项目 **Settings → Functions → KV namespace bindings** 添加 binding：变量名 `SUBCONVERT_KV`，选择你的命名空间，最后 **Redeploy** 一次使绑定生效。

### 本地开发

```bash
npm install
npm run dev
```

访问 `http://localhost:8788`。`npm run dev`（`dev.js`）会清除干扰 wrangler 的代理环境变量，并通过 CLI 参数绑定本地 KV 实例，**无需创建线上 KV、也不依赖 `wrangler.toml`**。若你使用代理软件后页面空白，多为系统代理拦截了本地请求，请将 `127.0.0.1`、`localhost` 加入直连列表或退出代理软件。

## 访问密码保护（可选）

在 Cloudflare Dashboard 的项目 **Settings → Environment variables** 中添加变量 `ACCESS_PASSWORD` 并重新部署即可。

- 未设置时，首页公开访问。
- 密码仅保护首页及管理接口；已生成的 `/sub/:path` 链接始终免密公开，便于客户端订阅。
- 本地开发可在根目录创建 `.dev.vars` 写入 `ACCESS_PASSWORD`。

## 项目结构

```text
functions/
├── _lib/                    # 共享库（下划线前缀不作为路由）
│   ├── uri-parse.js         # 协议 URI 解析
│   ├── uri-generate.js      # 协议 URI 生成
│   ├── sub-parse.js         # 订阅解析（自动检测格式）
│   ├── sub-generate.js      # 订阅生成
│   ├── convert.js           # 转换管道（抓取源订阅 → 转换 → 输出）
│   ├── store.js             # KV 存储
│   ├── cache.js             # 边缘缓存 key
│   ├── auth.js              # 访问密码校验
│   ├── response.js          # HTTP 响应辅助
│   └── vendor/js-yaml.mjs   # 内联 js-yaml（无需 npm install）
├── api/
│   ├── auth.js              # GET/POST /api/auth — 鉴权状态与密码校验
│   ├── convert.js           # POST /api/convert — 创建转换链接
│   └── links.js             # GET/DELETE /api/links — 管理链接
└── sub/
    └── [path].js            # GET /sub/:path — 订阅输出端点
public/                      # 静态前端（index.html / style.css / app.js）
wrangler.toml.example        # 配置模板（复制为 wrangler.toml 并填入 KV ID）
```

## 常见问题

**修改源订阅后客户端仍是旧内容**：转换结果在边缘缓存 5 分钟，源变更最长 5 分钟后生效；删除链接会清除当前边缘节点缓存。想立即生效可换一个新路径重新生成。

**部分订阅源返回 403**：默认 UA 为 `clash-verge/v2.5.1`，可修改 `functions/_lib/convert.js` 中的 `DEFAULT_UA`；若报错含 `Just a moment...`，说明源站开了 Cloudflare 挑战，同网络（Cloudflare 到 Cloudflare）请求无法通过，需联系源站换无挑战域名。

**wrangler 4 路由提示**：不支持 `[...path].js` splat 语法，本项目使用 `[path].js` 单段路由。

## License

MIT
