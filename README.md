# AutoBitControl

Web3 自动签到任务系统：比特浏览器多窗口 + 拟人化 + yescaptcha 自动打码。

## 环境要求

- Windows 10/11，Node 20.x，比特浏览器（本机运行中）
- 比特浏览器 API 已开启（默认 http://127.0.0.1:54345，可在 config 修改）

## 安装

```powershell
npm install
npx patchright install chromium
Copy-Item config/.env.example config/.env
# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY
```

## 运行

```powershell
npm run dev
```

Web 面板：http://127.0.0.1:3000

## 开机自启（pm2）

```powershell
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示执行输出的命令
```

## 配置

三层配置：`config/config.json`（通用）→ `config/config.local.json`（本机覆盖）→ `config/.env`（密钥）。
钱包解锁密码在 SQLite `profiles` 表的 `wallet_password` 字段按窗口配置。

## 冒烟测试

```powershell
BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window
BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=petra npm run smoke:wallet
```

## 新增任务

在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts`），在 `src/tasks/index.ts` 的 ALL 数组注册。

## 测试

```powershell
npm test
```
