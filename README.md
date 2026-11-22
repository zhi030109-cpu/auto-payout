# Auto-Payout — 干净版自动打款框架

监听 BSC 上某个代币铸造合约，铸造者预登记后，铸满指定份数即自动用热钱包转 USDT 到其收款地址。代码量不大，全部逻辑透明。**一个服务可以同时盯多个项目**（Agent ID $AI、BIBI 已验证可并行），结算价可以随铸造进度动态调整，底池状态和预计可用时间实时可见。

这是对 [conclude-dating-tree-downtown.trycloudflare.com](https://conclude-dating-tree-downtown.trycloudflare.com/)（已换新地址）那套“AgentID 自助预登记与 USDT 自动结算”的干净重写：**不带它那套“防抢登记”话术、不收认领解锁费、不造假打款记录、不走匿名隧道域名**。

## 已验证的事实（2026-11-23 实测）

### Agent ID $AI（已停）

- 默认目标：Agent ID `$AI` 铸造合约 `0xa4bFa31f615F8e2a13dce3d93C0996CC5a56763D`。
- 铸造事件已从真实交易反推出来（官网当时已打不开，BscScan API 要 key，公共 RPC 的 `eth_getLogs` 被限流，最后用 `eth_getBlockReceipts` 逐块扫出来的）：
  - 汇总事件 topic0：`0x6002eca610a8cf3698284c97c6ded788f652ebd60c7aaaa4a00d68f538ae73d0`（事件名未公布，按哈希识别）
  - `topics[1]` = 铸造者，`topics[3]` = 推荐人，`data[1]` = 份数，`data[0]` = 铸前 totalMinted，`data[3]` = 推荐返佣（BNB）
  - 依据：交易 `0x9766d69a…be9c9`（区块 135110404，10 份，0.08 BNB，返佣 0.012 BNB）和 `0x613fe22f…ff45a`（区块 135110503，9 份，0.07488 BNB，返佣 0.0108 BNB）
- 返佣公式（实测）：**返佣 = 份数 × 基础档位价 × 推荐比例**。档位价在 totalMinted 约 259,700 时是 **0.008 BNB/份**，推荐比例 15% 时 10 份返 0.012 BNB（约 $6.70，BNB $558 时）。付 5.45 USDT 后毛利约 $1.25/笔（未扣 gas 和资金成本）。**这比之前估算的 -0.5~+0.35 要好**，因为之前用的档位价（0.006–0.007）估低了——以实测为准。
- **注意：这个盘的铸造目前已停**。`totalMinted()` 在 2026-11-23 01:04–01:40 间一直是 259,820，官网 agentIdai.meme 也解析不到。框架是通用的，上线前先确认目标铸造还在进行；换盘只需改 `MINT_CONTRACT` 和事件配置。

### BIBI（进行中，同一运营方的新项目）

- 新站 `gardening-plenty-apps-deluxe.trycloudflare.com`（旧站已打不开），标题“BIBI 预登记与 USDT 自动结算”，客服仍是 Telegram @Avalonsol、𝕏 @AvalonBtc——同一运营方换了项目。
- 链上核实（2026-11-23 02:10–02:15）：代币 BIBI `0x6fC563428B3D6CdD151cB57f0CA5859615C02260`（name/symbol 均为 bibi，18 位，总量约 9536 亿）；铸造合约 BibiSale `0x3ee0570567625D90a5DEE11290F159D4AaCD29C6`；交易对 bibi/WBNB `0x63b6a0f72fDA65684Db2aD6e60968c0ab0b22391`，流动性约 $37.7K，24h 量约 $164.8K（2,220 买 / 1,989 卖）。铸造合约与 Agent ID $AI **同一套模板**：`totalMinted()` 13,255、`basePrice()` 0.002 BNB、`opened()` = 1，事件 topic0 与字段布局完全相同。
- 真实铸造交易 `0x21d648f4…b78af`（区块 135124545）：10 份，成本 0.028 BNB，**返佣 0.0014 BNB**（data[3]），即推荐比例 **5%**（档位价 0.0028 BNB/份 × 5%）。按 BNB $557 计返佣约 $0.78/笔。铸造者 0x5259c1b8…用的正是新站指定的推荐人 0xdB876cD9450f6407c93E3E7200edf2eA58C87521。
- 新站的动态结算价：02:04 是 0.40U/个，02:08 已涨到 0.75U/个，页面称“随项目铸造进度自动上调”，池 <20 BNB 时切稳健价 0.70U。**但按实测返佣 $0.78 算，0.75U 的打款已超过守卫上限（0.78 × 0.9 = $0.70），框架会拒绝支付**——要么把结算价降到 0.70 以下，要么主动把 GUARD_FACTOR 调低（等于承认亏钱运营）。02:04 那笔唯一打款记录是 0.40 USDT（已发，未在 BscScan 核实，页面只显示截断哈希）。
- 铸造进行中：02:15 左右 120 个块内抓到 5 笔铸造，之后一轮 50 块又抓到 8 笔；totalMinted 从 13,255 涨到 13,625（约 40 分钟），底池约 35.9 BNB。网站称“官网已关闭，但底池仍有 BNB”“PancakeV2 LP 已锁死”，状态栏“链上正常 · 可继续铸造”。

## 多项目

`PROJECTS_JSON`（`.env`，一行 JSON 数组）里配多个项目，服务同时监听全部。每个项目独立：铸造合约、事件、推荐人、档位价、推荐比例、结算价、每日上限、登记与打款记录。`.env.example` 里有 Agent ID $AI + BIBI 的完整示例（数值均为 2026-11-23 实测）。

不配 `PROJECTS_JSON` 时退回单项目模式，用 `MINT_CONTRACT` 等旧变量（默认 Agent ID $AI）。

## 动态结算价

每个项目的 `pricing` 可以是：

- `fixed`：固定价，如 `{"mode":"fixed","baseUsdt":"5.45"}`。
- `dynamic`：基础价 + 按 totalMinted 分档上调 + 底池低于阈值时切稳健价，如 BIBI 的 `{"mode":"dynamic","baseUsdt":"0.40","tiers":[[13000,"0.75"]],"poolFloorBnb":20,"poolFloorUsdt":"0.70"}`。

当前实时价（链上 totalMinted 与底池算出来的）见 `GET /api/quote?project=<id>`，页面上也实时显示。**经济守卫始终兜底**：不管定价怎么配，打款超过预期返佣 × 0.9 就拒绝。

## 底池状态与预计可用时间

每个项目每轮都会读交易对的 WBNB 储备（即底池 BNB）和 totalMinted，`GET /api/status` 返回各项目的底池 BNB、已铸份数和**预计可用时间**（按最近底池消耗速度，算到底池剩 5 BNB 的时间；底池不消耗或样本不足时为空）。页面规则卡片里同样显示。

## 结构

```
src/
  config.js    环境变量配置（.env），不含任何密钥默认值
  db.js        JSON 文件存储：登记、打款记录、扫描进度（原子写）
  chain.js     RPC 访问、事件解码、三种扫描方式
  payout.js    USDT 转出、经济模型守卫（economics guard）
  server.js    HTTP API（Node 内置 http，无框架依赖）
  listener.js  轮询监听、匹配登记、触发打款
  index.js     入口：启动 API + 监听
scripts/
  scan.js      发现工具：从真实铸造交易/区块里识别 Mint 事件
data/          运行数据（登记、打款、进度），不进 git
```

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，至少填：
#   HOT_WALLET_PRIVATE_KEY=0x...   （只通过环境变量，绝不写进文件）
#   OPERATOR_REFERRER=0x...       （你自己的推荐人地址；只给走你推荐链接的铸造打款）
#   TIER_PRICE_BNB=0.008          （当前基础档位价，铸造恢复后要重核）
npm install
npm start          # 默认 DRY_RUN=true：只记日志，不发任何交易
```

确认干跑日志无误后，改 `DRY_RUN=false` 再重启，才会真正打款。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/preregister` | `{ project, minter, recipient, signature? }` 登记 24h 有效；带 minter 签名即为“已验证”锁定 |
| POST | `/api/preregister/claim` | 凭 minter 签名覆盖/认领已有登记（免费的密码学证明，替代原站“转 0.000001 BNB 解锁”那套） |
| GET | `/api/payouts?project=&recipient=` | **只返回真实打款记录**（带链上 txHash，可在 BscScan 核对） |
| GET | `/api/quote?project=&shares=` | 实时结算价 + 底池 BNB + 已铸份数 + 预期返佣 + 守卫是否通过 |
| GET | `/api/status` | 运行状态：干跑与否、已扫区块、热钱包地址与 USDT 余额、各项目底池与预计可用时间 |
| GET | `/api/config` | 公开条款：各项目的每单打款额、所需份数、登记有效期 |

签名消息格式：`Register auto-payout: minter <minter> pays out to <recipient> (BSC USDT).` 用铸造钱包 `personal_sign` 签，服务端用 `ethers.verifyMessage` 验签。

## 打款规则（按顺序检查，任一不通过即跳过并记日志）

1. 该笔铸造的份数 ≥ `REQUIRED_SHARES`（默认 10）
2. 铸造者有未过期、未兑付的有效登记（**按项目**）
3. 推荐人是 `OPERATOR_REFERRER`（若设置了；没走你链接的铸造你拿不到返佣，当然不付）
4. 当日累计打款 + 本笔 ≤ `MAX_PAYOUT_USDT_PER_DAY`（默认 500，**按项目**）
5. **经济守卫**：打款额 ≤ 预期返佣 × `GUARD_FACTOR`（默认 0.9）。打款额按项目定价算（固定价或动态价）。预期返佣 = 份数 × `TIER_PRICE_BNB` × BNB 现价 × `REFERRAL_BPS`。算不出来（没配档位价或拿不到 BNB 价）时拒绝打款
6. 热钱包 USDT 余额足够
7. 一笔铸造只付一次（按 txHash 幂等）；一个登记只兑付一次

通过检查的打款先进队列：`BATCH_WINDOW_SECONDS` = 0 时立刻发出，> 0 时按窗口批量发出（原站“自动合并批量打款”的同款做法）。

## 扫描方式（`LOG_MODE`）

- `receipts`（默认）：每块一次 `eth_getBlockReceipts`，免费公共 RPC 也能用，还能抓到经钱包 executor 中转的铸造
- `blockscan`：只看直接发到铸造合约的交易（中转的抓不到）
- `getlogs`：`eth_getLogs`，需要不限制日志查询的 RPC（付费/自有节点）

另有 `totalMinted()` 看门狗：链上已铸数涨了但本轮没抓到铸造时打警告。

## 前端页面

`npm start` 后打开 `http://127.0.0.1:3000/` 就是一个可直接用的页面（`public/index.html`，无外部依赖）：
规则卡片（从 `/api/config` 与 `/api/status` 实时读）、预登记表单、可选的钱包签名验证、真实打款记录表（只显示链上已打款的记录）。

## 部署成公开服务（变成“上面那个网站”那样）

框架本身就是后端 + 页面的完整程序，缺的只是**一台 7×24 小时在线、能从公网访问的服务器**。这台开发机不行（没有公网地址，重启就丢）。需要的四件东西：

1. **服务器**：一台小 VPS（约 $5/月）或 Railway / Render / Fly.io 的免费套餐。把整个 `auto-payout` 目录传上去，装 Node 22+，用 `pm2` 或 `systemd` 保持 `npm start` 常驻、崩溃自动重启。
2. **域名 + HTTPS**：买个域名指到服务器，Caddy 或 Nginx + Let's Encrypt 自动出证书。原站用的是临时隧道域名（trycloudflare），不建议学——域名一换用户就找不到了。
3. **热钱包与配置**：往热钱包充 USDT + 少量 BNB 做 gas；`.env` 里填 `HOT_WALLET_PRIVATE_KEY`、你自己的推荐人地址 `OPERATOR_REFERRER`、核对过的 `TIER_PRICE_BNB`，确认干跑无误后改 `DRY_RUN=false`。
4. **引流**：把你的铸造链接（带你的推荐人）发出去。用户必须**用你的推荐人地址铸造**，返佣才到你账上，框架也只给这类铸造打款。

如果你有 VPS 或 Railway 账号，我可以直接帮你部署上去；没有的话，先在本地把干跑跑顺，等目标铸造恢复了再上服务器也不迟。

```bash
# 已知一笔铸造交易哈希：
npm run scan -- --tx 0x...
# 扫一段铸造活跃期的区块（收据模式，含中转铸造）：
npm run scan -- --from 135110400 --to 135110600 --receipts
# 扫最近 N 块：
npm run scan -- --blocks 200 --receipts
```

输出会给出 topic0、铸造者/推荐人所在的 topic、份数所在的 data 位置，照着填进 `.env` 即可。

## 安全与运营注意事项

- **私钥只放环境变量**，不要写进 `.env` 之外的任何文件、不要提交到 git。`.env` 已在 `.gitignore` 里。
- **先干跑**：`DRY_RUN=true` 跑一段时间，确认监听抓到的铸造、守卫的通过/拦截都符合预期，再开真钱。
- **热钱包只放够用的 USDT + 少量 BNB 做 gas**，不要把全部资金放热钱包；设好 `MAX_PAYOUT_USDT_PER_DAY`。
- **档位价会变**：`TIER_PRICE_BNB` 是基础档位价，随 totalMinted 上涨。守卫用旧价只会低估返佣（偏向拦截，安全方向），但长期运营要定期更新。
- **信任来自可验证**：公开热钱包地址和 `/api/payouts` 的真实记录（每笔带 BscScan 可查的 txHash），不要编造任何“已打款”数据。
- **BSC 的 USDT 是 18 位小数**（和以太坊的 6 位不同），代码里已按 18 位处理；换其他代币时改 `PAYOUT_TOKEN_DECIMALS`。

## 刻意没做的事

- 没有“最新打款订单”造假：`/api/payouts` 只读真实记录，空就是空
- 没有“防抢登记”倒计时、没有认领解锁费：登记冲突用免费签名解决
- 没有匿名域名、没有隐藏运营方：README 即运营手册
- 没有自动拉新、没有返佣分层推销：只做“登记—监听—打款”这一件事

## 测试记录（2026-11-23）

### Agent ID $AI

- 应用启动 + API（status/config/preregister）实测通过
- 合成事件端到端（干跑）：5 份跳过、10 份守卫通过并记录干跑打款、同一 tx 重放不重复
- 守卫拦截：档位价 0.007 时预期返佣 $5.86，打款 5.45 超过 5.86×0.9，拒绝
- **真实铸造交易回放**（tx `0x9766d69a…be9c9`）：推荐人过滤生效（非运营推荐人跳过）；无过滤时守卫通过（预期 $6.69），干跑打款 5.45 USDT 已记录

### BIBI（多项目 + 动态定价升级后）

- **真实铸造交易回放**（tx `0x21d648f4…b78af`，10 份，推荐人 = 运营方）：固定价 0.40 时守卫通过（预期返佣 $0.78），干跑打款 0.40 USDT 已记录；动态价（totalMinted ≥ 13,000 档 0.75）时守卫**拦截**（0.75 > 0.78×0.9），无打款记录——新站当前 0.75U 的定价在框架的默认守卫下是付不出去的
- 双项目启动实测：`/api/config` 返回 agentid + bibi；`/api/quote?project=bibi` 实时价 0.75、底池 36.37 BNB、预期返佣 $0.78、守卫不通过；`/api/quote?project=agentid` 5.45、守卫通过；`/api/status` 分项目返回底池与已铸数；监听一轮 50 块抓到 8 笔 BIBI 铸造（无登记，全部跳过，无错误）
- 前端页面带项目下拉选择，规则卡片显示所选项目的实时价、底池与预计可用时间
