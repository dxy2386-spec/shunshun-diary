# 顺顺日记

一个手机优先的排便记录与肠道健康助手。它不是小程序，而是可以直接在手机浏览器里使用的 PWA 网页应用；界面和交互按小程序的手感设计，也可以“添加到主屏幕”当独立 App 使用。

## 已经实现的功能

- **账号系统**：邮箱注册、登录、退出，密码使用 scrypt 加盐哈希存储。
- **排便记录**：时间、Bristol 1–7 型、颜色、量、排便感受、备注；支持编辑和删除。
- **今日概览**：今日次数、最近 7 天柱状图、近 7 天次数、日均次数、连续记录天数。
- **趋势回看**：近 14 天柱状图、形态分布、累计记录、按天分组的记录明细，支持 7 天 / 30 天 / 全部筛选。
- **AI 小助手**：
  - 结合记录分析最近一周或今天的情况；
  - 针对便秘、腹泻、颜色异常、饮食搭配等问题给出日常建议；
  - 检测便血、黑便、灰白便、剧烈腹痛等警示信号并提示就医；
  - 没有配置 API Key 时，使用内置的本地健康规则分析，完全离线；
  - 配置 API Key 后，切换为真实大模型，并自动附带最近记录摘要。
- **数据管理**：CSV 导出、清空助手对话、删除账号与全部数据。
- **PWA**：可安装到手机主屏幕，支持离线打开已缓存的界面。
- **安全基础**：HttpOnly 会话 Cookie、SameSite、来源校验、登录限流、输入校验、CSP。

## 快速启动

需要 Node.js **24 或更高版本**（项目使用 Node 自带的 SQLite，不需要安装任何依赖）。

### Windows 最简单方式

双击 `启动顺顺日记.bat`，浏览器会自动打开：

```text
http://localhost:5173
```

### 命令行方式

```powershell
cd C:\Users\weixiaolong\codex-workspace\test-shit
npm start
```

启动后终端会打印两个地址：

- 本机：`http://localhost:5173`
- 手机：`http://你的局域网IP:5173`（手机和电脑连同一个 Wi-Fi）

局域网地址使用 HTTP，适合在家里的可信 Wi-Fi 下测试；不要把 5173 端口直接暴露到公网。公网使用请按下面的 HTTPS 部署方式。

体验账号：

```text
邮箱：demo@shunshun.app
密码：shunshun123
```

体验账号里预置了最近 12 天的示例记录，登录页有“用体验账号看看”按钮。

> 如果要公开部署，建议删除演示账号的种子数据，或至少修改演示账号密码，避免访客共用同一个账号。

## 让局域网里的其他人使用

1. 保持电脑上的服务运行，其他人的手机/电脑连接到同一个 Wi-Fi 或局域网。
2. 让对方打开 `http://你的局域网IP:5173`，例如当前这台电脑是 `http://192.168.31.206:5173`。
3. 对方点“注册”，创建自己的账号。每个人的记录按账号隔离，互相看不到。
4. 进入“我的 → 局域网共享”可以看到并复制当前地址。

如果其他设备打不开：

- 确认不是访客 Wi-Fi，且路由器没有开启“AP 隔离/客户端隔离”。
- 确认 Windows 防火墙允许 `node.exe` 或 TCP 端口 `5173` 入站。当前这台机器已有 Node 的 TCP 放行规则。
- 确认手机和电脑在同一个网段。电脑重新联网后 IP 可能变化，可以在路由器里给这台电脑做 DHCP 地址保留。
- 如果使用公司/学校网络，跨网段访问通常还需要网络管理员放行。

共享时仍建议只在家里的可信 Wi-Fi 下使用。应用目前是 HTTP，不要把 5173 端口直接映射到公网；需要公网访问时，使用带 HTTPS 的反向代理或 VPN。

## 启用真实 AI

默认不联网，使用内置规则分析。要接入真实大模型：

1. 复制 `.env.example` 为 `.env`。
2. 填入一个 OpenAI 兼容接口的 Key、地址和模型。
3. 重启服务。

DeepSeek 示例：

```env
AI_API_KEY=你的密钥
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
```

OpenAI 示例：

```env
AI_API_KEY=你的密钥
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

阿里云百炼 / Qwen 示例：

```env
AI_API_KEY=你的密钥
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen-plus
```

注意：启用真实 AI 后，聊天内容与**必要的记录摘要**会发送给你配置的模型服务商；账号昵称、邮箱和密码不会发送。界面里的“关于健康数据”也说明了这一点。

## 公开注册模式

如果要让拿到网址的人都能注册，建议用环境变量启动：

```env
PUBLIC_MODE=1
TRUST_PROXY=1
```

这会隐藏体验账号入口、关闭演示账号登录，并把注册限制为每个客户端 IP 每小时最多 8 次。`TRUST_PROXY=1` 用于 Cloudflare Tunnel 或反向代理后面读取 `CF-Connecting-IP` / `X-Forwarded-For` 和 HTTPS 协议；不要在直接暴露的局域网服务上随意开启，以免客户端伪造来源 IP。

也可以不依赖环境变量，直接运行：

```bash
node server.mjs --public --trust-proxy
```

公开访问必须使用 HTTPS。应用本身仍然使用邮箱密码登录，没有邮箱验证和找回密码；正式运营前建议补充邮件验证、隐私政策、内容审核和备份策略。

### 固定免费地址（Tailscale Funnel）

当前固定地址是：

```text
https://shunshun.tailf49132.ts.net
```

这个地址使用 Tailscale Funnel，不需要购买域名。Tailscale 客户端以 Windows 服务运行，Funnel 配置会保留；电脑重启后双击 `启动固定公网地址.bat` 启动本地 Node 服务，固定地址即可恢复。

如果 Node 服务已经启动，脚本会直接提示固定地址，不会重复占用 5173 端口。Tailscale Funnel 的配置可以用下面的命令查看：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel status
```

注意：固定地址仍然依赖这台电脑和本地 Node 服务；电脑关机或退出 Tailscale 时无法访问。Tailscale Funnel 的免费额度和使用条款以 Tailscale 当前政策为准。

### Render 免费部署（Neon PostgreSQL）

Render 免费 Web Service 的本地磁盘是临时的，不能直接使用 SQLite；同时免费 Web Service 15 分钟无访问会休眠。免费持久化方案是 **Render Web Service + Neon 免费 PostgreSQL**。

1. 在 Neon 创建一个免费 PostgreSQL 项目，复制连接字符串。
2. 在本地 `.env` 写入 `DATABASE_URL=...`，运行 `npm run migrate`，把当前 SQLite 里的账号、记录和对话迁移过去。迁移只接受空数据库；已有数据时会停止。
3. 把项目推送到 GitHub。
4. 在 Render 选择 **Web Services → New Web Service**，连接该仓库，选择 Free 实例，构建命令 `npm install --omit=dev --no-audit --no-fund`，启动命令 `node server.mjs --public --trust-proxy`。
5. 在 Render 环境变量里设置 `NODE_VERSION=24` 和 `DATABASE_URL`；健康检查路径填 `/api/health`。

也可以让 Render 读取仓库里的 `render.yaml` 蓝图，但 `DATABASE_URL` 会要求手动填写，不能提交到 Git。

部署成功后，Render 会提供固定的 `https://<服务名>.onrender.com` 地址，数据保存在 Neon 中，不再依赖这台电脑。免费实例第一次访问可能需要约 1 分钟冷启动。不要使用 Render 免费 Postgres：它会在 30 天后过期并删除数据库。

## 数据与备份

- 数据库文件：`data/shunshun.db`
- 删除 `data/shunshun.db` 会清空所有账号和记录，请先备份。
- 用户也可以在“我的 → 导出我的记录”里下载 CSV。
- 删除账号会级联删除该用户的记录、会话和聊天内容。
- 本地开发默认使用 `data/shunshun.db`；设置 `DATABASE_URL` 后切换到 PostgreSQL。
- Render 部署后，数据在 Neon 控制台查看和管理；应用本身仍然没有管理员后台页面。

## 部署到公网

这是普通 Node.js HTTP 服务，可以部署到任意支持 Node 24+ 的服务器：

```bash
PORT=5173 HOST=127.0.0.1 npm start
```

建议用 Caddy 或 Nginx 反向代理并启用 HTTPS。HTTPS 是手机“添加到主屏幕”、Service Worker 和安全 Cookie 正常工作的前提。例如 Caddy：

```caddyfile
shunshun.example.com {
    reverse_proxy 127.0.0.1:5173
}
```

如果使用 Nginx，记得转发 `X-Forwarded-Proto`，服务会据此设置 `Secure` Cookie。

## 为什么先做网页版

微信小程序需要企业/个人小程序 AppID、微信开发者工具，以及已备案且配置为合法域名的 HTTPS 后端；聊天类内容还涉及平台审核。网页版现在就能跑、能装到主屏幕，也能直接复用到小程序。

以后要做原生小程序时，当前后端可以直接复用：

- 把 `public/` 的界面改写成 WXML/WXSS；
- 用 `wx.request` 调用现有的 `/api/...` 接口；
- 把 Cookie 会话改为 `wx.login` + 服务端换取 openid，或者继续用邮箱登录；
- 在微信公众平台配置 HTTPS 合法域名。

## 项目结构

```text
server.mjs              Node HTTP 服务、认证、记录 API、AI 调用
db.mjs                  SQLite / PostgreSQL 数据库适配层
migrate-to-postgres.mjs SQLite → Neon PostgreSQL 数据迁移
render.yaml             Render Web Service 蓝图
public/
  index.html            页面结构
  styles.css            视觉与响应式布局
  app.js                前端路由、渲染和交互
  manifest.webmanifest  PWA 配置
  sw.js                 Service Worker
  icon.svg              应用图标
  icon-192.png          PWA 图标
  icon-512.png          PWA 图标
data/shunshun.db        SQLite 数据库（首次启动自动创建）
.env.example            AI 与服务配置示例
```

## 健康与安全说明

本应用用于日常自我观察和健康科普，**不能替代医生的诊断与治疗**。出现便血、黑便、灰白便、剧烈腹痛、发热、呕吐、体重明显下降，或便秘/腹泻持续两周以上，请尽快就医。

当前版本是 MVP，尚未包含邮箱验证、找回密码、多设备会话管理和内容审核。如果要公开运营，建议在上线前补齐这些能力，并请专业人士审阅健康建议文案。

本地 SQLite 数据库是明文文件，请限制服务器文件权限、做好备份，并避免把 `data/` 目录直接暴露到公网。迁移到 Neon 后由 PostgreSQL 服务保存数据，仍需保护好连接字符串。健康数据属于敏感信息，正式运营前还应补充隐私政策、数据保留期限和注销机制。
