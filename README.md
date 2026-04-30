# 🚂 车票路径规划器 (Train Ticket Route Planner)

> 基于12306实时数据的多策略购票方案规划工具

## ✨ 核心功能

### 🔥 接入12306真实数据
- **实时余票查询** — 直连12306 API，查询真实车次和余票信息
- **列车时刻表** — 查看任意车次（如G2、D31）的完整停靠站时刻表
- **3365个车站** — 覆盖全国所有火车站
- **车次搜索** — 输入G2、D31等车次号直接查询时刻表

### 🧠 6种购票策略

| 策略 | 说明 | 自动化 |
|------|------|--------|
| 🚄 **直达（有票）** | 直接查询目标区间余票 | ✅ 自动查询 |
| ⏳ **直达（可候补）** | 无票车次可提交候补 | ✅ 自动识别 |
| 🎯 **买长乘短** | 买到更远站点，在目标站提前下车 | ✅ 自动查询更远站点余票 |
| 🔄 **中转换乘** | 经大型枢纽站换乘，分段展示可自由搭配 | ✅ 自动查询 + 智能兼容性筛选 |
| ✂️ **分段购票** | 分两段购买，增加成功率 | ✅ 自动查询分段方案 |
| 📝 **买短乘长** | 先买短途票上车再补票 | ✅ 自动查询可行方案 |

### 📊 排序与筛选

每个策略卡片均支持独立的排序和筛选：

**排序方式：**
- 🕐 出发时间（升序/降序）
- 🕕 到达时间（升序/降序）
- ⏱️ 耗时（升序/降序）
- 💰 预估价格（升序/降序）
- 🔄 换乘时间（仅换乘/分段策略）

**筛选条件：**
- 出发时间范围（如 08:00 ~ 12:00）
- 到达时间范围（如 14:00 ~ 18:00）
- 支持跨午夜筛选（如 22:00 ~ 06:00）
- 筛选框可选填，不填则不限制

### 💰 真实票价显示

直接从12306 API的 `yp_info`（票面信息）字段解析**真实票价**，而非估算：

- ✅ 有真实票价时显示 `¥553起`（无 ≈ 前缀）
- ⚠️ 无真实票价时回退到估算，显示 `≈¥553起`
- 鼠标悬停可查看所有可用席别的具体价格
- 覆盖所有席别：商务座、一等座、二等座、软卧、硬卧、硬座、无座

### 📋 其他特性
- 🔍 车站搜索（支持中文、拼音、电报码模糊搜索）
- 📊 余票统计（商务座/一等座/二等座/软卧/硬卧/硬座/无座）
- 📋 独立时刻表查询（输入G2等车次号查询）
- 🎯 买长乘短自动查询（弹窗展示可行方案）
- 📱 响应式设计，手机可用
- 🎨 暖色主题，视觉舒适

## 🚀 快速开始

### 方式一：在线访问（推荐 ⭐）

**无需安装任何东西，打开浏览器就能用！**

👉 **[点击访问在线版](https://www.bhllll.xyz)**

> 自定义域名 `www.bhllll.xyz` 已绑定 Vercel，国内可直接访问。

> 首次打开可能需要等待 10-30 秒（免费服务器冷启动），之后秒开。

### 方式二：下载可执行文件

**无需安装 Node.js，下载即用！**

1. 前往 [Releases](https://github.com/1311523821/train-planner/releases) 页面
2. 下载对应系统的文件：
   - **Windows 用户** → 下载 `train-planner-win-x64.exe`，双击运行
   - **Mac 用户 (Intel)** → 下载 `train-planner-macos-x64`
   - **Mac 用户 (M系列)** → 下载 `train-planner-macos-arm64`
   - **Linux 用户** → 下载 `train-planner-linux-x64`
3. 双击运行（Mac/Linux 需先 `chmod +x` 再 `./` 运行）
4. 浏览器会自动打开，开始使用！

### 方式三：一键启动脚本

如果已安装 Node.js：

```bash
# 克隆项目
git clone https://github.com/1311523821/train-planner.git
cd train-planner

# Windows 用户：双击 启动.bat
# Mac/Linux 用户：双击 启动.command
```

脚本会自动安装依赖、启动服务并打开浏览器。

### 方式四：命令行启动

```bash
git clone https://github.com/1311523821/train-planner.git
cd train-planner
npm install
npm start
# 访问 http://localhost:3000
```

## 🌐 部署到自己的服务器

### Vercel（推荐，免费）

1. Fork 本仓库到你的 GitHub
2. 访问 [vercel.com](https://vercel.com)，用 GitHub 登录
3. 点击 **New Project** → 导入你 fork 的仓库
4. 点击 **Deploy**，等待部署完成
5. 获得一个 `xxx.vercel.app` 的访问地址

或使用 Vercel CLI：
```bash
npm i -g vercel
vercel --prod
```

#### 绑定自定义域名（国内用户推荐）

`.vercel.app` 域名在国内可能无法访问，建议绑定自定义域名：

1. 在阿里云/腾讯云等购买域名
2. 添加 DNS CNAME 记录：`www` → `cname.vercel-dns.com`
3. 在 Vercel 项目 **Settings → Domains** 中添加域名
4. 选择 **Connect to an environment → Production**（不要选 307 重定向）
5. Vercel 会自动签发 SSL 证书

### Render（免费）

1. Fork 本仓库
2. 访问 [render.com](https://render.com)，用 GitHub 登录
3. **New** → **Web Service** → 选择你的仓库
4. 设置：
   - Build Command: `npm install`
   - Start Command: `node server.js`
5. 点击 **Create Web Service**

### 自有服务器

```bash
git clone https://github.com/1311523821/train-planner.git
cd train-planner
npm install
PORT=80 node server.js
```

## 📐 技术栈

- **前端**: 纯 HTML + CSS + JavaScript（零框架依赖）
- **后端**: Node.js + Express（12306 API代理）
- **数据源**: 12306 官方API
  - 车站数据: `/otn/resources/js/framework/station_name.js`
  - 余票查询: `/otn/leftTicket/queryG`
  - 列车时刻: `/otn/czxx/queryByTrainNo`
  - 换乘查询: 多段余票查询 + 时间匹配算法

## 📁 项目结构

```
train-planner/
├── server.js              # Express后端（12306 API代理 + 换乘算法）
├── public/
│   └── index.html         # 前端单页应用
├── vercel.json            # Vercel 部署配置
├── render.json            # Render 部署配置
├── 启动.bat               # Windows 一键启动
├── 启动.command           # Mac/Linux 一键启动
├── package.json
├── README.md
└── .gitignore
```

## 🔨 自行构建可执行文件

```bash
# 安装构建工具
npm install -g @yao-pkg/pkg

# 构建所有平台
npm run build

# 或单独构建某个平台
npm run build:win     # Windows
npm run build:mac     # macOS (M系列)
npm run build:linux   # Linux
```

构建产物在 `dist/` 目录下。

## 📝 API 接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/api/stations` | GET | - | 获取全国车站数据 |
| `/api/ticket` | GET | from, to, date | 查询余票 |
| `/api/transfer` | GET | from, to, date, transferStation?, date2? | 中转换乘查询（返回分段车次 + 兼容性映射） |
| `/api/schedule` | GET | trainNo, date, fromCode, toCode | 查询列车时刻表 |
| `/api/schedule-by-no` | GET | trainNo, date | 按车次号查询时刻表（如G2） |
| `/api/health` | GET | - | 健康检查 |

## 📝 数据说明

- 余票数据来自12306官网API，实时更新
- **票价数据**：从12306返回的 `yp_info`（票面信息）字段解析，为实际票价
- 本工具仅提供查询和策略建议，不进行实际购票
- "买长乘短"、"买短乘长"等策略需要在12306官网/APP完成购票

## 📄 License

MIT

## 📌 版本历史

### v1.3.2 (2026-04-30)

- **分段购票升级**：改为左右两列布局，左侧选第一段、右侧选第二段，与中转换乘体验一致
- **方案汇总**：左右各选一个车次后，底部显示总耗时、总花费、换乘间隔等完整信息
- **回到顶部按钮**：页面滚动后右下角出现浮动按钮，一键回到顶部
- **价格提示修复**：鼠标悬停价格时，提示框不再超出屏幕边界

### v1.3.1 (2026-04-30)

- **修复分段购票查询报错**
- **中转换乘改为左右两列交互布局**：左侧第一段、右侧第二段，点击自动筛选可衔接车次
- **恢复换乘排序筛选**

### v1.3.0 (2026-04-30)

- **中转换乘重构**：覆盖全天所有有票车次，不再遗漏凌晨和深夜时段
- **分段展示**：第一段和第二段分开显示，界面更清晰
- **点击交互**：点击第一段自动筛选可衔接的第二段

### v1.2.1 (2026-04-30)

- **修复安全漏洞**：车站搜索等输入框的 XSS 风险
- **修复多个崩溃场景**：异常数据、空值等情况下的页面报错

### v1.2.0 (2026-04-30)

- **修复换乘时间计算错误**：超过24小时的长途列车换乘时间显示异常
- **换乘车次扩容**：覆盖更多凌晨和深夜时段的可行方案

### v1.1.0 (2026-04-30)

- **真实票价**：从12306数据直接获取实际票价，不再靠估算
- **价格区分**：有真实票价显示 ¥，估算显示 ≈¥

### v1.0.0

- 初始版本
- 6种购票策略：直达、候补、买长乘短、中转换乘、分段购票、买短乘长
- 12306实时余票查询
- 列车时刻表查询
- 排序与筛选功能
- 响应式设计

