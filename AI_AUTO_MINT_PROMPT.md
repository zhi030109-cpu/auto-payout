# AI 自动代打提示词 — BIBI（仅此一盘）

> 用法：把下面整段复制给你的代打 AI（Muse / 其他 Agent）。它按顺序做三件事：先预登记 → BAW 提前预览秒打 → 卖出提前预览。每一步执行前都必须先给你看预览、等你亲口说“确认执行”才动手。
> 只适用于 BIBI，Agent ID $AI 已停铸、已从本站下线，不要拿这个提示词去打别的盘。

## 固定事实（不要改、不要猜）

- 网站：https://auto-payout.onrender.com ，项目只剩 **BIBI** 一个
- 结算价：**0.40 USDT / 10 份**，固定价；登记有效期 24 小时，一个登记只兑付一次
- 铸造合约 BibiSale：`0x3ee0570567625D90a5DEE11290F159D4AaCD29C6`
- 代币 BIBI：`0x6fC563428B3D6CdD151cB57f0CA5859615C02260`（18 位）——**这是代币合约，不是铸造合约，绝不往它打 BNB**
- 交易对 BIBI/WBNB：`0x63b6a0f72fDA65684Db2aD6e60968c0ab0b22391`
- Router（PancakeSwap V2）：`0x10ED43C718714eb63d5aA57B78B54704E256024E`
- WBNB：`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`
- 推荐人（operatorReferrer）：主钱包 `0xd6BfdAFDC17E6a84F0c468c215f5ed31B44F4910`，即 `caihongg.ai` 的 owner。铸造时推荐人必须填这个，否则返佣不到主钱包，自动打款不会付。
- 铸造钱包（BAW 主钱包）：`0xd6BfdAFDC17E6a84F0c468c215f5ed31B44F4910`
- 热钱包（只负责打款）：`0x2094F0e0fafa358CC5f31703E2f9EBB2Dcab8d96`
- 份数：每次 **10 份**，一笔铸满。当前档位价约 0.0028 BNB/份，10 份约 0.028 BNB——**每次打前必须链上重读 `totalMinted()` 与档位价重算，变了就按新价重报，不许沿用旧数**。
- 链：BNB Chain，chainId 56；BSC 的 USDT 是 18 位小数。

## 安全铁律（违反任何一条就停）

1. 只调上面列出的铸造合约和 Router，不调别的合约，不授权任何代币给不明地址。
2. 每次 `execute` 之前必须先 `preview`，把预览全文贴给用户，等用户亲口说“确认执行”才执行。没有确认，一律不执行。
3. 授权只批精确数量，不批无限授权。卖出授权 = 当时 BIBI 余额精确值。
4. 铸造款 = 份数 × 当前档位价，精确到 wei；多一 wei 少一 wei 都不打。
5. `preview` 报错 351803（风险拦截）就停；报错 351716（同地址有待确认单）就让用户先在 App 里处理前一单，不许绕过。
6. BAW 登录只用二维码模式，不用链接登录。每次动手前先跑 `baw wallet status`，没登录就停下来等用户扫码，不许自己编登录状态。
7. 任何一步失败，先查链上实际状态（回执、nonce、余额）再决定，不盲目重发。

---

## 第一步：先预登记（不登记不打款）

1. 打开 https://auto-payout.onrender.com ，确认下拉里只有 BIBI，规则卡片显示结算价 0.40 USDT / 10 份、推荐人是主钱包。
2. 查 `/api/quote?project=bibi&shares=10`，记下 `payoutUsdt`、`expectedRebateUsdt`、`guardOk`。`guardOk=false` 就停下来报原因，不许继续。
3. 在页面登记：铸造钱包 = 主钱包地址，收款地址 = 用户指定的收款地址（默认同主钱包）。可选：用铸造钱包 `personal_sign` 签名锁定登记，签名原文：`Register auto-payout: minter <小写铸造地址> pays out to <小写收款地址> (BSC USDT).`
4. 提交后确认返回 `ok:true` 与过期时间，过期前 24 小时内必须完成铸造，过期重登。

## 第二步：BAW 提前预览秒打（铸造）

**提前准备（开打前就做好，不要等开铸才拼）：**

1. 跑 `baw wallet status` 确认已登录，再跑 `baw wallet settings --json` 确认 Developer Mode 开启。两项缺一不可。
2. 链上重读 BibiSale 的 `totalMinted()`、档位价、底池 BNB，算出本次 10 份的精确成本（wei）和预期到手量。把“份数、单价、总价、推荐人、铸造合约”五项贴给用户确认。
3. 从官网 config / 前端 JS 里取 BIBI 的 mint 函数签名与参数（agentId、shares、minTokensOut、deadline），本地拼好 calldata。**不许手猜函数名与参数顺序，取不到就停下来问，不许编。** agentId = keccak256("caihongg")，不要带 `.ai` 后缀。
4. 跑预览（CLI 兜底路线，BIBI 是 Agent ID 模板盘、币安钱包私钥不在本地，直连签不了名）：
   `baw contract-call preview --binanceChainId 56 --from <主钱包地址> --to 0x3ee0570567625D90a5DEE11290F159D4AaCD29C6 --value <10 份总价 wei> --inputData <calldata> --json`
5. 把 preview 全文贴给用户：to、value、inputData 摘要、预估 gas。等用户说“确认执行”，再跑：
   `baw contract-call execute --requestId <preview 返回的 requestId> --json`
6. 执行后立刻查回执：`status` 必须是 1，核对链上 BIBI 到账数量与 `totalMinted` 涨了 10 份。回执失败或没到账，先查 nonce 与余额，不许直接重发同一笔。

## 第三步：卖出提前预览（铸完就卖，不攒）

1. 铸造回执确认后，读主钱包 BIBI 余额，记为本次可卖量。
2. 提前拼好卖出调用：Router 的 `swapExactTokensForETHSupportingFeeOnTransferTokens`，卖全部余额，`minOut=1`，路径 BIBI → WBNB，deadline 用当前块时间 + 300 秒。先在链下用池子储备估算预期到手 BNB，贴给用户（注明未扣滑点、税、gas）。
3. 先预览授权：`approve` Router 可花额度 = 精确余额。preview 给用户看，确认后 execute。
4. 再预览卖出：同样走 `baw contract-call preview`，把 to（Router）、value（0）、inputData 摘要、预期到手 BNB 贴给用户。等用户说“确认执行”，再 execute。
5. 查卖出回执 `status=1`，核对 BNB 到账。卖完才算这一笔结束，不要留尾巴币在钱包里等下一轮一起卖。
6. 最后报一句话：铸造 10 份花了多少 BNB、卖出回了多少 BNB、自动打款 0.40 USDT 会在登记有效、推荐人正确的前提下由监听器在约 10–20 秒内打到收款地址（到账以 `/api/payouts` 的真实记录与 BscScan tx 为准，不许编造已打款）。

---

## 出错就这样报（不要只说“失败了”）

- 哪一步、哪个命令、返回的原文错误码/信息、链上实际状态（totalMinted、余额、nonce、回执状态）
- 下一步建议：是等用户扫码、等用户确认、换 RPC 重读，还是停下来
- 绝不把预览没通过的交易说成“已提交”，绝不把干跑日志说成真实打款
