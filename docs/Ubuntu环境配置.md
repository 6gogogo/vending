# Ubuntu 环境配置

本文用于把当前项目迁移到 Ubuntu 机器后，快速完成依赖安装、环境变量配置、测试数据初始化与运行。

## 1. 能否在 Ubuntu 上运行

可以，但要区分模块：

- `apps/api`：可以正常运行
- `apps/admin-web`：可以正常运行
- `apps/mobile`：
  - `H5` 预览、`mp-weixin` / `mp-alipay` 构建可以在 Ubuntu 上通过命令行完成
  - 最终微信开发者工具、支付宝开发者工具、原生 App 云打包是否放在 Ubuntu 机器上执行，要看你本机工具链是否可用；项目本身不依赖 Windows 才能编译 API 和后台

当前项目更适合在 Ubuntu 上承担：

- 后端服务
- PC 后台构建与部署
- 移动端命令行构建

## 2. 推荐环境版本

- Ubuntu：`22.04 LTS` 或 `24.04 LTS`
- Node.js：`22 LTS` 或 `24`
- npm：`10+`
- Git：最新版稳定版即可

## 3. 系统依赖安装

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential
```

建议用 `nvm` 管理 Node：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node -v
npm -v
```

## 4. 获取项目代码

```bash
git clone <你的仓库地址>
cd vending-machine
npm install
```

如果仓库目录名不是 `vending-machine`，把上面最后一行改成你的实际目录。

## 5. 配置后端环境变量

复制后端模板：

```bash
cp apps/api/.env.example apps/api/.env
```

至少确认这些配置：

```env
PORT=4000
API_DATA_FILE=runtime-data/store.json
UPLOAD_DIR=runtime-uploads
BUSINESS_TIMEZONE_OFFSET_HOURS=8
BUSINESS_DAY_START_HOUR=4
PUBLIC_BASE_URL=http://127.0.0.1:4000

AMAP_WEB_KEY=
AMAP_SECURITY_JS_CODE=

SMARTVM_BASE_URL=
SMARTVM_CLIENT_ID=
SMARTVM_KEY=
SMARTVM_TEST_DEVICE_CODE=91120149
SMARTVM_TEST_DOOR_NUM=1

ALIYUN_SMS_ACCESS_KEY_ID=
ALIYUN_SMS_ACCESS_KEY_SECRET=
ALIYUN_SMS_REGION_ID=cn-hangzhou
ALIYUN_SMS_ENDPOINT=dysmsapi.aliyuncs.com
```

说明：

- `PUBLIC_BASE_URL`：后端对外访问地址，后续如果部署到公网或局域网，要改成真实地址
- `AMAP_WEB_KEY`：PC 端地图选点必需
- `AMAP_SECURITY_JS_CODE`：高德 JS API 新 Key 常用的安全密钥
- `SMARTVM_*`：真实柜机平台联调必需
- `ALIYUN_SMS_*`：真实短信验证码必需

## 6. 目录写权限要求

后端运行时必须能写入这两个目录：

- `apps/api/runtime-data`
- `apps/api/runtime-uploads`

如果你自定义了 `API_DATA_FILE` 或 `UPLOAD_DIR`，对应目录也必须可写。

可以先手工创建：

```bash
mkdir -p apps/api/runtime-data
mkdir -p apps/api/runtime-uploads
```

## 7. 初始化测试数据

需要把后端恢复成默认测试数据时，运行：

```bash
npm run init:api-data
```

默认持久化文件会写到：

```text
apps/api/runtime-data/store.json
```

## 8. 启动后端

开发模式：

```bash
npm run dev:api
```

单次启动：

```bash
npm run dev:api:once
```

如果 `4000` 端口已被占用，可以临时改端口：

```bash
PORT=4001 npm run dev:api:once
```

## 9. 启动 PC 后台

开发模式：

```bash
npm run dev:admin
```

构建：

```bash
npm run build --workspace @vm/admin-web
```

如果后端不在本机，需要配置：

```env
VITE_API_BASE_URL=http://你的后端地址:4000/api
```

建议把它写到：

```text
apps/admin-web/.env.local
```

## 10. 移动端命令

H5 预览：

```bash
npm run dev:mobile
```

微信小程序构建：

```bash
npm run build:mobile:weixin
```

支付宝小程序构建：

```bash
npm run build:mobile:alipay
```

App 资源构建：

```bash
npm run build:mobile:app
```

如果移动端要访问 Ubuntu 上的后端，设置：

```env
VITE_API_BASE_URL=http://你的Ubuntu机器IP:4000/api
```

位置建议：

```text
apps/mobile/.env.local
```

## 11. 反向代理与公网部署建议

如果后续要接真实柜机平台，建议把后端放到固定域名或固定公网 IP 后面，不要直接长期暴露开发端口。

常见做法：

- `Nginx` 反向代理到 `127.0.0.1:4000`
- 对外开放 `80/443`
- 柜机平台回调统一指向你的域名

回调路径保持：

- `/api/cabinet-events/callbacks/door-status`
- `/api/cabinet-events/callbacks/settlement`
- `/api/cabinet-events/callbacks/adjustment`
- `/api/inventory-orders/callbacks/refund`

## 12. 生产前最低检查

- 后端 `.env` 已填完整
- `npm run init:api-data` 已按需执行
- API 数据目录与上传目录可写
- `npm run dev:api:once` 或正式进程可正常启动
- `npm run build --workspace @vm/admin-web` 通过
- 地图选点可正常搜索并保存
- 若要短信验证码，`ALIYUN_SMS_*` 已配置
- 若要真实柜机联调，`SMARTVM_*` 与平台回调地址已配置
